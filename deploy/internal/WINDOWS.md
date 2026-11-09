# Windows local mock review

Docker Desktop is installed. The engine was not running when this was checked
(`docker context` is `desktop-linux`, client 29.8.0, Compose v5.5.1). Compose
cannot start containers until the engine is up. This review does not need a
clone of the Postiz repo, a Postiz account, an API key, or an xAI key.

The page at `http://127.0.0.1:18081` is a local mock preview. It is not the
Postiz app. The sample draft is not sent anywhere.

## 1. Start the engine

Open Docker Desktop from the Start menu and wait until it says it is running.

```powershell
docker context use desktop-linux
docker info
```

`docker info` must print a Server section. If it says it cannot connect to
the pipe, the engine is still stopped. Do not run Compose until that command
succeeds.

## 2. Unpack the archive

The coordinator archive is `postiz-local-review.zip`. Unpack it, then:

```powershell
cd $HOME\Downloads\postiz-local-review
docker compose up -d --build
```

The first build downloads the pinned Node and Postgres images and installs the
worker packages from `grok-worker/pnpm-lock.yaml`. It needs network access. It
does not call xAI or Postiz.

From a full checkout of this fork, the same stack is:

```powershell
cd C:\path\to\postiz-app
docker compose -f deploy/internal/docker-compose.local.yml up -d --build
```

## 3. Open the preview

```powershell
start http://127.0.0.1:18081
```

Expect a page titled "Local mock draft preview" and one card for
`example-brief-1`. The text starts with `Draft (phase1.draft.v1):`. Delivery
is `not-sent`. JSON for the same list is `http://127.0.0.1:18081/drafts.json`.

Host ports, bound to loopback only:

- `127.0.0.1:18081` preview
- `127.0.0.1:15432` the review database

Those avoid the ports used by the upstream Postiz compose file (`4007`,
`5432`, `6379`, `7233`, `8080`, `8969`).

About 1 GB of disk and 1 GB of RAM is enough for this mock stack. The machine
is Windows amd64. The image digests are multi-arch indexes, so Desktop pulls
the linux/amd64 variants.

## 4. Stop

This stops only this compose project and keeps the volume.

```powershell
docker compose stop
```

Start it again later with `docker compose start`. Do not add `-v`. Do not run
`docker system prune`.

## Not included

No LinkedIn or other social account is connected. Publishing, scheduling, and
live model calls are switched off in this compose file.
