// SPDX-License-Identifier: AGPL-3.0-only

export const RESERVE_BUDGET_SQL = `
INSERT INTO grok_worker_budget (team_id, period_key, cap_units, reserved_units)
VALUES ($1, $2, $3, $4)
ON CONFLICT (team_id, period_key) DO UPDATE
SET cap_units = EXCLUDED.cap_units,
    reserved_units = grok_worker_budget.reserved_units + EXCLUDED.reserved_units
WHERE grok_worker_budget.reserved_units + EXCLUDED.reserved_units <= EXCLUDED.cap_units
RETURNING reserved_units
`.trim();

export const RELEASE_BUDGET_SQL = `
UPDATE grok_worker_budget
SET reserved_units = reserved_units - $3
WHERE team_id = $1
  AND period_key = $2
  AND reserved_units >= $3
RETURNING reserved_units
`.trim();

export interface BudgetRow {
  reserved: number;
  cap: number;
}

export function applyReserve(
  reserved: number,
  cap: number,
  cost: number
): number | null {
  if (!Number.isSafeInteger(cost) || cost < 1) {
    throw new Error('Budget cost must be a positive integer');
  }
  if (!Number.isSafeInteger(reserved) || !Number.isSafeInteger(cap)) {
    throw new Error('Budget counters must be integers');
  }
  if (reserved + cost > cap) {
    return null;
  }
  return reserved + cost;
}

export interface BudgetStore {
  readonly durable: boolean;
  reserve(
    teamId: string,
    periodKey: string,
    capUnits: number,
    cost: number
  ): Promise<'reserved' | 'exceeded'>;
  release(teamId: string, periodKey: string, cost: number): Promise<void>;
}

export class MemoryBudgetStore implements BudgetStore {
  readonly durable = false;
  private readonly rows = new Map<string, BudgetRow>();
  private readonly chains = new Map<string, Promise<unknown>>();

  private lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.chains.set(
      key,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  reserve(
    teamId: string,
    periodKey: string,
    capUnits: number,
    cost: number
  ): Promise<'reserved' | 'exceeded'> {
    const key = `${teamId}\0${periodKey}`;
    return this.lock(key, async () => {
      const current = this.rows.get(key) ?? { reserved: 0, cap: capUnits };
      current.cap = capUnits;
      const next = applyReserve(current.reserved, current.cap, cost);
      if (next === null) {
        this.rows.set(key, current);
        return 'exceeded';
      }
      current.reserved = next;
      this.rows.set(key, current);
      return 'reserved';
    });
  }

  release(teamId: string, periodKey: string, cost: number): Promise<void> {
    const key = `${teamId}\0${periodKey}`;
    return this.lock(key, async () => {
      const current = this.rows.get(key);
      if (!current || current.reserved < cost) {
        throw new Error('Budget release failed');
      }
      current.reserved -= cost;
      this.rows.set(key, current);
    });
  }

  snapshot(teamId: string, periodKey: string): BudgetRow | undefined {
    return this.rows.get(`${teamId}\0${periodKey}`);
  }
}
