import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

const sourceFiles = ['src/**/*.{ts,tsx}'];
const withSourceFiles = (configs) => configs.map((config) => ({ ...config, files: sourceFiles }));

export default tseslint.config(
  {
    ignores: ['coverage/**', 'dist/**', 'node_modules/**', '.tmp-*/**'],
  },
  {
    ...eslint.configs.recommended,
    files: sourceFiles,
  },
  ...withSourceFiles(tseslint.configs.strictTypeChecked),
  ...withSourceFiles(tseslint.configs.stylisticTypeChecked),
  {
    ...reactHooks.configs.flat['recommended-latest'],
    files: sourceFiles,
  },
  {
    ...reactRefresh.configs.vite,
    files: sourceFiles,
  },
  {
    files: sourceFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
    },
  },
);
