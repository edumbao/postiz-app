// SPDX-License-Identifier: AGPL-3.0-only

import type { JobRecord } from './jobs.ts';

export interface PreviewDraft {
  teamId: string;
  idempotencyKey: string;
  text: string;
  delivery: string;
  payloadJson: string;
}

export function draftsFromJobs(jobs: JobRecord[]): PreviewDraft[] {
  return jobs
    .filter((job) => job.state === 'completed')
    .map((job) => {
      const result = job.result;
      if (result && typeof result === 'object') {
        const record = result as {
          text?: unknown;
          delivery?: unknown;
          draft?: unknown;
        };
        return {
          teamId: job.teamId,
          idempotencyKey: job.idempotencyKey,
          text: typeof record.text === 'string' ? record.text : '',
          delivery: typeof record.delivery === 'string' ? record.delivery : 'not-sent',
          payloadJson: JSON.stringify(record.draft ?? result, null, 2),
        };
      }
      return {
        teamId: job.teamId,
        idempotencyKey: job.idempotencyKey,
        text: '',
        delivery: 'not-sent',
        payloadJson: JSON.stringify(result),
      };
    });
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    if (character === '"') return '&quot;';
    return '&#39;';
  });
}

export function renderPreviewHtml(drafts: PreviewDraft[]): string {
  const cards = drafts.length
    ? drafts
        .map(
          (draft) => `<article>
  <h2>${escapeHtml(draft.idempotencyKey)}</h2>
  <p>Team <code>${escapeHtml(draft.teamId)}</code>. Delivery <code>${escapeHtml(draft.delivery)}</code>.</p>
  <h3>Mock draft text</h3>
  <pre>${escapeHtml(draft.text)}</pre>
  <h3>Draft payload that would be posted to Postiz</h3>
  <pre>${escapeHtml(draft.payloadJson)}</pre>
</article>`
        )
        .join('\n')
    : '<p>No mock drafts yet. The seed job may still be running. This page refreshes every 5 seconds.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="5">
  <title>Local mock draft preview</title>
  <style>
    body { font-family: sans-serif; margin: 2rem; line-height: 1.4; }
    .banner { background: #fff6d8; border: 1px solid #e0c36a; padding: 1rem; }
    pre { white-space: pre-wrap; background: #f4f4f4; padding: 1rem; }
    article { border-top: 1px solid #ccc; margin-top: 1.5rem; padding-top: 1rem; }
  </style>
</head>
<body>
  <h1>Local mock draft preview</h1>
  <div class="banner">
    <p>This is a local-only preview. It is not the Postiz product UI.</p>
    <p>Mock Grok wrote the text. The mock Postiz adapter stored the draft payload in this review database and did not send HTTP.</p>
    <p>Nothing was sent to xAI, Postiz, or a social network. Publishing, scheduling, and account connection are not available here.</p>
  </div>
  ${cards}
</body>
</html>`;
}
