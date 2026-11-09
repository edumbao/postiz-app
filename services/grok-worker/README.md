# Grok worker (Phase 1, draft only)

Isolated from the Postiz apps. Environment names start with `GROK_WORKER_`.

The local Docker review path is `deploy/internal/LOCAL.md`. A host Node
install is not required for that path. The image runs
`node --experimental-strip-types` on Node `22.23.4`.

Mock and dry-run modes build a `type: "draft"` public API body and do not
send it. Live mode is fail-closed and cannot be combined with the local
preview. `GROK_WORKER_ALLOW_PUBLISH=true` is rejected. A live model call
reserves `GROK_WORKER_UNITS_PER_CALL` only on a cache miss. The same team,
prompt version, model, and brief do not call the model again.

From this directory, with pnpm:

```sh
pnpm test
pnpm typecheck
```
