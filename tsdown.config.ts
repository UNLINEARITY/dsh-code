import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/startup.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: 'esm',
  target: 'es2024',
  // Declarations come from the tsc step (lib/types); tsdown cleans outDir, so
  // it runs first and emits runtime bundles only.
  dts: false,
  // Ink conditionally imports react-devtools-core (devtools hook) without
  // declaring it as a hard dependency; keep that import external so the
  // bundler does not report an unresolved module for an optional runtime
  // path this package never enables.
  external: ['react-devtools-core'],
  deps: {
    // Ink/react/chalk and their transitive deps are bundled into lib to cut
    // boot-time module loading (es-toolkit alone is ~4000 files, and ink's
    // cold load measured ~0.8s); every @deepseek-ai peer and commander stay
    // external for the profile's node_modules to resolve at boot.
    alwaysBundle: ['ink', 'react', 'chalk'],
  },
})
