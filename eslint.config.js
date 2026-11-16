// ESLint: правила стилю проєкту (див. CLAUDE.md) перевіряються автоматично.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.js'],
    rules: {
      // лише стрілочні функції: const name = (...) => {...}; класи (ApiError, BusyError) дозволені
      'no-restricted-syntax': [
        'error',
        { selector: 'FunctionDeclaration', message: 'Лише стрілочні функції: const name = (...) => {...}' },
        { selector: ':not(MethodDefinition) > FunctionExpression', message: 'Лише стрілочні функції: (...) => {...}' },
        // Node запускає TypeScript без компіляції (type stripping): enum і namespace там не працюють
        { selector: 'TSEnumDeclaration', message: 'enum не підтримується type stripping - масив `as const` + тип' },
        { selector: 'TSModuleDeclaration[kind!="global"]', message: 'namespace не підтримується type stripping' },
      ],
      'prefer-arrow-callback': 'error',
      '@typescript-eslint/parameter-properties': 'error',
      // _arg - свідомо невикористаний; ({ a, ...rest }) - відкидання полів
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  prettier,
);
