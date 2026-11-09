# Local Postiz dashboard

The laptop already reached the Postiz page at `http://127.0.0.1:18080`, then
nginx returned 502 for `/api/auth/register` because the backend crashed.
`TemporalRegister.onModuleInit` failed with `cannot have more than 3 search
attribute of type Text`. That cap is SQL visibility. This file now matches
`gitroomhq/postiz-docker-compose`: Elasticsearch 7.17.27 is the visibility
store (`ENABLE_ES=true`, `ES_VERSION=v7`). This Elasticsearch change was not
booted in the authoring VM. Container-to-container TCP fails there, so do
not treat the new visibility store as verified until the laptop checks pass.

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

About 8 GB of free disk. About 5 GB of RAM while Elasticsearch is up
(`ES_JAVA_OPTS` is `-Xms256m -Xmx256m`, and the process needs more than that
heap). The first start downloads images and the Prisma CLI. Elasticsearch
is only on the compose network. Its port is not published. If it exits with
`max virtual memory areas vm.max_map_count [65530] is too low`, raise that
limit inside Docker Desktop's Linux VM. That is separate from the Postiz
database.

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

Static checks after the Elasticsearch change: compose contract tests and
`docker compose config --quiet`. No full boot was run in the authoring VM.

## Upgrade an install that already booted

The Postiz database, uploads, and config volumes stay. The Temporal
namespace `default` was created while visibility was SQL, and that choice is
stored with the namespace. Turning Elasticsearch on does not move an existing
namespace. Reset only the Temporal Postgres volume so auto-setup creates the
schema and the `default` namespace again with Elasticsearch visibility.

From the dashboard folder, with Docker Desktop running:

```powershell
docker compose stop
docker volume rm postiz-dashboard-local_temporal-postgres-data
docker compose up -d
```

Do not remove these volumes:

- `postiz-dashboard-local_postiz-postgres-data`
- `postiz-dashboard-local_postiz-redis-data`
- `postiz-dashboard-local_postiz-uploads`
- `postiz-dashboard-local_postiz-config`

Do not run `docker compose down -v` and do not run `docker system prune`.
`.env` is left as it is. `setup-dashboard.ps1` will not overwrite it.
If `docker volume rm` says the volume is in use, the Temporal containers are
still running. Run `docker compose stop` again and repeat only that `rm`.

After `up`, `temporal-namespace` should exit 0 and `postiz` should become
healthy. `http://127.0.0.1:18080/api/auth/register` should no longer be a
connection refused from nginx. Register in the browser. Do not connect a
channel.

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
