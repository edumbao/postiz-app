// SPDX-License-Identifier: AGPL-3.0-only

import { PROMPT_VERSION } from './config.ts';
import { AmbiguousOutcome, RetryableOutcome } from './errors.ts';
import { classifyHttpFailure } from './postiz.ts';

export interface XaiRequestBody {
  model: string;
  input: string;
  max_output_tokens: number;
  store: false;
  tools: [];
  search_parameters: { mode: 'off' };
}

export function buildPrompt(brief: string): string {
  return [
    `Prompt-Version: ${PROMPT_VERSION}`,
    'Write one social post draft for an internal team.',
    'Return only the post text.',
    'Do not say the post was published or scheduled.',
    'Brief:',
    brief,
  ].join('\n');
}

export function buildXaiRequest(input: {
  baseUrl: string;
  apiKey: string;
  model: string | null;
  maxOutputTokens: number | null;
  brief: string;
}): { url: string; method: 'POST'; headers: Record<string, string>; body: XaiRequestBody } {
  if (!input.model) {
    throw new Error(
      'GROK_WORKER_XAI_MODEL is required. This worker does not choose a model id.'
    );
  }
  if (input.maxOutputTokens === null) {
    throw new Error('GROK_WORKER_MAX_OUTPUT_TOKENS is required for a live call');
  }
  if (!input.apiKey) {
    throw new Error('GROK_WORKER_XAI_API_KEY is required for a live call');
  }
  const url = new URL(input.baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/responses`;
  url.search = '';
  url.hash = '';
  return {
    url: url.toString(),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: {
      model: input.model,
      input: buildPrompt(input.brief),
      max_output_tokens: input.maxOutputTokens,
      store: false,
      tools: [],
      search_parameters: { mode: 'off' },
    },
  };
}

export function readXaiText(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || !('output' in payload)) {
    throw new RetryableOutcome('xAI response had no output array');
  }
  const output = (payload as { output: unknown }).output;
  if (!Array.isArray(output)) {
    throw new RetryableOutcome('xAI output was not an array');
  }
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const message = item as { type?: unknown; content?: unknown };
    if (message.type !== 'message' || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'output_text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        chunks.push((part as { text: string }).text);
      }
    }
  }
  const text = chunks.join('\n').trim();
  if (!text) {
    throw new RetryableOutcome('xAI response did not include output_text');
  }
  return text;
}

export async function completeWithXai(input: {
  baseUrl: string;
  apiKey: string;
  model: string | null;
  maxOutputTokens: number | null;
  brief: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const request = buildXaiRequest(input);
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown network error';
    throw new AmbiguousOutcome(`xAI request did not finish cleanly: ${message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw classifyHttpFailure(response.status, text);
  }
  try {
    return readXaiText(JSON.parse(text));
  } catch (error) {
    if (error instanceof RetryableOutcome || error instanceof AmbiguousOutcome) {
      throw error;
    }
    throw new RetryableOutcome('xAI success body was not valid JSON');
  }
}
