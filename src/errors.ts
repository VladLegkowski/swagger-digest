/** Classification of fetch failures, used for fail-fast decisions and reporting. */
export type FetchErrorKind = 'size' | 'blocked' | 'network' | 'http' | 'parse';

export class FetchError extends Error {
  readonly kind: FetchErrorKind;

  constructor(kind: FetchErrorKind, message: string) {
    super(message);
    this.name = 'FetchError';
    this.kind = kind;
  }
}

/** Response body exceeded the configured size cap. Fails fast. */
export class FetchSizeError extends FetchError {
  constructor(message: string) {
    super('size', message);
    this.name = 'FetchSizeError';
  }
}

/** Destination resolved to a disallowed (private/loopback) address. Fails fast. */
export class BlockedNetworkError extends FetchError {
  constructor(message: string) {
    super('blocked', message);
    this.name = 'BlockedNetworkError';
  }
}

/**
 * Network-level failure: DNS resolution, connection refused, timeout or an
 * aborted request. Fails fast — retrying fallback paths on a dead host is
 * pointless. Note this is not the same as an HTTP error status.
 */
export class FetchNetworkError extends FetchError {
  constructor(message: string) {
    super('network', message);
    this.name = 'FetchNetworkError';
  }
}

/** HTTP error status (4xx/5xx). Does NOT fail fast; other paths may still work. */
export class FetchHttpError extends FetchError {
  readonly status: number;

  constructor(message: string, status: number) {
    super('http', message);
    this.name = 'FetchHttpError';
    this.status = status;
  }
}

/** All error kinds that make further probing of the same host pointless. */
export function isFailFastFetchError(error: unknown): error is FetchError {
  return error instanceof FetchError && (error.kind === 'size' || error.kind === 'blocked' || error.kind === 'network');
}
