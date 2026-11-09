// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';

export function newJobId(): string {
  return randomUUID();
}

export type JobState =
  | 'queued'
  | 'claimed'
  | 'generating'
  | 'posting'
  | 'completed'
  | 'failed'
  | 'ambiguous';

export interface JobRecord {
  id: string;
  teamId: string;
  idempotencyKey: string;
  state: JobState;
  attempt: number;
  maxAttempts: number;
  payload: unknown;
  result: unknown | null;
  lastError: string | null;
  leaseUntil: string | null;
}

export type ClaimAction =
  | 'owned'
  | 'replay'
  | 'in-progress'
  | 'ambiguous'
  | 'exhausted';

export interface ClaimResult {
  action: ClaimAction;
  job: JobRecord;
}

export function decideClaim(
  existing: JobRecord | null,
  nowMs: number
): ClaimAction | 'insert' {
  if (!existing) {
    return 'insert';
  }
  if (existing.state === 'completed') {
    return 'replay';
  }
  if (existing.state === 'ambiguous') {
    return 'ambiguous';
  }
  if (existing.state === 'failed') {
    return existing.attempt >= existing.maxAttempts ? 'exhausted' : 'owned';
  }
  if (existing.state === 'queued') {
    return 'owned';
  }
  if (
    existing.state === 'claimed' ||
    existing.state === 'generating' ||
    existing.state === 'posting'
  ) {
    const lease = existing.leaseUntil ? Date.parse(existing.leaseUntil) : 0;
    if (Number.isFinite(lease) && lease > nowMs) {
      return 'in-progress';
    }
    return 'ambiguous';
  }
  return 'ambiguous';
}

export interface JobStore {
  enqueue(job: JobRecord): Promise<JobRecord>;
  nextQueued(): Promise<JobRecord | null>;
  listCompleted(limit: number): Promise<JobRecord[]>;
  claim(input: {
    id: string;
    teamId: string;
    idempotencyKey: string;
    maxAttempts: number;
    payload: unknown;
    leaseSeconds: number;
    now: Date;
  }): Promise<ClaimResult>;
  claimQueued(leaseSeconds: number): Promise<JobRecord | null>;
  compareAndSet(
    id: string,
    from: JobState | JobState[],
    to: JobState,
    patch?: { result?: unknown; lastError?: string | null; leaseUntil?: string | null }
  ): Promise<JobRecord | null>;
  get(teamId: string, idempotencyKey: string): Promise<JobRecord | null>;
}

function clone(job: JobRecord): JobRecord {
  return {
    ...job,
    payload: job.payload,
    result: job.result,
  };
}

export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private chain: Promise<unknown> = Promise.resolve();

  private lock<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private key(teamId: string, idempotencyKey: string): string {
    return `${teamId}\0${idempotencyKey}`;
  }

  private order = 0;
  private readonly insertedAt = new Map<string, number>();

  enqueue(job: JobRecord): Promise<JobRecord> {
    return this.lock(async () => {
      const key = this.key(job.teamId, job.idempotencyKey);
      const existing = this.jobs.get(key);
      if (existing) {
        return clone(existing);
      }
      this.jobs.set(key, clone(job));
      this.insertedAt.set(key, this.order++);
      return clone(job);
    });
  }

  listCompleted(limit: number): Promise<JobRecord[]> {
    return this.lock(async () => {
      return [...this.jobs.values()]
        .filter((job) => job.state === 'completed')
        .sort((a, b) => {
          const aAt = this.insertedAt.get(this.key(a.teamId, a.idempotencyKey)) ?? 0;
          const bAt = this.insertedAt.get(this.key(b.teamId, b.idempotencyKey)) ?? 0;
          return bAt - aAt;
        })
        .slice(0, limit)
        .map((job) => clone(job));
    });
  }

  nextQueued(): Promise<JobRecord | null> {
    return this.lock(async () => {
      const queued = [...this.jobs.values()]
        .filter((job) => job.state === 'queued')
        .sort((a, b) => {
          const aAt = this.insertedAt.get(this.key(a.teamId, a.idempotencyKey)) ?? 0;
          const bAt = this.insertedAt.get(this.key(b.teamId, b.idempotencyKey)) ?? 0;
          return aAt - bAt;
        });
      return queued[0] ? clone(queued[0]) : null;
    });
  }

  claim(input: {
    id: string;
    teamId: string;
    idempotencyKey: string;
    maxAttempts: number;
    payload: unknown;
    leaseSeconds: number;
    now: Date;
  }): Promise<ClaimResult> {
    return this.lock(async () => {
      const key = this.key(input.teamId, input.idempotencyKey);
      const existing = this.jobs.get(key) ?? null;
      const decision = decideClaim(existing, input.now.getTime());
      if (decision === 'insert') {
        const created: JobRecord = {
          id: input.id,
          teamId: input.teamId,
          idempotencyKey: input.idempotencyKey,
          state: 'claimed',
          attempt: 1,
          maxAttempts: input.maxAttempts,
          payload: input.payload,
          result: null,
          lastError: null,
          leaseUntil: new Date(
            input.now.getTime() + input.leaseSeconds * 1000
          ).toISOString(),
        };
        this.jobs.set(key, created);
        return { action: 'owned', job: clone(created) };
      }
      if (!existing) {
        throw new Error('Missing job after claim decision');
      }
      if (
        decision === 'owned' &&
        (existing.state === 'failed' || existing.state === 'queued')
      ) {
        existing.state = 'claimed';
        existing.attempt += 1;
        existing.lastError = null;
        existing.leaseUntil = new Date(
          input.now.getTime() + input.leaseSeconds * 1000
        ).toISOString();
        return { action: 'owned', job: clone(existing) };
      }
      if (decision === 'ambiguous' && existing.state !== 'ambiguous') {
        existing.state = 'ambiguous';
        existing.lastError =
          existing.lastError ?? 'Lease expired before the outcome was known';
        return { action: 'ambiguous', job: clone(existing) };
      }
      return { action: decision, job: clone(existing) };
    });
  }

  claimQueued(leaseSeconds: number): Promise<JobRecord | null> {
    return this.lock(async () => {
      const queued = [...this.jobs.values()]
        .filter((job) => job.state === 'queued')
        .sort((a, b) => a.id.localeCompare(b.id));
      const next = queued[0];
      if (!next) {
        return null;
      }
      next.state = 'claimed';
      next.attempt += 1;
      next.leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      return clone(next);
    });
  }

  compareAndSet(
    id: string,
    from: JobState | JobState[],
    to: JobState,
    patch?: { result?: unknown; lastError?: string | null; leaseUntil?: string | null }
  ): Promise<JobRecord | null> {
    return this.lock(async () => {
      const allowed = Array.isArray(from) ? from : [from];
      const job = [...this.jobs.values()].find((item) => item.id === id);
      if (!job || !allowed.includes(job.state)) {
        return null;
      }
      job.state = to;
      if (patch && 'result' in patch) {
        job.result = patch.result ?? null;
      }
      if (patch && 'lastError' in patch) {
        job.lastError = patch.lastError ?? null;
      }
      if (patch && 'leaseUntil' in patch) {
        job.leaseUntil = patch.leaseUntil ?? null;
      }
      return clone(job);
    });
  }

  get(teamId: string, idempotencyKey: string): Promise<JobRecord | null> {
    return this.lock(async () => {
      const job = this.jobs.get(this.key(teamId, idempotencyKey));
      return job ? clone(job) : null;
    });
  }
}
