# Internal Postiz stack and Phase 1 Grok worker

Local mock review, with no domain and no API key, is `LOCAL.md`.
Start it with:

```sh
docker compose -f deploy/internal/docker-compose.local.yml up -d --build
```

Then open `http://127.0.0.1:18081`. Stop it with `docker compose -f deploy/internal/docker-compose.local.yml stop`. That command does not delete volumes and does not stop other Docker projects.

This directory is a review-only deployment for one team's own brand accounts.
It is not a customer-facing SaaS and it does not replace the upstream
`docker-compose.yaml` or `docker-compose.dev.yaml`.

Postiz is licensed under AGPL-3.0. See `NOTICE` and the repository `LICENSE`.

The worker lives in `services/grok-worker`. Its environment names all start with
`GROK_WORKER_` so they do not collide with Postiz settings such as
`DATABASE_URL` or `OPENAI_API_KEY`.

This stack was not started. `docker compose up` was not run. Do not treat it
as production-verified.

## Source and runtime that were checked

| Item | What the fork actually contains |
| --- | --- |
| Commit | `4b7b9901abfcd81c88dc3534fb0a9540af8e0bd3` on `main` (`feat: leadjourney`, 2026-11-08) |
| `version.txt` | `v1.47.0`, last changed in `6eee397b` on 2025-06-07. Do not use it as an image tag. |
| Upstream release | `v2.25.3` is commit `a5affe62c74e39c1e7ac960d50d8418b807d532c`. This fork is 59 commits ahead of that commit. |
| Published image | GitHub Container Registry tag `ghcr.io/gitroomhq/postiz-app:v2.25.3` exists. Manifest `sha256:1e376ff2cb781022d528f171719cf174cf693a985a30cb40eefb13eae3ddda13`, checked 2026-11-09. This fork has no git tag and no published image. |
| Process model | `Dockerfile.dev` builds one image from `node:22.23.4-bookworm-slim`. `pnpm run pm2` runs Prisma `db push`, then the Nest backend (`PORT` 3000), the Next frontend (`4200`), and the Temporal orchestrator (`ORCHESTRATOR_PORT` 3002). `var/docker/nginx.conf` listens on 5000 and routes `/api/` to the backend and `/` to the frontend. |
| Data services | Upstream compose uses Postgres, Redis, and a Temporal auto-setup stack. Postgres visibility is paired with Elasticsearch because `ENABLE_ES=true` is set in the upstream file. |
| Node | `package.json` `engines.node` is `22.23.4`. The worker uses that same image. |

`POSTIZ_IMAGE` is required and has no default. Pinning `v2.25.3` would boot upstream code, not this fork. Building `Dockerfile.dev` at `4b7b9901` is the way to match the source. That build was not run here.

## Extension points

| Path | Role |
| --- | --- |
| `apps/backend/src/public-api/routes/v1/public.integrations.controller.ts` | `POST /public/v1/posts`. The worker calls only this route, and only with `type: "draft"`. |
| `apps/backend/src/services/auth/public.auth.middleware.ts` | `Authorization` is the raw API key. A `Bearer ` prefix is rejected by the worker. `pos_` keys are OAuth tokens and are not used. |
| `libraries/nestjs-libraries/src/dtos/posts/create.post.dto.ts` | Draft payload shape: `type`, `shortLink`, `date`, `tags`, `posts[].integration.id`, `posts[].value[].content`, `posts[].value[].image`, `posts[].settings`. |
| `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts` `createPost` | `type: "draft"` is stored as `DRAFT`. `startWorkflow` returns immediately for `DRAFT`, so Temporal does not publish it. |
| `libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts` | `createOrUpdatePost` maps `draft` to state `DRAFT` and `schedule` / `now` to `QUEUE`. |
| `var/docker/nginx.conf` | External draft URL through the app container is `{origin}/api/public/v1/posts`. The worker base URL is `http://postiz:5000/api` when live mode is later enabled. |
| `libraries/nestjs-libraries/src/temporal/temporal.module.ts` | Namespace defaults to `default`. Address is `TEMPORAL_ADDRESS`. |
| `apps/orchestrator/src/main.ts` | Orchestrator calls `enableShutdownHooks`. The backend `main.ts` does not. |
| `apps/orchestrator/src/health.controller.ts` | `GET /health/status` describes the Temporal namespace. The Postiz healthcheck calls it on port 3002. |
| `dynamicconfig/development-sql.yaml` | Upstream dev flag. This stack mounts `deploy/internal/temporal/dynamicconfig/production-sql.yaml` instead and keeps only `limit.maxIDLength`. |
| `services/grok-worker/src/postiz.ts` | The only Postiz HTTP call. It refuses any payload whose `type` is not `draft`. |
| `services/grok-worker/src/xai.ts` | Server-side `POST {GROK_WORKER_XAI_BASE_URL}/responses`. Documented host default is `https://api.x.ai/v1`. Model id is never filled in. |
| `services/grok-worker/src/budget.ts` | Single-statement reservation. Live mode refuses the in-memory store. |
| `services/grok-worker/src/postgres.ts` | Worker schema `grok_worker_*` in its own database. No Postiz tables. |

Public create has this expression:

