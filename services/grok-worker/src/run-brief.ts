// SPDX-License-Identifier: AGPL-3.0-only

import type { BudgetStore } from './budget.ts';
import type { CacheStore } from './cache.ts';
import { contentCacheKey } from './cache-key.ts';
import { PROMPT_VERSION, type WorkerConfig } from './config.ts';
import { buildDraftPayload, parseBrief, type DraftPayload } from './draft.ts';
import { AmbiguousOutcome, RetryableOutcome } from './errors.ts';
import { newJobId, type JobStore } from './jobs.ts';

export interface BriefResultCompleted {
  status: 'completed';
  delivery: 'not-sent' | 'draft-created';
  jobId: string;
  cacheKey: string;
  text: string;
  draft: DraftPayload;
  postIds: string[];
}

export interface BriefResultStopped {
  status: 'in-progress' | 'ambiguous' | 'failed' | 'budget-exceeded';
  jobId: string;
  error?: string;
  attempts?: number;
}

export type BriefResult = BriefResultCompleted | BriefResultStopped;

export interface RunDeps {
  config: WorkerConfig;
  jobs: JobStore;
  budget: BudgetStore;
  cache: CacheStore;
  now?: () => Date;
  generate?: (brief: string) => Promise<string>;
  deliver?: (payload: DraftPayload) => Promise<{ postIds: string[] }>;
}

function stopped(
  status: BriefResultStopped['status'],
  jobId: string,
  error?: string,
  attempts?: number
): BriefResultStopped {
  return { status, jobId, error, attempts };
}

