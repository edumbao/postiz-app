// SPDX-License-Identifier: AGPL-3.0-only

import { MemoryBudgetStore } from './budget.ts';
import { MemoryCacheStore } from './cache.ts';
import { loadConfig, type WorkerConfig } from './config.ts';
import { WorkerConfigError } from './errors.ts';
import { MemoryJobStore } from './jobs.ts';
import { mockDraftText } from './mock-generator.ts';
import { deliverDraft } from './postiz.ts';
import {
  createPgClient,
  PostgresBudgetStore,
  PostgresCacheStore,
  PostgresJobStore,
} from './postgres.ts';
import type { RunDeps } from './run-brief.ts';
import { completeWithXai } from './xai.ts';

export async function createRuntime(env: NodeJS.ProcessEnv = process.env): Promise<{
  config: WorkerConfig;
  deps: RunDeps;
  close: () => Promise<void>;
}> {
  const config = loadConfig(env);
  if (config.mode === 'live' && config.store !== 'postgres') {
    throw new WorkerConfigError('Live mode refuses the in-memory store');
  }
  if (config.store === 'memory') {
    if (config.mode === 'live') {
      throw new WorkerConfigError('Live mode refuses the in-memory store');
    }
    return {
      config,
      deps: {
        config,
        jobs: new MemoryJobStore(),
        budget: new MemoryBudgetStore(),
        cache: new MemoryCacheStore(),
        generate: async (brief) => mockDraftText(brief),
      },
      close: async () => undefined,
    };
  }

  process.stderr.write('grok-worker connecting to its database\n');
  const pg = await createPgClient(config.databaseUrl!);
  process.stderr.write('grok-worker database schema ready\n');
  const budget = new PostgresBudgetStore(pg.sql);
  const jobs = new PostgresJobStore(pg.sql);
  const cache = new PostgresCacheStore(pg.sql);
  const deps: RunDeps = {
    config,
    jobs,
    budget,
    cache,
    generate:
      config.mode === 'live'
        ? (brief) =>
            completeWithXai({
              baseUrl: config.xaiBaseUrl,
              apiKey: config.xaiApiKey!,
              model: config.xaiModel,
              maxOutputTokens: config.maxOutputTokens,
              brief,
              timeoutMs: config.httpTimeoutMs,
            })
        : async (brief) => mockDraftText(brief),
    deliver:
      config.mode === 'live'
        ? (payload) =>
            deliverDraft({
              baseUrl: config.postizBaseUrl!,
              apiKey: config.postizApiKey!,
              payload,
              timeoutMs: config.httpTimeoutMs,
            })
        : undefined,
  };
  return { config, deps, close: pg.close };
}
