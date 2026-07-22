/* Test double for the `cloudflare:workflows` runtime module. The Workers
 * runtime provides this; plain-node vitest cannot resolve it, so vitest.config
 * aliases the specifier here. Only the runtime *values* the engine imports need
 * to exist — types come from @cloudflare/workers-types at typecheck time. */

// Mirrors the real class: `NonRetryableError extends Error`, so engine error
// classes that extend it (DriveAuthRevokedError, DriveFileGoneError) keep their
// prototype chain and `instanceof` works identically under test.
export class NonRetryableError extends Error {
  constructor(message: string, name?: string) {
    super(message);
    this.name = name ?? 'NonRetryableError';
  }
}
