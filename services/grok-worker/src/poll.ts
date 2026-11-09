// SPDX-License-Identifier: AGPL-3.0-only

import type { RunDeps } from './run-brief.ts';
import { runBrief } from './run-brief.ts';

export async function pollOnce(deps: RunDeps): Promise<boolean> {
  const job = await deps.jobs.nextQueued();
  if (!job) {
    return false;
  }
  try {
    await runBrief(job.payload, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'poll failure';
    await deps.jobs.compareAndSet(job.id, ['queued', 'claimed', 'generating', 'posting'], 'ambiguous', {
      lastError: message,
    });
  }
  return true;
}

export async function pollLoop(deps: RunDeps, signal: AbortSignal, intervalMs = 1000): Promise<void> {
  while (!signal.aborted) {
    const worked = await pollOnce(deps);
    if (signal.aborted) {
      return;
    }
    if (!worked) {
      await sleep(intervalMs, signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
