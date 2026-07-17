// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        // This config file is not part of tsconfig's `include`, so type-aware
        // linting needs it declared as a default project or eslint errors on itself.
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Credentials must never reach logs (CLAUDE.md hard rule 3); allow console
      // only through the logging helpers, not ad-hoc across the pipeline.
      'no-console': ['warn', { allow: ['error'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The CLI is a console program by definition.
    files: ['src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
)
