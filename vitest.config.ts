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
      // A reporting baseline, not a gate: the suite predates coverage
      // instrumentation and adding a threshold would fail CI on day one. The
      // report is here to make the number visible and comparable per change.
      thresholds: undefined,
    },
  },
})
