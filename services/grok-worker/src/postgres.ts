// SPDX-License-Identifier: AGPL-3.0-only

import { setDefaultResultOrder } from 'node:dns';
import pg from 'pg';

setDefaultResultOrder('ipv4first');
import {
  RELEASE_BUDGET_SQL,
  RESERVE_BUDGET_SQL,
  type BudgetStore,
} from './budget.ts';
import {
  decideClaim,
  type ClaimResult,
  type JobRecord,
  type JobState,
  type JobStore,
} from './jobs.ts';
import {
  asNumber,
  CLAIM_QUEUED_SQL,
  ensureSchema,
  type SqlClient,
  type SqlQueryResult,
} from './sql.ts';

const { Pool } = pg;

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === '23505'
  );
}

function rowToJob(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    idempotencyKey: String(row.idempotency_key),
    state: String(row.state) as JobState,
    attempt: asNumber(row.attempt),
    maxAttempts: asNumber(row.max_attempts),
    payload: row.payload,
    result: row.result ?? null,
    lastError: row.last_error === null || row.last_error === undefined
      ? null
      : String(row.last_error),
    leaseUntil: row.lease_until ? new Date(String(row.lease_until)).toISOString() : null,
  };
}

export class PostgresBudgetStore implements BudgetStore {
  readonly durable = true;
  private readonly sql: SqlClient;

  constructor(sql: SqlClient) {
    this.sql = sql;
  }

  async reserve(
    teamId: string,
    periodKey: string,
    capUnits: number,
    cost: number
  ): Promise<'reserved' | 'exceeded'> {
    const result = await this.sql.query(RESERVE_BUDGET_SQL, [
      teamId,
      periodKey,
      capUnits,
      cost,
    ]);
    return result.rowCount === 1 ? 'reserved' : 'exceeded';
  }

  async release(teamId: string, periodKey: string, cost: number): Promise<void> {
    const result = await this.sql.query(RELEASE_BUDGET_SQL, [
      teamId,
      periodKey,
      cost,
    ]);
    if (result.rowCount !== 1) {
      throw new Error('Budget release failed');
    }
  }
}

export class PostgresJobStore implements JobStore {
  private readonly sql: SqlClient;

  constructor(sql: SqlClient) {
    this.sql = sql;
  }

