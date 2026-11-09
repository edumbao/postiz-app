// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import { startHealthServer } from './health.ts';
import { pollLoop } from './poll.ts';
import { draftsFromJobs } from './preview.ts';
import { enqueueBrief, runBrief } from './run-brief.ts';
import { createRuntime } from './runtime.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function main(): Promise<number> {
  const briefPath = arg('--brief');
  const enqueuePath = arg('--enqueue');
  const poll = process.argv.includes('--poll');
  const selected = [briefPath, enqueuePath, poll ? 'poll' : undefined].filter(Boolean);
  if (selected.length !== 1) {
    process.stderr.write('Use one of --brief <file>, --enqueue <file>, or --poll\n');
    return 1;
  }

  const runtime = await createRuntime();
  try {
    if (briefPath) {
      const raw = JSON.parse(await readFile(briefPath, 'utf8'));
      const result = await runBrief(raw, runtime.deps);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status === 'completed') return 0;
      if (result.status === 'ambiguous') return 2;
      return 3;
    }
    if (enqueuePath) {
      const raw = JSON.parse(await readFile(enqueuePath, 'utf8'));
      const result = await enqueueBrief(raw, runtime.deps);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    if (runtime.config.seedBrief) {
      const raw = JSON.parse(await readFile(runtime.config.seedPath, 'utf8'));
      await enqueueBrief(raw, runtime.deps);
    }
    const server = await startHealthServer({
      host: runtime.config.bindHost,
      port: runtime.config.healthPort,
      preview: runtime.config.preview,
      listDrafts: async () => draftsFromJobs(await runtime.deps.jobs.listCompleted(50)),
    });
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    await pollLoop(runtime.deps, controller.signal);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    return 0;
  } finally {
    await runtime.close();
  }
}

const isDirect = process.argv[1] && process.argv[1].endsWith('cli.ts');
if (isDirect) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'worker failed';
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
