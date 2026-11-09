// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import type { Brief } from './draft.ts';

export function contentCacheKey(input: {
  teamId: string;
  promptVersion: string;
  model: string;
  mode: string;
  brief: Pick<Brief, 'brief' | 'integrationId' | 'draftDate' | 'settings' | 'tags'>;
}): string {
  const canonical = JSON.stringify({
    teamId: input.teamId,
    promptVersion: input.promptVersion,
    model: input.model,
    mode: input.mode,
    brief: input.brief.brief,
    integrationId: input.brief.integrationId,
    draftDate: input.brief.draftDate,
    settings: input.brief.settings,
    tags: input.brief.tags,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