export async function runBrief(raw: unknown, deps: RunDeps): Promise<BriefResult> {
  if (deps.config.allowPublish) {
    throw new Error('Publishing is disabled');
  }
  if (deps.config.mode === 'live') {
    if (!deps.config.enableNetwork || deps.config.store !== 'postgres' || !deps.budget.durable) {
      throw new Error(
        'Live mode is disabled until GROK_WORKER_STORE=postgres and a durable budget store are both in use'
      );
    }
    if (!deps.generate || !deps.deliver) {
      throw new Error('Live mode requires generate and deliver adapters');
    }
  }

  const brief = parseBrief(raw);
  const now = deps.now ?? (() => new Date());
  const cacheKey = contentCacheKey({
    teamId: brief.teamId,
    promptVersion: PROMPT_VERSION,
    model: deps.config.xaiModel ?? '',
    mode: deps.config.mode,
    brief,
  });
  const claim = await deps.jobs.claim({
    id: newJobId(),
    teamId: brief.teamId,
    idempotencyKey: brief.idempotencyKey,
    maxAttempts: deps.config.maxAttempts,
    payload: brief,
    leaseSeconds: deps.config.leaseSeconds,
    now: now(),
  });

  if (claim.action === 'replay' && claim.job.result && typeof claim.job.result === 'object') {
    return claim.job.result as BriefResultCompleted;
  }
  if (claim.action === 'in-progress') {
    return stopped('in-progress', claim.job.id);
  }
  if (claim.action === 'ambiguous') {
    return stopped('ambiguous', claim.job.id, claim.job.lastError ?? 'ambiguous');
  }
  if (claim.action === 'exhausted') {
    return stopped('failed', claim.job.id, claim.job.lastError ?? 'retry bound reached', claim.job.attempt);
  }
  if (claim.action !== 'owned') {
    return stopped('failed', claim.job.id, 'unhandled claim state');
  }

  const live = deps.config.mode === 'live';
  let reserved = false;
  try {
    let text = await deps.cache.get(cacheKey, brief.teamId);
    if (!text) {
      if (live) {
        const period = deps.config.budgetPeriod;
        const cap = deps.config.budgetUnits;
        const cost = deps.config.unitsPerCall;
        if (!period || cap === null || cost === null) {
          throw new Error('Live budget settings are incomplete');
        }
        const reservation = await deps.budget.reserve(brief.teamId, period, cap, cost);
        if (reservation === 'exceeded') {
          await deps.jobs.compareAndSet(claim.job.id, 'claimed', 'failed', {
            lastError: 'budget-exceeded',
          });
          return stopped('budget-exceeded', claim.job.id, 'budget-exceeded', claim.job.attempt);
        }
        reserved = true;
      }
      const generating = await deps.jobs.compareAndSet(
        claim.job.id,
        'claimed',
        'generating'
      );
      if (!generating) {
        return stopped('in-progress', claim.job.id, 'lost the generating transition');
      }
      text = live
        ? await deps.generate!(brief.brief)
        : await mockOrDryRun(brief.brief, deps);
      await deps.cache.put({
        cacheKey,
        teamId: brief.teamId,
        promptVersion: PROMPT_VERSION,
        model: deps.config.xaiModel ?? '',
        outputText: text,
      });
    }

    const draft = buildDraftPayload(brief, text);
    if (!live) {
      const result: BriefResultCompleted = {
        status: 'completed',
        delivery: 'not-sent',
        jobId: claim.job.id,
        cacheKey,
        text,
        draft,
        postIds: [],
      };
      const saved = await deps.jobs.compareAndSet(
        claim.job.id,
        ['claimed', 'generating'],
        'completed',
        { result, lastError: null }
      );
      if (!saved) {
        return stopped('ambiguous', claim.job.id, 'Could not persist the mock result');
      }
      return result;
    }

    const posting = await deps.jobs.compareAndSet(
      claim.job.id,
      ['claimed', 'generating'],
      'posting'
    );
    if (!posting) {
      throw new AmbiguousOutcome('Could not enter the posting state');
    }
    const delivered = await deps.deliver!(draft);
    const result: BriefResultCompleted = {
      status: 'completed',
      delivery: 'draft-created',
      jobId: claim.job.id,
      cacheKey,
      text,
      draft,
      postIds: delivered.postIds,
    };
    const saved = await deps.jobs.compareAndSet(claim.job.id, 'posting', 'completed', {
      result,
      lastError: null,
    });
    if (!saved) {
      throw new AmbiguousOutcome('Draft may have been created but the job row was not completed');
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown failure';
    if (error instanceof AmbiguousOutcome) {
      await deps.jobs.compareAndSet(
        claim.job.id,
        ['claimed', 'generating', 'posting'],
        'ambiguous',
        { lastError: message }
      );
      return stopped('ambiguous', claim.job.id, message, claim.job.attempt);
    }
    if (reserved) {
      const period = deps.config.budgetPeriod;
      const cost = deps.config.unitsPerCall;
      if (period && cost !== null) {
        await deps.budget.release(brief.teamId, period, cost);
      }
    }
    const retryable = error instanceof RetryableOutcome || error instanceof Error;
    if (!retryable) {
      throw error;
    }
    await deps.jobs.compareAndSet(
      claim.job.id,
      ['claimed', 'generating', 'posting'],
      'failed',
      { lastError: message }
    );
    if (claim.job.attempt >= deps.config.maxAttempts) {
      return stopped('failed', claim.job.id, message, claim.job.attempt);
    }
    return stopped('failed', claim.job.id, message, claim.job.attempt);
  }
}

async function mockOrDryRun(brief: string, deps: RunDeps): Promise<string> {
  if (deps.generate) {
    return deps.generate(brief);
  }
  const { mockDraftText } = await import('./mock-generator.ts');
  return mockDraftText(brief);
}

export async function enqueueBrief(raw: unknown, deps: RunDeps): Promise<{ jobId: string }> {
  const brief = parseBrief(raw);
  const job = await deps.jobs.enqueue({
    id: newJobId(),
    teamId: brief.teamId,
    idempotencyKey: brief.idempotencyKey,
    state: 'queued',
    attempt: 0,
    maxAttempts: deps.config.maxAttempts,
    payload: brief,
    result: null,
    lastError: null,
    leaseUntil: null,
  });
  return { jobId: job.id };
}
