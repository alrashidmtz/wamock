import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'

export default [
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The virtual clock is the ONLY place allowed to read wall time. Every
    // other module must go through Clock.now() — otherwise the 24h window and
    // scheduled statuses become untestable (spec §4).
    files: ['src/**/*.ts'],
    ignores: ['src/core/clock.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: 'Use Clock.now() instead of Date.now() — see src/core/clock.ts.',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Use Clock.now() instead of new Date() — see src/core/clock.ts.',
        },
      ],
    },
  },
]
