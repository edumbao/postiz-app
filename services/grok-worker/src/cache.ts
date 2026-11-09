// SPDX-License-Identifier: AGPL-3.0-only

export interface CacheStore {
  get(cacheKey: string, teamId: string): Promise<string | null>;
  put(input: {
    cacheKey: string;
    teamId: string;
    promptVersion: string;
    model: string;
    outputText: string;
  }): Promise<void>;
}

export class MemoryCacheStore implements CacheStore {
  private readonly rows = new Map<string, { teamId: string; outputText: string }>();

  async get(cacheKey: string, teamId: string): Promise<string | null> {
    const row = this.rows.get(cacheKey);
    if (!row || row.teamId !== teamId) {
      return null;
    }
    return row.outputText;
  }

  async put(input: {
    cacheKey: string;
    teamId: string;
    promptVersion: string;
    model: string;
    outputText: string;
  }): Promise<void> {
    if (!this.rows.has(input.cacheKey)) {
      this.rows.set(input.cacheKey, {
        teamId: input.teamId,
        outputText: input.outputText,
      });
    }
  }
}
