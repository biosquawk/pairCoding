import type { ApiError } from '../shared/protocol';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly currentVersion: number | null = null,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toJSON(requestId: string | null = null): ApiError {
    return { code: this.code, message: this.message, retryable: this.status === 503,
      requestId, currentVersion: this.currentVersion };
  }
}

export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