  async listCompleted(limit: number): Promise<JobRecord[]> {
    const result = await this.sql.query(
      `SELECT id, team_id, idempotency_key, state, attempt, max_attempts,
              payload, result, last_error, lease_until
       FROM grok_worker_jobs
       WHERE state = 'completed'
       ORDER BY updated_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => rowToJob(row));
  }

  async nextQueued(): Promise<JobRecord | null> {
    const result = await this.sql.query(
      `SELECT id, team_id, idempotency_key, state, attempt, max_attempts,
              payload, result, last_error, lease_until
       FROM grok_worker_jobs
       WHERE state = 'queued'
       ORDER BY created_at
       LIMIT 1`
    );
    if (result.rowCount !== 1) {
      return null;
    }
    return rowToJob(result.rows[0]);
  }

  async enqueue(job: JobRecord): Promise<JobRecord> {
    const inserted = await this.sql.query(
      `INSERT INTO grok_worker_jobs
         (id, team_id, idempotency_key, state, attempt, max_attempts, payload, lease_until)
       VALUES ($1, $2, $3, 'queued', 0, $4, $5::jsonb, NULL)
       ON CONFLICT (team_id, idempotency_key) DO NOTHING
       RETURNING id, team_id, idempotency_key, state, attempt, max_attempts,
                 payload, result, last_error, lease_until`,
      [job.id, job.teamId, job.idempotencyKey, job.maxAttempts, JSON.stringify(job.payload)]
    );
    if (inserted.rowCount === 1) {
      return rowToJob(inserted.rows[0]);
    }
    const existing = await this.get(job.teamId, job.idempotencyKey);
    if (!existing) {
      throw new Error('Enqueue conflict did not return a job');
    }
    return existing;
  }

  async claim(input: {
    id: string;
    teamId: string;
    idempotencyKey: string;
    maxAttempts: number;
    payload: unknown;
    leaseSeconds: number;
    now: Date;
  }): Promise<ClaimResult> {
    try {
      return await this.claimOnce(input);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      return this.claimOnce(input);
    }
  }

  private async claimOnce(input: {
    id: string;
    teamId: string;
    idempotencyKey: string;
    maxAttempts: number;
    payload: unknown;
    leaseSeconds: number;
    now: Date;
  }): Promise<ClaimResult> {
    return this.sql.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT id, team_id, idempotency_key, state, attempt, max_attempts,
                payload, result, last_error, lease_until
         FROM grok_worker_jobs
         WHERE team_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [input.teamId, input.idempotencyKey]
      );
      const existing = locked.rows[0] ? rowToJob(locked.rows[0]) : null;
      const decision = decideClaim(existing, input.now.getTime());
      if (decision === 'insert') {
        const leaseUntil = new Date(
          input.now.getTime() + input.leaseSeconds * 1000
        ).toISOString();
        const inserted = await tx.query(
          `INSERT INTO grok_worker_jobs
             (id, team_id, idempotency_key, state, attempt, max_attempts, payload, lease_until)
           VALUES ($1, $2, $3, 'claimed', 1, $4, $5::jsonb, $6)
           RETURNING id, team_id, idempotency_key, state, attempt, max_attempts,
                     payload, result, last_error, lease_until`,
          [
            input.id,
            input.teamId,
            input.idempotencyKey,
            input.maxAttempts,
            JSON.stringify(input.payload),
            leaseUntil,
          ]
        );
        return { action: 'owned', job: rowToJob(inserted.rows[0]) };
      }
      if (!existing) {
        throw new Error('Missing job after claim decision');
      }
      if (decision === 'owned') {
        const updated = await tx.query(
          `UPDATE grok_worker_jobs
           SET state = 'claimed',
               attempt = attempt + 1,
               last_error = NULL,
               lease_until = $2,
               updated_at = now()
           WHERE id = $1
             AND (
               state = 'queued'
               OR (state = 'failed' AND attempt < max_attempts)
             )
           RETURNING id, team_id, idempotency_key, state, attempt, max_attempts,
                     payload, result, last_error, lease_until`,
          [
            existing.id,
            new Date(input.now.getTime() + input.leaseSeconds * 1000).toISOString(),
          ]
        );
        if (updated.rowCount !== 1) {
          const current = await this.readById(tx, existing.id);
          return { action: 'exhausted', job: current ?? existing };
        }
        return { action: 'owned', job: rowToJob(updated.rows[0]) };
      }
      if (decision === 'ambiguous' && existing.state !== 'ambiguous') {
        const updated = await tx.query(
          `UPDATE grok_worker_jobs
           SET state = 'ambiguous',
               last_error = COALESCE(last_error, $2),
               updated_at = now()
           WHERE id = $1
             AND state IN ('queued', 'claimed', 'generating', 'posting')
           RETURNING id, team_id, idempotency_key, state, attempt, max_attempts,
                     payload, result, last_error, lease_until`,
          [existing.id, 'Lease expired before the outcome was known']
        );
        if (updated.rowCount === 1) {
          return { action: 'ambiguous', job: rowToJob(updated.rows[0]) };
        }
      }
      return { action: decision, job: existing };
    });
  }

  async claimQueued(leaseSeconds: number): Promise<JobRecord | null> {
    const result = await this.sql.query(CLAIM_QUEUED_SQL, [leaseSeconds]);
    if (result.rowCount !== 1) {
      return null;
    }
    return rowToJob(result.rows[0]);
  }

  async compareAndSet(
    id: string,
    from: JobState | JobState[],
    to: JobState,
    patch?: { result?: unknown; lastError?: string | null; leaseUntil?: string | null }
  ): Promise<JobRecord | null> {
    const allowed = Array.isArray(from) ? from : [from];
    const result = await this.sql.query(
      `UPDATE grok_worker_jobs
       SET state = $3,
           result = CASE WHEN $4::boolean THEN $5::jsonb ELSE result END,
           last_error = CASE WHEN $6::boolean THEN $7 ELSE last_error END,
           lease_until = CASE WHEN $8::boolean THEN $9::timestamptz ELSE lease_until END,
           updated_at = now()
       WHERE id = $1 AND state = ANY($2::text[])
       RETURNING id, team_id, idempotency_key, state, attempt, max_attempts,
                 payload, result, last_error, lease_until`,
      [
        id,
        allowed,
        to,
        patch !== undefined && 'result' in patch,
        patch && 'result' in patch ? JSON.stringify(patch.result ?? null) : null,
        patch !== undefined && 'lastError' in patch,
        patch && 'lastError' in patch ? patch.lastError : null,
        patch !== undefined && 'leaseUntil' in patch,
        patch && 'leaseUntil' in patch ? patch.leaseUntil : null,
      ]
    );
    if (result.rowCount !== 1) {
      return null;
    }
    return rowToJob(result.rows[0]);
  }

  async get(teamId: string, idempotencyKey: string): Promise<JobRecord | null> {
    const result = await this.sql.query(
      `SELECT id, team_id, idempotency_key, state, attempt, max_attempts,
              payload, result, last_error, lease_until
       FROM grok_worker_jobs
       WHERE team_id = $1 AND idempotency_key = $2`,
      [teamId, idempotencyKey]
    );
    if (result.rowCount !== 1) {
      return null;
    }
    return rowToJob(result.rows[0]);
  }

  private async readById(tx: SqlClient, id: string): Promise<JobRecord | null> {
    const result = await tx.query(
      `SELECT id, team_id, idempotency_key, state, attempt, max_attempts,
              payload, result, last_error, lease_until
       FROM grok_worker_jobs WHERE id = $1`,
      [id]
    );
    return result.rowCount === 1 ? rowToJob(result.rows[0]) : null;
  }
}

export class PostgresCacheStore {
  private readonly sql: SqlClient;

  constructor(sql: SqlClient) {
    this.sql = sql;
  }

  async get(cacheKey: string, teamId: string): Promise<string | null> {
    const result = await this.sql.query(
      `SELECT output_text FROM grok_worker_cache
       WHERE cache_key = $1 AND team_id = $2`,
      [cacheKey, teamId]
    );
    if (result.rowCount !== 1) {
      return null;
    }
    return String(result.rows[0].output_text);
  }

  async put(input: {
    cacheKey: string;
    teamId: string;
    promptVersion: string;
    model: string;
    outputText: string;
  }): Promise<void> {
    await this.sql.query(
      `INSERT INTO grok_worker_cache
         (cache_key, team_id, prompt_version, model_id, output_text)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cache_key) DO NOTHING`,
      [
        input.cacheKey,
        input.teamId,
        input.promptVersion,
        input.model,
        input.outputText,
      ]
    );
  }
}

export async function createPgClient(databaseUrl: string): Promise<{
  sql: SqlClient;
  close: () => Promise<void>;
}> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: 10_000,
  });
  const sql = poolToSql(pool);
  await ensureSchema(sql);
  return {
    sql,
    close: async () => {
      await pool.end();
    },
  };
}

export function poolToSql(pool: pg.Pool): SqlClient {
  return {
    query: async (text, params) => toResult(await pool.query(text, params as never[])),
    transaction: async (fn) => {
      const client = await pool.connect();
      const tx = clientToSql(client);
      try {
        await client.query('BEGIN');
        const value = await fn(tx);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function clientToSql(client: pg.PoolClient): SqlClient {
  return {
    query: async (text, params) => toResult(await client.query(text, params as never[])),
    transaction: async (fn) => fn(clientToSql(client)),
  };
}

function toResult(result: pg.QueryResult): SqlQueryResult {
  return {
    rows: result.rows as Record<string, unknown>[],
    rowCount: result.rowCount ?? 0,
  };
}
