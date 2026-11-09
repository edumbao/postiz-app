# Backup, restore, and rollback

These steps were not executed. They are the operator procedure for the
internal compose file in this directory. Do not point them at a live customer
account. This repository's Phase 1 worker does not publish.

Passwords live only in `deploy/internal/.env`, which is gitignored. The
example file has empty values.

## Before an upgrade

1. Record the current `POSTIZ_IMAGE` value and the git commit the image was built from.
2. Stop writes by stopping the proxy, then the Postiz container. Leave the databases running.
3. Dump the Postiz database from inside the network:

```sh
docker compose --env-file .env exec -T postiz-postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > postiz.dump
```

4. Dump the Temporal database the same way from `temporal-postgres` (database `temporal`).
5. Dump the worker database from `grok-postgres` (database `grok_worker`, user `grok_worker`).
6. Archive the `postiz-uploads` volume. Config that Postiz wrote under `/config` is the `postiz-config` volume.
7. Redis has AOF on the `postiz-redis-data` volume. A restart replays it. It is not the source of posts.

## Restore

1. Stop `postiz`, `proxy`, `grok-worker`, and `temporal`.
2. Restore a dump into an empty database with `pg_restore --clean --if-exists` as the matching user. Do not restore a Postiz dump into `grok_worker` or the Temporal database.
3. Restore the uploads volume before starting Postiz. The app container runs `prisma db push` on startup, which is the upstream image behavior. Restoring a dump taken from the same schema is the safe path. `db push` against a dump from a different Postiz version can alter tables.
4. Start databases, wait for health, then Temporal, then the namespace one-shot, then Postiz, then the proxy.

## Rollback

1. Put the previous `POSTIZ_IMAGE` back in `.env`.
2. Restore the Postiz dump taken before the upgrade if the new image already ran `db push`.
3. Restore the Temporal dump if the Temporal image or schema changed.
4. The worker schema is version 1. A worker that sees another `schema_version` exits. Restore `grok_worker` from its dump rather than editing the tables in place.
5. Start the previous image. Confirm `GET` on the proxy returns a non-5xx page and the orchestrator log shows the Temporal healthcheck only after you intend to serve traffic.

## Worker jobs

`ambiguous` means a model or draft request may have landed. Do not enqueue the same idempotency key expecting a second attempt. Inspect Postiz drafts for that team before deciding. `failed` can be retried by the worker until `GROK_WORKER_MAX_ATTEMPTS`. The shipped compose never reaches those states because network access and publishing are off.

## Not done here

No volume was created, no sysctl was set, and Elasticsearch was not started. Single-node Elasticsearch from the upstream compose usually needs `vm.max_map_count=262144` on the host. That change is an operator decision and is outside this review.
