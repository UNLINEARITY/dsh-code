import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/startup.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: 'esm',
  target: 'es2024',
  // Declarations come from the tsc step (lib/types); tsdown cleans outDir, so
  // it runs first and emits runtime bundles only.
  dts: false,
  // react/ink/chalk (dependencies) and every @deepseek-ai peer stay external;
  // the profile's node_modules resolves them at boot.
})
