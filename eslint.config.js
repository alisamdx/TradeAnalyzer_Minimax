import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    // Build output, including the workspace packages' (06 §4). Flat-config
    // ignores are relative to this file, so the packages need their own entries.
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      'node_modules/**',
      'coverage/**',
      '.claude/**',
      // The workspace packages lint themselves, with their own configs — one
      // for a Node library, one for an Electron app with JSX. Linting them from
      // here as well reported their `console` and `JSX` as undefined variables
      // and made `eslint .` a hundred lines of noise, which is the one thing a
      // lint run must never be. `npm test` at the root runs each package's own.
      'packages/**'
    ]
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: { ...globals.node, ...globals.browser }
    },
    plugins: {
      '@typescript-eslint': tseslint,
      react,
      'react-hooks': reactHooks
    },
    settings: { react: { version: '18' } },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
      // Same reasoning as `no-unused-vars` above: the core rule is replaced by
      // the type-aware toolchain. `no-undef` cannot see TYPE space, so it reads
      // every type-only global as an undefined variable — `NodeJS.Timeout` in
      // `index.ts`, `ipc-agent.ts` and `batch-service.ts`. `globals.node` cannot
      // fix that, because it supplies runtime globals (`process`, `console`),
      // not the ambient `NodeJS` namespace. Disabling it for TypeScript is
      // typescript-eslint's own guidance: `tsc` already refuses an undefined
      // identifier and it checks both spaces. Left on, it was three permanent
      // errors each inviting a worse fix — rewriting a correct type annotation
      // to dodge a linter that should not have been reading it.
      'no-undef': 'off'
    }
  },
  {
    // `.cjs` as well as `.mjs`: an Electron main process launched by a script
    // must be CommonJS, because Electron 32 does not run a `.mjs` entry point —
    // it produces no output, no error and no exit (see CLAUDE.md). Leaving the
    // extension out of this glob reported every `require`, `process` and
    // `console` in such a file as undefined.
    files: ['scripts/**/*.{mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  prettier
];
