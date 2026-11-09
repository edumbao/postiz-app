import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const composePath = new URL(
  '../../../deploy/internal/docker-compose.yml',
  import.meta.url
);
const examplePath = new URL('../../../deploy/internal/.env.example', import.meta.url);

describe('internal compose contract', () => {
  it('pins images, hides data services, and keeps the worker fail-closed', async () => {
    const compose = await readFile(composePath, 'utf8');
    const example = await readFile(examplePath, 'utf8');
    assert.doesNotMatch(compose, /:latest/);
    assert.doesNotMatch(compose, /^\s*-\s+\/var\/lib\/postgresql\/data\s*$/m);
    assert.doesNotMatch(compose, /^\s*-\s+\/var\/lib\/elasticsearch\/data\s*$/m);
    assert.match(compose, /postiz-postgres-data:\/var\/lib\/postgresql\/data/);
    assert.doesNotMatch(compose, /GROK_WORKER_PREVIEW/);
    assert.doesNotMatch(compose, /18081/);
    assert.match(compose, /postgres:17\.11-alpine@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac/);
    assert.match(compose, /postgres:16\.15-alpine@sha256:aa6cb33cf4c19c765cefcf48d96176258800870a9a1e930ad126200f9d825139/);
    assert.match(compose, /redis:7\.4\.12-alpine@sha256:c5d34a98396a4775e223c74e929162c35c5a2182901ba26b50ade939941ce14b/);
    assert.match(compose, /temporalio\/auto-setup:1\.28\.1@sha256:607d68caa111338d754771efb876c92dfcdae06d056e4530bb31cd0f37406e6a/);
    assert.match(compose, /TEMPORAL_NAMESPACE: default/);
    assert.match(compose, /DB: postgres12/);
    assert.match(compose, /GROK_WORKER_ENABLE_NETWORK: "false"/);
    assert.match(compose, /GROK_WORKER_ALLOW_PUBLISH: "false"/);
    assert.match(compose, /GROK_WORKER_MODE: "mock"/);
    assert.doesNotMatch(compose, /postiz-password|JWT_SECRET: ['"][^$]/);
    assert.match(compose, /\$\{POSTIZ_IMAGE:\?/);
    assert.match(compose, /127\.0\.0\.1:8080:8080/);
    assert.match(compose, /profiles: \["internal-ui"\]/);
    const published: string[] = [];
    let inPorts = false;
    for (const line of compose.split('\n')) {
      if (/^\s*ports:\s*$/.test(line)) {
        inPorts = true;
        continue;
      }
      if (inPorts && /^\s+-/.test(line)) {
        published.push(line.trim());
        continue;
      }
      if (inPorts && line.trim() !== '') {
        inPorts = false;
      }
    }
    assert.deepEqual(
      published.filter((line) => /5432:5432|6379:6379|7233:7233|9200:9200/.test(line)),
      []
    );
    assert.deepEqual(
      published.filter((line) => line.includes('8080')),
      ['- "127.0.0.1:8080:8080"']
    );
    for (const line of example.split('\n')) {
      if (!line.includes('=') || line.trim().startsWith('#')) {
        continue;
      }
      const [key, value] = line.split('=', 2);
      if (key === 'INTERNAL_BIND_ADDRESS') {
        assert.equal(value, '127.0.0.1');
        continue;
      }
      assert.equal(value, '', `${key} must not commit a value`);
    }
  });

  it('keeps the local review file on loopback without TLS or Temporal', async () => {
    const local = await readFile(
      new URL('../../../deploy/internal/docker-compose.local.yml', import.meta.url),
      'utf8'
    );
    assert.doesNotMatch(local, /:latest/);
    assert.match(local, /name: postiz-internal-local/);
    assert.match(local, /127\.0\.0\.1:18081:8787/);
    assert.match(local, /127\.0\.0\.1:15432:5432/);
    assert.match(local, /GROK_WORKER_MODE: "mock"/);
    assert.match(local, /GROK_WORKER_PREVIEW: "true"/);
    assert.match(local, /GROK_WORKER_SEED_BRIEF: "true"/);
    assert.match(local, /GROK_WORKER_ENABLE_NETWORK: "false"/);
    assert.match(local, /GROK_WORKER_ALLOW_PUBLISH: "false"/);
    assert.match(local, /context: \.\.\/\.\.\/services\/grok-worker/);
    assert.doesNotMatch(local, /temporal|elasticsearch|443:443|POSTIZ_IMAGE|tls\.crt/i);
    assert.doesNotMatch(local, /0\.0\.0\.0:/);
  });

  it('pins the upstream dashboard image on loopback 18080 without fixed container names', async () => {
    const dashboard = await readFile(
      new URL('../../../deploy/internal/docker-compose.dashboard.yml', import.meta.url),
      'utf8'
    );
    assert.doesNotMatch(dashboard, /:latest/);
    assert.doesNotMatch(dashboard, /container_name:/);
    assert.doesNotMatch(dashboard, /18081|15432|local-review-only/);
    assert.match(dashboard, /name: postiz-dashboard-local/);
    assert.match(dashboard, /127\.0\.0\.1:18080:5000/);
    assert.match(
      dashboard,
      /ghcr\.io\/gitroomhq\/postiz-app:v2\.25\.3@sha256:1e376ff2cb781022d528f171719cf174cf693a985a30cb40eefb13eae3ddda13/
    );
    assert.match(dashboard, /TEMPORAL_NAMESPACE: default/);
    assert.match(dashboard, /DB: postgres12/);
    assert.match(dashboard, /\$\{JWT_SECRET:\?/);
    assert.match(dashboard, /\$\{POSTGRES_PASSWORD:\?/);
    assert.doesNotMatch(dashboard, /ENABLE_ES/);
  });
});
