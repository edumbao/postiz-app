// SPDX-License-Identifier: AGPL-3.0-only

import { WorkerConfigError } from './errors.ts';

export const PROMPT_VERSION = 'phase1.draft.v1';
export const MAX_OUTPUT_CHARS = 4000;
export const MAX_OUTPUT_TOKENS_CEILING = 4000;
export const MAX_ATTEMPTS_CEILING = 5;
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
export const MAX_HTTP_TIMEOUT_MS = 60_000;
export const XAI_DOCUMENTED_BASE_URL = 'https://api.x.ai/v1';

export type WorkerMode = 'mock' | 'dry-run' | 'live';
export type WorkerStore = 'memory' | 'postgres';

export interface WorkerConfig {
  mode: WorkerMode;
  store: WorkerStore;
  allowPublish: false;
  enableNetwork: boolean;
  databaseUrl: string | null;
  xaiBaseUrl: string;
  xaiApiKey: string | null;
  xaiModel: string | null;
  maxOutputTokens: number | null;
  unitsPerCall: number | null;
  budgetUnits: number | null;
  budgetPeriod: string | null;
  postizBaseUrl: string | null;
  postizApiKey: string | null;
  httpTimeoutMs: number;
  maxAttempts: number;
  leaseSeconds: number;
  bindHost: '127.0.0.1' | '0.0.0.0';
  healthPort: number;
  preview: boolean;
  seedBrief: boolean;
  seedPath: string;
}

