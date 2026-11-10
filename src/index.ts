import { DurableObject, RpcTarget, env } from "cloudflare:workers";

type Status = { pid: number; running: boolean; exitCode: number | null };
type Call = <T>(path: string, method?: string) => Promise<T>;
const IDLE_MS = 5 * 60 * 1000;

// This is a live RPC capability, not the owner of the Linux process.
class Process extends RpcTarget {
	#id: string;
	#call: Call;
	constructor(id: string, call: Call) {
		super();
		this.#id = id;
		this.#call = call;
	}
	id() { return this.#id; }
	status() { return this.#call<Status>(`/processes/${this.#id}`); }
	stop() { return this.#call<{ signaled: boolean }>(`/processes/${this.#id}`, "DELETE"); }
}

export class Sandbox extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// A DO can restart while its container is still running.
		if (ctx.container?.running) {
			void ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(IDLE_MS));
		}
	}

	async startProcess() {
		const container = this.ctx.container!;
		if (!container.running) {
			container.start({ image: container.images.supervisor, enableInternet: false });
		}
		await container.setInactivityTimeout(IDLE_MS);
		// Wait for the customer-written server to listen before starting work.
		for (let attempt = 0; ; attempt++) {
			try { await this.#call("/health"); break; }
			catch (error) {
				if (attempt === 99) throw error;
				await scheduler.wait(100);
			}
		}
		const { id } = await this.#call<{ id: string }>("/processes", "POST");
		return this.getProcess(id);
	}

	getProcess(id: string) {
		if (!/^[A-Z2-7]{26}$/.test(id)) throw new Error("Invalid process ID");
		// No DO-side map of ExecProcess objects. Reconnect by application ID.
		return new Process(id, this.#call.bind(this));
	}

	async #call<T>(path: string, method = "GET"): Promise<T> {
		const container = this.ctx.container!;
		if (!container.running) throw new Error("Container stopped; its processes are gone");
		const response = await container.getTcpPort(8080).fetch(`http://supervisor${path}`, { method });
		if (!response.ok) throw new Error(`Supervisor ${response.status}: ${await response.text()}`);
		return response.json<T>();
	}
}

// HTTP only makes it easy to demonstrate separate Worker invocations with curl.
export default {
	async fetch(request: Request) {
		const sandbox = env.SANDBOX.getByName("demo");
		const path = new URL(request.url).pathname;
		if (request.method === "POST" && path === "/processes") {
			using process = await sandbox.startProcess();
			return Response.json({ id: await process.id() }, { status: 201 });
		}
		const match = /^\/processes\/([A-Z2-7]{26})$/.exec(path);
		if (match && (request.method === "GET" || request.method === "DELETE")) {
			// A fresh RPC stub, looking up the existing process inside the container.
			using process = await sandbox.getProcess(match[1]);
			return Response.json(await (request.method === "DELETE" ? process.stop() : process.status()));
		}
		return new Response("POST /processes; GET or DELETE /processes/:id\n", { status: 404 });
	},
} satisfies ExportedHandler;
