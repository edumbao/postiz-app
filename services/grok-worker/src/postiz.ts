// SPDX-License-Identifier: AGPL-3.0-only

import { AmbiguousOutcome, RetryableOutcome } from './errors.ts';
import { assertDraftOnly, type DraftPayload } from './draft.ts';

const DRAFT_PATH = '/public/v1/posts';

export interface HttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export function postizDraftRequest(
  baseUrl: string,
  apiKey: string,
  payload: DraftPayload
): HttpRequest {
  assertDraftOnly(payload);
  if (!apiKey) {
    throw new Error('GROK_WORKER_POSTIZ_API_KEY is empty');
  }
  if (apiKey.toLowerCase().startsWith('bearer ')) {
    throw new Error(
      'Postiz public API auth is the raw Authorization value, not a Bearer prefix'
    );
  }
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/$/, '');
  url.pathname = `${basePath}${DRAFT_PATH}`;
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith(DRAFT_PATH)) {
    throw new Error('Refusing to call a Postiz URL that is not the draft posts route');
  }
  const forbidden = ['/status', '/release-id', '/schedule', '/now'];
  if (forbidden.some((part) => url.pathname.includes(part))) {
    throw new Error('Refusing a Postiz URL that can change publish state');
  }
  return {
    url: url.toString(),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify(payload),
  };
}

export function classifyHttpFailure(
  status: number,
  body: string
): AmbiguousOutcome | RetryableOutcome {
  if (status === 408 || status >= 500) {
    return new AmbiguousOutcome(
      `HTTP ${status} after the request was sent. The draft may exist. Body: ${body.slice(0, 300)}`
    );
  }
  return new RetryableOutcome(
    `HTTP ${status} rejected the draft. Body: ${body.slice(0, 300)}`
  );
}

export async function deliverDraft(input: {
  baseUrl: string;
  apiKey: string;
  payload: DraftPayload;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<{ postIds: string[] }> {
  const request = postizDraftRequest(input.baseUrl, input.apiKey, input.payload);
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown network error';
    throw new AmbiguousOutcome(
      `Postiz draft request did not finish cleanly: ${message}`
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw classifyHttpFailure(response.status, text);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AmbiguousOutcome('Postiz returned a non-JSON success body');
  }
  if (!Array.isArray(parsed)) {
    throw new AmbiguousOutcome('Postiz success body was not the expected array');
  }
  const postIds = parsed.map((item) => {
    if (!item || typeof item !== 'object' || !('postId' in item)) {
      throw new AmbiguousOutcome('Postiz success item had no postId');
    }
    return String((item as { postId: unknown }).postId);
  });
  return { postIds };
}