```ts
rawBody?.type === 'draft' || true
```

It is always true, so `mapTypeToPost` validates `settings` as a scheduled post and then the controller sets `body.type` back to the caller's type. A later live draft can still be rejected by provider settings validation. Phase 1 mock mode does not send the payload. The example settings object is empty. For provider `x`, `XDto` requires `who_can_reply_post` when that validation runs.

The worker does not call `PUT /public/v1/posts/:id/status`, does not send `schedule`, `now`, or `update`, and does not set `republish`.

## Compose

Pinned images, checked on 2026-11-09:

| Service | Image |
| --- | --- |
| Postiz Postgres and worker Postgres | `postgres:17.11-alpine@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac` |
| Temporal Postgres | `postgres:16.15-alpine@sha256:aa6cb33cf4c19c765cefcf48d96176258800870a9a1e930ad126200f9d825139` |
| Redis | `redis:7.4.12-alpine@sha256:c5d34a98396a4775e223c74e929162c35c5a2182901ba26b50ade939941ce14b` |
| Elasticsearch | `elasticsearch:7.17.27@sha256:9a6443f55243f6acbfeb4a112d15eb3b9aac74bf25e0e39fa19b3ddd3a6879d0` |
| Temporal | `temporalio/auto-setup:1.28.1@sha256:607d68caa111338d754771efb876c92dfcdae06d056e4530bb31cd0f37406e6a` |
| Namespace check | `temporalio/admin-tools:1.28.1-tctl-1.18.4-cli-1.4.1@sha256:01537b62d995f27a0f0d33a01ac4caa6779622f454fb2eb36fed0dccd45c6244` |
| Temporal UI, profile `internal-ui` only | `temporalio/ui:2.34.0@sha256:cb17ea423d76a8a19a269d0bcd81fc12eee1f6365acd2a56b590dafb35696a95` |
| Proxy | `nginx:1.28.3-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236` |
| Worker base | `node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d` |

Temporal schema and the `default` namespace are created by `temporalio/auto-setup`, which is what upstream uses. `DB=postgres12` is the Temporal driver name from that compose file; it is the name used with Postgres 12 and newer, including the pinned 16.15 image. The one-shot `temporal-namespace` service waits until `temporal operator namespace describe --namespace default` succeeds. That command was not executed here.

Postgres, Redis, Temporal, Elasticsearch, and the worker database publish no host ports. Temporal UI binds `127.0.0.1:8080` only when the `internal-ui` profile is requested. The proxy binds `127.0.0.1:80` and `127.0.0.1:443` unless `INTERNAL_BIND_ADDRESS` is changed. TLS files are mounted from `INTERNAL_TLS_DIR` (`tls.crt`, `tls.key`). The nginx config has no hostname.

`postiz-internal-grok-worker:phase1` is a local build name. It is not a registry tag.

The shipped worker service sets `GROK_WORKER_MODE=mock`, `GROK_WORKER_ENABLE_NETWORK=false`, and `GROK_WORKER_ALLOW_PUBLISH=false`. Changing those in the compose file is required before any live call, and the process still exits unless every live variable is present. No xAI or Postiz key is passed in.

## Worker commands

From `services/grok-worker` after `pnpm install`:

```sh
pnpm test
pnpm typecheck
node --experimental-strip-types src/cli.ts --brief examples/brief.json
```

`--brief` validates the brief and prints a draft payload with `delivery: "not-sent"`.
`--enqueue` inserts a queued row. `--poll` claims queued rows with
`FOR UPDATE SKIP LOCKED` and stops on `SIGTERM`. Mock and dry-run do not
reserve budget and do not call the network. Live mode reserves
`GROK_WORKER_UNITS_PER_CALL` against `GROK_WORKER_BUDGET_UNITS` for
`GROK_WORKER_BUDGET_PERIOD` before the model call. There is no price table.

A timeout or HTTP 5xx after a request is sent moves the job to `ambiguous`.
The same idempotency key is not sent again. A definite rejection can retry
until `GROK_WORKER_MAX_ATTEMPTS` (default 3, ceiling 5). The in-memory budget
lock is a test double. `MemoryBudgetStore.durable` is false, and live mode
refuses it.

Cache keys are SHA-256 of team id, prompt version `phase1.draft.v1`, model
(empty string when unset), mode, and the brief fields. They are not shared
across teams.

## Known gaps

- Compose config was not rendered with the Docker CLI because Docker is not installed in this environment. A text contract test covers pins, secrets, and published ports.
- Healthchecks, Temporal namespace describe, Elasticsearch `vm.max_map_count`, and the nginx certificate path were not executed.
- The official Postiz image's `NEXT_PUBLIC_*` values are baked at image build for client bundles. Runtime env matches the upstream compose file and is not a verified fix for that.
- Backend shutdown hooks are unchanged. `stop_grace_period` is 60s for the app container.
- Elasticsearch security stays disabled, as in the upstream compose, and the port is not published. The host sysctl was not changed.
- Postgres `PUBLIC` is not modified. The worker uses a separate database and role instead of the Postiz database.
- Human approval is out of scope. Nothing in this phase approves or publishes.
- PGlite covered the budget SQL and the ambiguous-job path. A Postgres server was not used.
