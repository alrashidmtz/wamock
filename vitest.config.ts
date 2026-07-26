import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // Process wiring; exercised end-to-end against a real CLI run rather
        // than unit-tested.
        'src/cli.ts',
        // Type-only modules. They contain no executable statements, so a 0%
        // reading is noise rather than a gap.
        'src/core/types.ts',
        'src/core/context.ts',
      ],
      reporter: ['text', 'html'],
      // Spec §13.4: the mock's own core must be ≥90% covered. These are the
      // load-bearing modules — a regression here silently lies to every
      // integrator testing against wamock.
      thresholds: {
        'src/core/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'src/errors/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'src/webhooks/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
})
