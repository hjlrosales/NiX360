import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Lints the TypeScript sources shared by both processes and the Preact client.
// Generated output, the local database and supplied sample media are not source.
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'data/**', 'Testmedia/**', '.verify/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['web/public/sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: globals.serviceworker,
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['server/**/*.ts', 'web/**/*.ts', 'web/**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Cleanup paths deliberately ignore a failure from an already-closed
      // resource, so an empty catch block is intentional rather than a stub.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
