# Process handles: what the customer has to build today

A Worker RPC stub does not own a Linux process. Something inside the container
must start the child, remember it, reap it, retain its exit status, and accept
later requests to inspect or stop it. This example makes that work visible.

```text
Worker request A                  Durable Object                  Linux container
startProcess()  ── Workers RPC ──> Sandbox ── HTTP /processes ──> Go supervisor
       <──── Process RPC stub ────┘                              map[id] → exec.Cmd
save the ID; request ends                                        sleep 60

Worker request B
getProcess(id) ── Workers RPC ──> fresh Process RPC target
process.status() ───────────────> Sandbox ── HTTP lookup(id) ──> same map, same child
```

The map in `container/main.go` is the point. The customer writes and ships a
process service, its protocol, synchronization, child reaping, and lookup logic.
`src/index.ts` wraps that service with a `RpcTarget`, so callers get the desired
`process.status()` / `process.stop()` interface.

This uses raw `ctx.container.start()` and `getTcpPort().fetch()`. It has no
`@cloudflare/sandbox` or `@cloudflare/containers` dependency. Workers RPC reaches
the DO; the container hop is a tiny HTTP/JSON protocol written by the customer,
not a native Cap'n Proto process capability.

## Try it

Use Node.js 22.18+ and a running Docker daemon:

```sh
npm install
cf dev
```

In another terminal, use the URL printed by `cf dev` (normally port 5173):

```sh
BASE=http://localhost:5173
# Request A: start a 60-second sleep and save its application ID.
ID=$(curl -fsS -X POST "$BASE/processes" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')

# Each curl below is a separate request, with a fresh RPC stub.
curl -fsS "$BASE/processes/$ID"
# {"exitCode":null,"pid":...,"running":true}
curl -fsS -X DELETE "$BASE/processes/$ID"
# {"signaled":true}
curl -fsS "$BASE/processes/$ID"
# Eventually: {"exitCode":-1,"pid":...,"running":false}
```

`stop()` requests a kill; `Wait()` updates the status asynchronously. Go reports
`-1` for a process killed by a signal. Without stopping it, sleep exits with `0`.

To deploy the example: `cf auth login`, then `cf deploy` (Workers Paid required).
The demo routes are public and start only the fixed `sleep 60` command.

## What survives

- **Request ends / RPC stub disposed:** the child and Go map remain. Save an ID
  and obtain a fresh stub in the next request; do not try to serialize the stub.
- **DO restarts, container remains:** the Go map still owns the child. The new
  DO can look it up without reconstructing a JavaScript `ExecProcess` handle.
- **Container or supervisor restarts:** this in-memory registry is lost. An ID
  does not make a process durable or resume it. Unknown IDs return an error.

To keep this illustration small, it runs one sandbox, retains completed entries
until the container stops, and omits output capture, process trees, sessions,
authentication, cleanup, and automatic retries of starts. Retrying POST can
start another child. A five-minute inactivity timeout keeps the container around
between demo requests; running children do not keep it alive indefinitely.

The proposed platform improvement would move this process ownership and lookup
into the runtime, so every customer would not need to build this server.

References: [raw container API](https://developers.cloudflare.com/containers/api/durable-object-container/),
[current background-process workaround](https://developers.cloudflare.com/sandbox/commands/run-background-processes/),
[sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/),
[RPC stub lifetime](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/).

## Verification

Typechecking, Go vet, Linux cross-compilation, and a local supervisor lifecycle
check passed. The lifecycle check exercised separate HTTP requests, two distinct
children, kill and reap, repeated stop, and loss of the registry on supervisor
restart, with Go's race detector enabled. Full `cf dev` verification was blocked
by this machine's Docker registry TLS trust error (`x509: certificate signed by
unknown authority`) while pulling the base images.
