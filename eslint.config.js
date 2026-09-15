import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

/**
 * ESLint flat config for the terminal bundle.
 *
 * The rule set is the type-aware `recommendedTypeChecked` family: this package
 * drives durable sessions through async service boundaries, so promise and
 * `any`-flow mistakes are exactly the class of bug worth failing a gate on.
 * One project (`tsconfig.test.json`) contains every linted TypeScript file —
 * `src`, `tests`, `scripts`, and the root `*.config.ts` — so the type-aware
 * pass resolves each file exactly once.
 *
 * Deliberately absent: formatting rules. The repository keeps its own style
 * (no semicolons, single quotes) and formatting is not a lint concern here.
 */
export default tseslint.config(
  {
    // Build output, coverage reports, and vendored trees are never linted.
    // The flat config file itself is outside every TypeScript project, so the
    // type-aware parser cannot resolve it.
    ignores: ['lib/**', 'coverage/**', 'dist/**', 'node_modules/**', 'eslint.config.js'],
  },
  {
    // The Ink tree is the whole product surface; a hook called conditionally
    // or from the wrong scope corrupts frames in ways tests rarely catch.
    // `exhaustive-deps` stays a warning because three call sites disable it
    // deliberately (they pin a stable snapshot the rule cannot see).
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Every durable write is an async call whose rejection must be handled;
      // an unawaited one loses the failure silently.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      // Type-only imports keep the runtime graph honest.
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      // `==` hides the null/undefined distinction the projection relies on.
      eqeqeq: ['error', 'always'],
      // The TUI owns stdout through Ink; a stray console write tears a frame.
      'no-console': 'error',
      // Underscore-prefixed names are the codebase's "deliberately unused"
      // marker (rest-omit siblings and ignored callback parameters), matching
      // the `noUnusedLocals` contract the compiler already enforces.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    // Specs fake whole Harness services and drive fixtures through
    // deliberately loose shapes, so three rules fight that style without
    // catching product bugs here:
    //  - `require-await`: an async test double returns a promise by contract;
    //    whether it awaits internally is noise (587 sites asked for this).
    //  - `no-unsafe-*`: every site reads a hand-built double whose `any` is the
    //    point of the fixture.
    // `tsconfig.test.json` is what keeps fixtures structurally honest — a
    // double that drifts from the interface it fakes now fails typecheck.
    // Everything else still applies to specs, including unbound methods,
    // floating promises, unused vars, and every assertion-shape rule.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Specs capture operator-facing output by stubbing console themselves;
      // that is the assertion mechanism, not a stray write into Ink's frame.
      'no-console': 'off',
    },
  },
  {
    // The launcher and the whale generator are operator-facing scripts: they
    // report progress on stdout by design, and the launcher is plain
    // JavaScript outside every TypeScript project, so the type-aware rules
    // (which need a program entry) do not apply to it.
    files: ['bin/**/*.mjs', 'scripts/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
    },
  },
)
