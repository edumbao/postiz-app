# Local mock review

Windows PowerShell steps, including the case where Docker Desktop is installed
but the engine is stopped, are in `WINDOWS.md`. A zip of only this mock stack
is produced for transfer as `postiz-local-review.zip`.

Use this path to look at a generated draft on your own machine. It does not
start the production compose file, does not need a domain or TLS certificate,
and does not call xAI, Postiz, or a social network.

The production file remains `docker-compose.yml`. Do not combine the two files
in one `docker compose -f` command. This file is the local profile.

## What you can review with only Docker

No Postiz account, OAuth client, API key, or xAI key is required.

After startup, open `http://127.0.0.1:18081`.

The page is a local-only preview. It is not the Postiz calendar or drafts UI.
It shows:

- text from the mock generator
- the exact `POST /public/v1/posts` JSON body, with `type` forced to `draft`
- delivery `not-sent`, which means the mock Postiz adapter stored that body in
  the local worker database and did not send HTTP

The seed brief is `services/grok-worker/examples/brief.json`. Its idempotency
key is `example-brief-1`. Starting the stack again does not create a second
draft for that key.

Refreshing the page is safe. Nothing is published.

## What this does not review

A draft inside the real Postiz UI needs all of the following, and this local
file does not start them:

1. A Postiz image in `POSTIZ_IMAGE`, or a build of this fork's `Dockerfile.dev`.
   The published `ghcr.io/gitroomhq/postiz-app:v2.25.3` image does not match
   this fork. See `README.md`.
2. The production compose file, a hostname you control, and TLS files.
3. A user in that Postiz database, an organization API key, and a connected
   channel integration id.
4. A later change that sets the worker to live mode. Live mode stays
   fail-closed until the network switch, Postgres budget store, model id, and
   Postiz key are all set. `GROK_WORKER_ALLOW_PUBLISH=true` is rejected.
5. Provider settings that survive Postiz validation. For an X channel that
   includes `who_can_reply_post`. The seed brief uses an empty settings object
   and a fake integration id, so Postiz would reject it if it were sent.

Connecting an existing company account, including LinkedIn, is not part of
this review. This build has no OAuth flow and no scheduling, now, or publish
call.

## Requirements

- Docker Engine with Compose v2. The host does not need Node, pnpm, or a
  checkout of dependencies. Compose builds the worker image from
  `services/grok-worker`.
- About 1 GB of free disk for the Node base image, the Postgres image, and
  the worker layers.
- About 1 GB of RAM for this local file. The production file is larger
  because it also runs Elasticsearch and the Postiz image.
- Free localhost ports `18081` (preview) and `15432` (review database).
  Those ports avoid the upstream compose ports `4007`, `5432`, `6379`,
  `7233`, `8080`, and `8969`.
- Network access on the first build, to pull the pinned images and the
  packages in `services/grok-worker/pnpm-lock.yaml`. No paid API is called.

The database password `local-review-only` is a placeholder for this isolated
volume. It is not a production secret. Do not reuse it anywhere else.

Volumes belong to the Compose project `postiz-internal-local`, so they stay
separate from `postiz-internal` and from a checkout that uses the upstream
compose file.

## Start

From the repository root:

```sh
docker compose -f deploy/internal/docker-compose.local.yml up -d --build
```

Or:

```sh
sh deploy/internal/local-up.sh
```

Then open `http://127.0.0.1:18081`.

Logs:

```sh
docker compose -f deploy/internal/docker-compose.local.yml logs -f grok-worker
```

## Stop

This stops only the containers in `docker-compose.local.yml`. It does not
stop other Docker projects and it does not delete volumes.

```sh
docker compose -f deploy/internal/docker-compose.local.yml stop
```

Or:

```sh
sh deploy/internal/local-stop.sh
```

Start the same containers again, with the same drafts:

```sh
docker compose -f deploy/internal/docker-compose.local.yml start
```

`docker compose -f deploy/internal/docker-compose.local.yml down` removes the
containers and keeps the named volume. Do not add `-v` unless you intend to
delete the local review drafts. These instructions never pass `-v` and never
run `docker system prune`.

## Add another mock brief

Save a JSON file on the host with the same fields as
`services/grok-worker/examples/brief.json` and a new `idempotencyKey`. Use
fake ids such as `example-team` and `example-integration`.

```sh
docker compose -f deploy/internal/docker-compose.local.yml cp ./my-brief.json grok-worker:/tmp/brief.json
docker compose -f deploy/internal/docker-compose.local.yml exec grok-worker node --experimental-strip-types src/cli.ts --enqueue /tmp/brief.json
```

Reload `http://127.0.0.1:18081`. The new card appears after the poller stores
it. `http://127.0.0.1:18081/drafts.json` is the same list as JSON.

## Optional database look

The review database is on `127.0.0.1:15432`, database `grok_worker`, user
`grok_worker`, password `local-review-only`. You only need this if you want
to inspect rows. The preview page is enough for the mock draft.
