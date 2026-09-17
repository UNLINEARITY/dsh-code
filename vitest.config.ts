import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['tests/setup/env.ts'],
    env: {
      // Pin the color level across runners: the TTY suites were written
      // against colorless output, and supports-color otherwise resolves
      // differently per platform (TERM/dumb, CI heuristics).
      NO_COLOR: '1',
    },
    coverage: {
      provider: 'v8',
      // Both reporters: text for the local console, json-summary so a later
      // job can read totals without parsing the log.
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      // Measure the shipped sources only: the Ink tree is one entry point, the
      // render helpers are pure, and both are what the suite exercises.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/whale-glyph.ts'],
      // Conservative global floor from the measured Node 24 baseline
      // (83.51% lines/statements, 83.25% branches, 89.55% functions). The
      // margin avoids platform noise while preventing material regression.
      thresholds: {
        lines: 82,
        statements: 82,
        branches: 82,
        functions: 88,
      },
    },
  },
})
