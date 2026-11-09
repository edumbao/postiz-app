import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { loadConfig } from '../src/config.ts';
import { AmbiguousOutcome } from '../src/errors.ts';
import { mockDraftText } from '../src/mock-generator.ts';
import {
  PostgresBudgetStore,
  PostgresCacheStore,
  PostgresJobStore,
} from '../src/postgres.ts';
import { runBrief, type RunDeps } from '../src/run-brief.ts';
import { ensureSchema, type SqlClient } from '../src/sql.ts';

async function createSql(): Promise<SqlClient> {
  const db = new PGlite();
  const adapt = (queryable: {
    query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>;
  }): SqlClient => ({
    query: async (text, params) => {
      const result = await queryable.query(text, params);
      const rows = result.rows as Record<string, unknown>[];
      return {
        rows,
        rowCount: rows.length > 0 ? rows.length : result.affectedRows ?? 0,
      };
    },
    transaction: async (fn) =>
      db.transaction(async (tx) => fn(adapt(tx))),
  });
  const sql = adapt(db);
  await ensureSchema(sql);
  return sql;
}

function liveConfig() {
  return loadConfig({
    GROK_WORKER_MODE: 'live',
    GROK_WORKER_STORE: 'postgres',
    GROK_WORKER_ENABLE_NETWORK: 'true',
    GROK_WORKER_DATABASE_URL: 'postgresql://grok_worker:secret@127.0.0.1:5432/grok_worker',
    GROK_WORKER_XAI_MODEL: 'configured-by-operator',
    GROK_WORKER_XAI_API_KEY: 'test-xai-key',
    GROK_WORKER_MAX_OUTPUT_TOKENS: '200',
    GROK_WORKER_UNITS_PER_CALL: '4',
    GROK_WORKER_BUDGET_UNITS: '10',
    GROK_WORKER_BUDGET_PERIOD: 'period-a',
    GROK_WORKER_POSTIZ_BASE_URL: 'http://postiz:5000/api',
    GROK_WORKER_POSTIZ_API_KEY: 'test-postiz-key',
    GROK_WORKER_MAX_ATTEMPTS: '3',
  });
}

const baseBrief = {
  teamId: 'example-team',
  brief: 'Write a short internal draft about a product update.',
  integrationId: 'example-integration',
  draftDate: '2026-12-01T12:00:00.000Z',
  settings: { who_can_reply_post: 'everyone' },
  tags: [],
};

describe('postgres budget and idempotency', () => {
  it('applies the atomic reservation predicate under overlapping calls', async () => {
    const sql = await createSql();
    const budget = new PostgresBudgetStore(sql);
    assert.equal(budget.durable, true);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        budget.reserve('example-team', 'period-a', 10, 4)
      )
    );
    assert.equal(results.filter((item) => item === 'reserved').length, 2);
    assert.equal(results.filter((item) => item === 'exceeded').length, 3);
    const row = await sql.query(
      'SELECT reserved_units FROM grok_worker_budget WHERE team_id = $1',
      ['example-team']
    );
    assert.equal(Number(row.rows[0].reserved_units), 8);
  });

  it('does not create a second draft after an ambiguous Postiz timeout', async () => {
    const sql = await createSql();
    let deliveries = 0;
    const deps: RunDeps = {
      config: liveConfig(),
      jobs: new PostgresJobStore(sql),
      budget: new PostgresBudgetStore(sql),
      cache: new PostgresCacheStore(sql),
      generate: async (text) => mockDraftText(text),
      deliver: async () => {
        deliveries += 1;
        throw new AmbiguousOutcome('timed out after the request was sent');
      },
    };
    const brief = { ...baseBrief, idempotencyKey: 'ambiguous-1' };
    const first = await runBrief(brief, deps);
    const second = await runBrief(brief, deps);
    assert.equal(first.status, 'ambiguous');
    assert.equal(second.status, 'ambiguous');
    assert.equal(deliveries, 1);
    const row = await sql.query(
      'SELECT reserved_units FROM grok_worker_budget WHERE team_id = $1',
      ['example-team']
    );
    assert.equal(Number(row.rows[0].reserved_units), 4);
  });

  it('stops live generation when the durable cap is exhausted', async () => {
    const sql = await createSql();
    let generations = 0;
    const deps: RunDeps = {
      config: liveConfig(),
      jobs: new PostgresJobStore(sql),
      budget: new PostgresBudgetStore(sql),
      cache: new PostgresCacheStore(sql),
      generate: async (text) => {
        generations += 1;
        return mockDraftText(text);
      },
      deliver: async () => ({ postIds: ['example-post'] }),
    };
    const results = [];
    for (let index = 0; index < 3; index += 1) {
      results.push(
        await runBrief(
          {
            ...baseBrief,
            idempotencyKey: `cap-${index}`,
            brief: `Write internal draft number ${index} about a product update.`,
          },
          deps
        )
      );
    }
    assert.equal(generations, 2);
    assert.equal(results.filter((item) => item.status === 'completed').length, 2);
    assert.equal(results.filter((item) => item.status === 'budget-exceeded').length, 1);
    const completed = results.find((item) => item.status === 'completed');
    if (completed?.status === 'completed') {
      assert.equal(completed.delivery, 'draft-created');
      assert.deepEqual(completed.postIds, ['example-post']);
      assert.equal(completed.draft.type, 'draft');
    }
  });
});
