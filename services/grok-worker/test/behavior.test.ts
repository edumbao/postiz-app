import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { MemoryBudgetStore, RESERVE_BUDGET_SQL, applyReserve } from '../src/budget.ts';
import { MemoryCacheStore } from '../src/cache.ts';
import { loadConfig } from '../src/config.ts';
import { buildDraftPayload, parseBrief } from '../src/draft.ts';
import { RetryableOutcome } from '../src/errors.ts';
import { MemoryJobStore } from '../src/jobs.ts';
import { mockDraftText } from '../src/mock-generator.ts';
import { startHealthServer } from '../src/health.ts';
import { pollOnce } from '../src/poll.ts';
import { postizDraftRequest } from '../src/postiz.ts';
import { draftsFromJobs, renderPreviewHtml } from '../src/preview.ts';
import { enqueueBrief, runBrief, type RunDeps } from '../src/run-brief.ts';
import { CLAIM_QUEUED_SQL } from '../src/sql.ts';
import { buildXaiRequest, readXaiText } from '../src/xai.ts';

const brief = {
  teamId: 'example-team',
  idempotencyKey: 'example-brief-1',
  brief: 'Write a short internal draft about a product update.',
  integrationId: 'example-integration',
  draftDate: '2026-12-01T12:00:00.000Z',
  settings: {},
  tags: [],
};

function deps(overrides: Partial<RunDeps> = {}): RunDeps {
  const config = loadConfig({ GROK_WORKER_MODE: 'mock', GROK_WORKER_MAX_ATTEMPTS: '3' });
  return {
    config,
    jobs: new MemoryJobStore(),
    budget: new MemoryBudgetStore(),
    cache: new MemoryCacheStore(),
    generate: async (text) => mockDraftText(text),
    ...overrides,
  };
}

describe('payload and schema', () => {
  it('accepts the example brief and emits a draft-only payload', async () => {
    const example = JSON.parse(
      await readFile(new URL('../examples/brief.json', import.meta.url), 'utf8')
    );
    const parsed = parseBrief(example);
    const draft = buildDraftPayload(parsed, mockDraftText(parsed.brief));
    assert.equal(draft.type, 'draft');
    assert.equal(draft.shortLink, false);
    assert.equal(draft.posts[0].integration.id, 'example-integration');
    assert.equal(draft.posts[0].value[0].image.length, 0);
    assert.equal(JSON.stringify(draft).includes('"schedule"'), false);
    assert.equal(JSON.stringify(draft).includes('"now"'), false);
    assert.equal(JSON.stringify(draft).includes('republish'), false);
  });

  it('rejects unknown publish controls and oversized briefs', () => {
    assert.throws(() => parseBrief({ ...brief, type: 'schedule' }));
    assert.throws(() => parseBrief({ ...brief, brief: 'x'.repeat(4001) }));
    assert.throws(() => parseBrief({ ...brief, integrationId: '' }));
  });
});

