# Local Postiz dashboard

Startup of this dashboard is **not verified**. In the authoring VM, Temporal
never finished `Waiting for PostgreSQL to startup`, the namespace one-shot
exited 1, and the Postiz container was not brought up. A short TCP check
between containers timed out after DNS succeeded. Postgres and Redis health
checks only probe themselves, so they stayed healthy. The compose file is
still the one to try on the laptop, where the mock stack already runs.

This starts the real Postiz web app on `http://127.0.0.1:18080`. It is not the
mock preview on port 18081.

The container is upstream image `ghcr.io/gitroomhq/postiz-app:v2.25.3`,
digest `sha256:1e376ff2cb781022d528f171719cf174cf693a985a30cb40eefb13eae3ddda13`.
That digest was read from the registry on 2026-11-09. `latest` currently
points at the same digest. This file pins the version tag and the digest.

This is not the custom fork. Fork commit `4b7b9901` is 59 commits ahead of
upstream `v2.25.3`. The only Prisma schema difference is five extra indexes.
The image runs `pnpm dlx prisma@6.5.0 db push` from the schema baked into
the image, then nginx on port 5000. A new volume matches that image. Do not
point this image at a database created by another Postiz version.

`version.txt` inside the image still says `v1.47.0`. That file is stale.
The release tag is `v2.25.3`.

No social channel is configured. No OpenAI key and no Sentry DSN are set.
Registration is left on so the first local account can be created in the
browser. Account creation is manual. This bundle does not create a user.

## Do not disturb the mock stack

Leave project `postiz-local-review` running. This file uses project name
`postiz-dashboard-local`, port `127.0.0.1:18080`, and its own volumes. It
does not publish `18081` or `15432` and it sets no `container_name`.

## Resources

About 6 GB of free disk for the Postiz image, Postgres, Redis, and Temporal.
About 4 GB of RAM while it is up. The first start also downloads the Prisma
CLI into the app container, so it needs network access. Later starts reuse
the volumes.

## Windows setup

Docker Desktop must already be running (`docker info` shows a Server
section). From the unpacked `postiz-dashboard-local` folder:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\setup-dashboard.ps1
docker compose config --quiet
docker compose up -d
```

`setup-dashboard.ps1` writes `.env` and does not print passwords or the JWT.
If `.env` already exists, the script leaves it unchanged. `.env` is gitignored.
Database user names are `postiz` and `temporal`. Those names are not secrets.
The passwords are not in this repository.

From a checkout of the branch, use the same script and:

```powershell
cd deploy\internal
.\setup-dashboard.ps1
docker compose -f docker-compose.dashboard.yml config --quiet
docker compose -f docker-compose.dashboard.yml up -d
```

## Readiness

Wait until `postiz` is healthy. The first boot runs the image's schema push
and can take several minutes.

```powershell
docker compose ps
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:18080/
```

Ready means `postiz` is healthy and the HTTP status is below 500. Open
`http://127.0.0.1:18080` and use the Postiz registration screen to create
the local account. The page is the Postiz app, not the mock draft preview.

`temporal-namespace` should show as exited with code 0. That command is
`temporal operator namespace describe --namespace default`. It confirms
auto-setup created the namespace.

In the authoring environment, `docker compose config --quiet` succeeded and
the rendered port was `127.0.0.1:18080` to container port 5000. Postgres and
Redis became healthy. Temporal logged `Waiting for PostgreSQL to startup`
until the namespace one-shot exited 1. Container-to-container TCP in that
environment does not complete, so the Postiz container was not started and
the login page was not opened. Do not treat this bundle as verified ready
until the checks above pass on the laptop. The mock stack on that laptop
already showed that its Docker network can serve a container, which this
environment could not.

## Stop

```powershell
docker compose stop
```

That stops only `postiz-dashboard-local` and keeps its volumes. Do not add
`-v`. Do not run `docker system prune`.

## After the first account

Edit `.env` and set `DISABLE_REGISTRATION=true`, then run
`docker compose up -d` again. Do not paste `.env` into chat or into a ticket.

## OAuth later

`http://127.0.0.1:18080` is enough for local email registration. Connecting
a social channel needs a callback URL that the provider accepts, usually
public HTTPS on a hostname you control. This bundle does not add certificates,
provider client ids, or any channel. Do not connect LinkedIn or any other
account from this setup.

## Image startup that was inspected

The image has an empty user field, so it runs as root. `CMD` is
`sh -c nginx && pnpm run pm2`. That script deletes old pm2 processes, runs
`prisma db push` for the schema inside the image, then starts backend,
frontend, and orchestrator. Nginx listens on port 5000. `/uploads` and
`/config` are not in the image. Compose creates those directories with the
named volumes, and the root process can write them.
