// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { MAX_OUTPUT_CHARS } from './config.ts';

const idPattern = /^[A-Za-z0-9._:-]+$/;

export const briefSchema = z
  .object({
    teamId: z.string().min(1).max(128).regex(idPattern),
    idempotencyKey: z.string().min(1).max(200).regex(idPattern),
    brief: z.string().trim().min(1).max(4000),
    integrationId: z.string().min(1).max(128).regex(idPattern),
    draftDate: z.string().datetime({ offset: true }),
    settings: z.record(z.string(), z.unknown()).default({}),
    tags: z
      .array(
        z.object({
          value: z.string().min(1).max(100),
          label: z.string().min(1).max(100),
        })
      )
      .max(20)
      .default([]),
  })
  .strict();

export type Brief = z.infer<typeof briefSchema>;

export const draftPayloadSchema = z
  .object({
    type: z.literal('draft'),
    shortLink: z.literal(false),
    date: z.string().datetime({ offset: true }),
    tags: z.array(
      z.object({
        value: z.string(),
        label: z.string(),
      })
    ),
    posts: z
      .array(
        z
          .object({
            integration: z.object({ id: z.string().min(1) }).strict(),
            value: z
              .array(
                z
                  .object({
                    content: z.string().min(1).max(MAX_OUTPUT_CHARS),
                    image: z.array(z.unknown()).max(0),
                  })
                  .strict()
              )
              .length(1),
            settings: z.record(z.string(), z.unknown()),
          })
          .strict()
      )
      .length(1),
  })
  .strict();

export type DraftPayload = z.infer<typeof draftPayloadSchema>;

export function parseBrief(input: unknown): Brief {
  const parsed = briefSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `Brief rejected: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'brief'}: ${issue.message}`)
        .join('; ')}`
    );
  }
  const encoded = JSON.stringify(parsed.data.settings);
  if (encoded.length > 16_384) {
    throw new Error('Brief rejected: settings JSON exceeds 16384 bytes');
  }
  return parsed.data;
}

export function buildDraftPayload(brief: Brief, content: string): DraftPayload {
  if (content.length < 1 || content.length > MAX_OUTPUT_CHARS) {
    throw new Error(
      `Draft text must be 1..${MAX_OUTPUT_CHARS} characters`
    );
  }
  const payload = {
    type: 'draft' as const,
    shortLink: false as const,
    date: brief.draftDate,
    tags: brief.tags,
    posts: [
      {
        integration: { id: brief.integrationId },
        value: [{ content, image: [] as unknown[] }],
        settings: brief.settings,
      },
    ],
  };
  return draftPayloadSchema.parse(payload);
}

export function assertDraftOnly(payload: { type?: string }): void {
  if (payload.type !== 'draft') {
    throw new Error('Refusing to build a payload whose type is not draft');
  }
}