describe('dry-run and mock delivery', () => {
  it('returns a validated draft and does not call Postiz or xAI', async () => {
    const original = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error('network was called');
    }) as typeof fetch;
    try {
      const result = await runBrief(brief, {
        ...deps({
          config: loadConfig({ GROK_WORKER_MODE: 'dry-run' }),
        }),
      });
      assert.equal(result.status, 'completed');
      if (result.status === 'completed') {
        assert.equal(result.delivery, 'not-sent');
        assert.equal(result.postIds.length, 0);
        assert.equal(result.draft.type, 'draft');
        assert.match(result.text, /^Draft \(phase1\.draft\.v1\):/);
      }
      assert.equal(fetches, 0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('duplicate jobs', () => {
  it('runs the generator once for the same idempotency key', async () => {
    let calls = 0;
    const shared = deps({
      generate: async (text) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return mockDraftText(text);
      },
    });
    const [first, second] = await Promise.all([
      runBrief(brief, shared),
      runBrief(brief, shared),
    ]);
    assert.equal(calls, 1);
    const completed = [first, second].filter((item) => item.status === 'completed');
    assert.equal(completed.length >= 1, true);
    const again = await runBrief(brief, shared);
    assert.equal(again.status, 'completed');
    assert.equal(calls, 1);
    if (again.status === 'completed' && completed[0].status === 'completed') {
      assert.equal(again.jobId, completed[0].jobId);
      assert.equal(again.draft.posts[0].value[0].content, completed[0].text);
    }
  });

  it('polls a queued brief once', async () => {
    let calls = 0;
    const shared = deps({
      generate: async (text) => {
        calls += 1;
        return mockDraftText(text);
      },
    });
    await enqueueBrief(brief, shared);
    assert.equal(await pollOnce(shared), true);
    assert.equal(await pollOnce(shared), false);
    assert.equal(calls, 1);
    const stored = await shared.jobs.get(brief.teamId, brief.idempotencyKey);
    assert.equal(stored?.state, 'completed');
  });
});

describe('retry bounds', () => {
  it('stops calling the generator after the configured attempts', async () => {
    let calls = 0;
    const shared = deps({
      config: loadConfig({ GROK_WORKER_MODE: 'mock', GROK_WORKER_MAX_ATTEMPTS: '2' }),
      generate: async () => {
        calls += 1;
        throw new RetryableOutcome('generator rejected the brief');
      },
    });
    const first = await runBrief(brief, shared);
    const second = await runBrief(brief, shared);
    const third = await runBrief(brief, shared);
    assert.equal(first.status, 'failed');
    assert.equal(second.status, 'failed');
    assert.equal(third.status, 'failed');
    assert.equal(calls, 2);
    if (third.status === 'failed') {
      assert.equal(third.attempts, 2);
    }
  });
});

describe('cost cap', () => {
  it('reserves with an in-process lock and stops at the cap', async () => {
    const budget = new MemoryBudgetStore();
    assert.equal(budget.durable, false);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => budget.reserve('example-team', 'period-a', 10, 4))
    );
    assert.deepEqual(
      results.filter((item) => item === 'reserved').length,
      2
    );
    assert.equal(results.filter((item) => item === 'exceeded').length, 3);
    assert.equal(budget.snapshot('example-team', 'period-a')?.reserved, 8);
    assert.equal(applyReserve(8, 10, 4), null);
  });
});

describe('local preview', () => {
  it('shows the mock draft and does not treat it as a Postiz send', async () => {
    const shared = deps();
    const hostile = {
      ...brief,
      idempotencyKey: 'example-preview-1',
      brief: '<script>alert(1)</script> product update',
    };
    const result = await runBrief(hostile, shared);
    assert.equal(result.status, 'completed');
    const html = renderPreviewHtml(draftsFromJobs(await shared.jobs.listCompleted(10)));
    assert.match(html, /Local mock draft preview/);
    assert.match(html, /did not send HTTP/);
    assert.match(html, /&lt;script&gt;alert/);
    assert.doesNotMatch(html, /<script>alert/);
    const server = await startHealthServer({
      host: '127.0.0.1',
      port: 0,
      preview: true,
      listDrafts: async () => draftsFromJobs(await shared.jobs.listCompleted(10)),
    });
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}/drafts.json`);
      const body = (await response.json()) as {
        publishing: boolean;
        drafts: Array<{ delivery: string; text: string }>;
      };
      assert.equal(body.publishing, false);
      assert.equal(body.drafts[0].delivery, 'not-sent');
      assert.match(body.drafts[0].text, /product update/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe('configuration', () => {
  it('defaults to mock and refuses publish, live-without-model, and live memory', () => {
    const config = loadConfig({});
    assert.equal(config.mode, 'mock');
    assert.equal(config.enableNetwork, false);
    assert.equal(config.allowPublish, false);
    assert.equal(config.xaiModel, null);
    assert.throws(
      () => loadConfig({ GROK_WORKER_ALLOW_PUBLISH: 'true' }),
      /cannot be enabled/
    );
    assert.throws(
      () =>
        loadConfig({
          GROK_WORKER_MODE: 'live',
          GROK_WORKER_PREVIEW: 'true',
          GROK_WORKER_STORE: 'postgres',
          GROK_WORKER_ENABLE_NETWORK: 'true',
        }),
      /PREVIEW cannot be combined with live mode/
    );
    assert.throws(
      () => loadConfig({ GROK_WORKER_BIND: '0.0.0.0' }),
      /only allowed when GROK_WORKER_PREVIEW=true/
    );
    assert.throws(
      () => loadConfig({ GROK_WORKER_MODE: 'live', GROK_WORKER_STORE: 'memory' }),
      /fail-closed/
    );
    assert.throws(
      () =>
        loadConfig({
          GROK_WORKER_MODE: 'live',
          GROK_WORKER_STORE: 'postgres',
          GROK_WORKER_ENABLE_NETWORK: 'true',
          GROK_WORKER_DATABASE_URL: 'postgresql://grok_worker:secret@127.0.0.1/grok_worker',
          GROK_WORKER_XAI_API_KEY: 'test-key',
          GROK_WORKER_MAX_OUTPUT_TOKENS: '200',
          GROK_WORKER_UNITS_PER_CALL: '1',
          GROK_WORKER_BUDGET_UNITS: '2',
          GROK_WORKER_BUDGET_PERIOD: 'period-a',
          GROK_WORKER_POSTIZ_BASE_URL: 'http://postiz:5000/api',
          GROK_WORKER_POSTIZ_API_KEY: 'test-postiz-key',
        }),
      /GROK_WORKER_XAI_MODEL/
    );
  });
});

describe('Postiz and xAI adapters', () => {
  it('builds only the public draft route with the raw API key', () => {
    const payload = buildDraftPayload(parseBrief(brief), 'Hello team');
    const request = postizDraftRequest(
      'http://postiz:5000/api',
      'test-postiz-key',
      payload
    );
    assert.equal(request.method, 'POST');
    assert.equal(request.url, 'http://postiz:5000/api/public/v1/posts');
    assert.equal(request.headers.Authorization, 'test-postiz-key');
    assert.equal(request.headers.Authorization.startsWith('Bearer '), false);
    const body = JSON.parse(request.body);
    assert.equal(body.type, 'draft');
    assert.throws(() =>
      postizDraftRequest('http://postiz:5000/api', 'Bearer secret', payload)
    );
  });

  it('refuses to invent a model id and disables xAI search storage', () => {
    assert.throws(() =>
      buildXaiRequest({
        baseUrl: 'https://api.x.ai/v1',
        apiKey: 'test-key',
        model: null,
        maxOutputTokens: 200,
        brief: 'hello',
      })
    );
    const request = buildXaiRequest({
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'test-key',
      model: 'configured-by-operator',
      maxOutputTokens: 200,
      brief: 'hello',
    });
    assert.equal(request.body.model, 'configured-by-operator');
    assert.equal(request.body.store, false);
    assert.deepEqual(request.body.tools, []);
    assert.equal(request.body.search_parameters.mode, 'off');
    assert.equal(request.body.max_output_tokens, 200);
    assert.equal(
      readXaiText({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Hello team' }],
          },
        ],
      }),
      'Hello team'
    );
  });

  it('keeps the durable SQL predicates explicit', () => {
    assert.match(RESERVE_BUDGET_SQL, /reserved_units \+ EXCLUDED\.reserved_units <= EXCLUDED\.cap_units/);
    assert.match(CLAIM_QUEUED_SQL, /FOR UPDATE SKIP LOCKED/);
    assert.doesNotMatch(RESERVE_BUDGET_SQL, /price|usd/i);
  });
});
