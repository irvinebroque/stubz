import { bindings, defineConfig, defineContainer, defineWorker, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const container = defineContainer({
	name: "stubz-processes",
	schedulingPolicy: "durable-object",
	images: { supervisor: { dockerfile: "./Dockerfile" } },
});

const worker = defineWorker({
	name: "stubz",
	compatibilityDate: "2026-11-10",
	entrypoint,
	exports: { Sandbox: exports.durableObject({ storage: "sqlite", container }) },
});

export default defineConfig({
	containers: [container],
	worker: {
		...worker,
		env: {
			SANDBOX: bindings.durableObject({ worker, exportName: "Sandbox" }),
		},
	},
});
