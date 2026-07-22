/* Test double for the `cloudflare:workers` runtime module (see the workflows
 * stub for why). The engine only imports one runtime value from here —
 * WorkflowEntrypoint, as a base class. It is never instantiated in unit tests
 * (orchestration is exercised through the pure `runTransfer` with a fake step),
 * so a bare base class is enough for the `extends` reference to resolve. */
export class WorkflowEntrypoint<Env = unknown, T = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
  // Present so the shape matches; real runs override it.
  run(_event: T, _step: unknown): Promise<unknown> {
    return Promise.reject(new Error('WorkflowEntrypoint.run stub called'));
  }
}
