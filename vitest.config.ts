import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Plain vitest for the engine's unit tests. The transfer engine imports two
// Workers *runtime* modules — `cloudflare:workers` (WorkflowEntrypoint) and
// `cloudflare:workflows` (NonRetryableError) — that don't resolve under plain
// node, so we alias them to minimal stubs (test/stubs/). This keeps the
// engine's production imports idiomatic (straight from the platform modules)
// while letting its pure logic be unit-tested here without spinning up workerd.
// Typecheck (tsc) still uses the real @cloudflare/workers-types declarations —
// the alias is runtime-only.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./test/stubs/cloudflare-workers.ts', import.meta.url)
      ),
      'cloudflare:workflows': fileURLToPath(
        new URL('./test/stubs/cloudflare-workflows.ts', import.meta.url)
      ),
    },
  },
});
