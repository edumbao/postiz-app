// SPDX-License-Identifier: AGPL-3.0-only

export interface SqlQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<SqlQueryResult>;
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS grok_worker_meta (
     schema_version integer PRIMARY KEY,
     applied_at timestamptz NOT NULL DEFAULT now()
   )`,
  `INSERT INTO grok_worker_meta (schema_version)
   VALUES (1)
   ON CONFLICT (schema_version) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS grok_worker_budget (
     team_id text NOT NULL,
     period_key text NOT NULL,
     cap_units bigint NOT NULL CHECK (cap_units >= 0),
     reserved_units bigint NOT NULL CHECK (reserved_units >= 0),
     PRIMARY KEY (team_id, period_key),
     CHECK (reserved_units <= cap_units)
   )`,
  `CREATE TABLE IF NOT EXISTS grok_worker_jobs (
     id uuid PRIMARY KEY,
     team_id text NOT NULL,
     idempotency_key text NOT NULL,
     state text NOT NULL CHECK (state IN ('queued','claimed','generating','posting','completed','failed','ambiguous')),
     attempt integer NOT NULL CHECK (attempt >= 0),
     max_attempts integer NOT NULL CHECK (max_attempts >= 1),
     payload jsonb NOT NULL,
     result jsonb,
     last_error text,
     lease_until timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (team_id, idempotency_key)
   )`,
  `CREATE INDEX IF NOT EXISTS grok_worker_jobs_poll
     ON grok_worker_jobs (state, created_at)`,
  `CREATE TABLE IF NOT EXISTS grok_worker_cache (
     cache_key text PRIMARY KEY,
     team_id text NOT NULL,
     prompt_version text NOT NULL,
     model_id text NOT NULL,
     output_text text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
];

export const CLAIM_QUEUED_SQL = `
WITH next_job AS (
  SELECT id
  FROM grok_worker_jobs
  WHERE state = 'queued'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE grok_worker_jobs AS job
SET state = 'claimed',
    attempt = job.attempt + 1,
    lease_until = now() + make_interval(secs => $1),
    updated_at = now()
FROM next_job
WHERE job.id = next_job.id
RETURNING job.id, job.team_id, job.idempotency_key, job.state, job.attempt,
          job.max_attempts, job.payload, job.result, job.last_error, job.lease_until
`.trim();

export async function ensureSchema(sql: SqlClient): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await sql.query(statement);
  }
  const existing = await sql.query(
    'SELECT schema_version FROM grok_worker_meta ORDER BY schema_version DESC LIMIT 1'
  );
  const version = Number(existing.rows[0]?.schema_version ?? 0);
  if (version !== 1) {
    throw new Error(
      `grok_worker schema version ${version} is not supported by this worker`
    );
  }
}

export function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  throw new Error('Expected an integer from Postgres');
}
