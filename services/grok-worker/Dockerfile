# SPDX-License-Identifier: AGPL-3.0-only
# Node image tag and digest verified against Docker Hub on 2026-11-09.
# Matches engines.node in the repository package.json and Dockerfile.dev.
FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.6.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY src ./src
COPY examples ./examples

USER node
ENV NODE_ENV=production
ENV GROK_WORKER_MODE=mock
ENV GROK_WORKER_ENABLE_NETWORK=false
ENV GROK_WORKER_ALLOW_PUBLISH=false

CMD ["node", "--experimental-strip-types", "src/cli.ts", "--poll"]
