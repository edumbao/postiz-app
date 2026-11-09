// SPDX-License-Identifier: AGPL-3.0-only

export class AmbiguousOutcome extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousOutcome';
  }
}

export class RetryableOutcome extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableOutcome';
  }
}

export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerConfigError';
  }
}
