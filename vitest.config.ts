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
  },
})
