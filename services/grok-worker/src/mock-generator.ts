// SPDX-License-Identifier: AGPL-3.0-only

import { PROMPT_VERSION } from './config.ts';

export function mockDraftText(brief: string): string {
  return `Draft (${PROMPT_VERSION}): ${brief.trim()}`;
}