function read(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

function requirePositiveInt(
  name: string,
  raw: string,
  ceiling: number
): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new WorkerConfigError(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > ceiling) {
    throw new WorkerConfigError(`${name} must be between 1 and ${ceiling}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const publish = read(env, 'GROK_WORKER_ALLOW_PUBLISH');
  if (publish !== '' && publish !== 'false') {
    throw new WorkerConfigError(
      'GROK_WORKER_ALLOW_PUBLISH cannot be enabled. Phase 1 has no publish, schedule, or now path.'
    );
  }

  const modeRaw = read(env, 'GROK_WORKER_MODE') || 'mock';
  if (modeRaw !== 'mock' && modeRaw !== 'dry-run' && modeRaw !== 'live') {
    throw new WorkerConfigError(
      'GROK_WORKER_MODE must be mock, dry-run, or live'
    );
  }
  const mode: WorkerMode = modeRaw;

  const storeRaw = read(env, 'GROK_WORKER_STORE') || 'memory';
  if (storeRaw !== 'memory' && storeRaw !== 'postgres') {
    throw new WorkerConfigError('GROK_WORKER_STORE must be memory or postgres');
  }
  const store: WorkerStore = storeRaw;

  const networkRaw = read(env, 'GROK_WORKER_ENABLE_NETWORK') || 'false';
  if (networkRaw !== 'true' && networkRaw !== 'false') {
    throw new WorkerConfigError(
      'GROK_WORKER_ENABLE_NETWORK must be true or false'
    );
  }
  const enableNetwork = networkRaw === 'true';

  const timeoutRaw = read(env, 'GROK_WORKER_HTTP_TIMEOUT_MS');
  const httpTimeoutMs = timeoutRaw
    ? requirePositiveInt(
        'GROK_WORKER_HTTP_TIMEOUT_MS',
        timeoutRaw,
        MAX_HTTP_TIMEOUT_MS
      )
    : DEFAULT_HTTP_TIMEOUT_MS;

  const attemptsRaw = read(env, 'GROK_WORKER_MAX_ATTEMPTS');
  const maxAttempts = attemptsRaw
    ? requirePositiveInt(
        'GROK_WORKER_MAX_ATTEMPTS',
        attemptsRaw,
        MAX_ATTEMPTS_CEILING
      )
    : 3;

  const previewRaw = read(env, 'GROK_WORKER_PREVIEW') || 'false';
  if (previewRaw !== 'true' && previewRaw !== 'false') {
    throw new WorkerConfigError('GROK_WORKER_PREVIEW must be true or false');
  }
  const preview = previewRaw === 'true';
  if (preview && mode === 'live') {
    throw new WorkerConfigError(
      'GROK_WORKER_PREVIEW cannot be combined with live mode'
    );
  }
  const bindRaw = read(env, 'GROK_WORKER_BIND') || '127.0.0.1';
  if (bindRaw !== '127.0.0.1' && bindRaw !== '0.0.0.0') {
    throw new WorkerConfigError('GROK_WORKER_BIND must be 127.0.0.1 or 0.0.0.0');
  }
  if (bindRaw === '0.0.0.0' && !preview) {
    throw new WorkerConfigError(
      'GROK_WORKER_BIND=0.0.0.0 is only allowed when GROK_WORKER_PREVIEW=true'
    );
  }
  const seedRaw = read(env, 'GROK_WORKER_SEED_BRIEF') || 'false';
  if (seedRaw !== 'true' && seedRaw !== 'false') {
    throw new WorkerConfigError('GROK_WORKER_SEED_BRIEF must be true or false');
  }

  const databaseUrl = read(env, 'GROK_WORKER_DATABASE_URL') || null;
  if (store === 'postgres' && !databaseUrl) {
    throw new WorkerConfigError(
      'GROK_WORKER_DATABASE_URL is required when GROK_WORKER_STORE=postgres'
    );
  }

  const xaiModel = read(env, 'GROK_WORKER_XAI_MODEL') || null;
  const xaiApiKey = read(env, 'GROK_WORKER_XAI_API_KEY') || null;
  const xaiBaseUrl = read(env, 'GROK_WORKER_XAI_BASE_URL') || XAI_DOCUMENTED_BASE_URL;
  let parsedBase: URL;
  try {
    parsedBase = new URL(xaiBaseUrl);
  } catch {
    throw new WorkerConfigError('GROK_WORKER_XAI_BASE_URL is not a valid URL');
  }
  if (parsedBase.protocol !== 'https:') {
    throw new WorkerConfigError('GROK_WORKER_XAI_BASE_URL must use https');
  }

  const maxOutputTokens = read(env, 'GROK_WORKER_MAX_OUTPUT_TOKENS')
    ? requirePositiveInt(
        'GROK_WORKER_MAX_OUTPUT_TOKENS',
        read(env, 'GROK_WORKER_MAX_OUTPUT_TOKENS'),
        MAX_OUTPUT_TOKENS_CEILING
      )
    : null;
  const unitsPerCall = read(env, 'GROK_WORKER_UNITS_PER_CALL')
    ? requirePositiveInt(
        'GROK_WORKER_UNITS_PER_CALL',
        read(env, 'GROK_WORKER_UNITS_PER_CALL'),
        Number.MAX_SAFE_INTEGER
      )
    : null;
  const budgetUnits = read(env, 'GROK_WORKER_BUDGET_UNITS')
    ? requirePositiveInt(
        'GROK_WORKER_BUDGET_UNITS',
        read(env, 'GROK_WORKER_BUDGET_UNITS'),
        Number.MAX_SAFE_INTEGER
      )
    : null;
  const budgetPeriod = read(env, 'GROK_WORKER_BUDGET_PERIOD') || null;
  const postizBaseUrl = read(env, 'GROK_WORKER_POSTIZ_BASE_URL') || null;
  const postizApiKey = read(env, 'GROK_WORKER_POSTIZ_API_KEY') || null;

  if (mode === 'live') {
    const missing: string[] = [];
    if (!enableNetwork) missing.push('GROK_WORKER_ENABLE_NETWORK=true');
    if (store !== 'postgres') missing.push('GROK_WORKER_STORE=postgres');
    if (!databaseUrl) missing.push('GROK_WORKER_DATABASE_URL');
    if (!xaiModel) missing.push('GROK_WORKER_XAI_MODEL');
    if (!xaiApiKey) missing.push('GROK_WORKER_XAI_API_KEY');
    if (maxOutputTokens === null) missing.push('GROK_WORKER_MAX_OUTPUT_TOKENS');
    if (unitsPerCall === null) missing.push('GROK_WORKER_UNITS_PER_CALL');
    if (budgetUnits === null) missing.push('GROK_WORKER_BUDGET_UNITS');
    if (!budgetPeriod) missing.push('GROK_WORKER_BUDGET_PERIOD');
    if (!postizBaseUrl) missing.push('GROK_WORKER_POSTIZ_BASE_URL');
    if (!postizApiKey) missing.push('GROK_WORKER_POSTIZ_API_KEY');
    if (missing.length > 0) {
      throw new WorkerConfigError(
        `Live mode is fail-closed until all of these are set: ${missing.join(', ')}. No model id is assumed.`
      );
    }
    if (unitsPerCall !== null && budgetUnits !== null && unitsPerCall > budgetUnits) {
      throw new WorkerConfigError(
        'GROK_WORKER_UNITS_PER_CALL cannot exceed GROK_WORKER_BUDGET_UNITS'
      );
    }
  }

  return {
    mode,
    store,
    allowPublish: false,
    enableNetwork,
    databaseUrl,
    xaiBaseUrl: parsedBase.toString().replace(/\/$/, ''),
    xaiApiKey,
    xaiModel,
    maxOutputTokens,
    unitsPerCall,
    budgetUnits,
    budgetPeriod,
    postizBaseUrl,
    postizApiKey,
    httpTimeoutMs,
    maxAttempts,
    leaseSeconds: 120,
    bindHost: bindRaw,
    healthPort: 8787,
    preview,
    seedBrief: seedRaw === 'true',
    seedPath: read(env, 'GROK_WORKER_SEED_PATH') || '/app/examples/brief.json',
  };
}
