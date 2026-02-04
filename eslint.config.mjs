import * as path from 'path';
import { fileURLToPath } from 'url';

// Calculate current directory for proper file path resolution
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import the modules from our CommonJS compatibility wrapper
const compat = await import(`${__dirname}/eslint-compat.cjs`);
const js = compat.default.js;
const ts = compat.default.ts;
const tsParser = compat.default.tsParser;
const prettier = compat.default.prettier;
const importPlugin = compat.default.importPlugin;
const pluginJest = compat.default.pluginJest;
const prettierPlugin = compat.default.prettierPlugin;
const simpleImportSort = compat.default.simpleImportSort;

// Recreate eslint:recommended
const eslintRecommended = js.configs.recommended;

// Recreate plugin:@typescript-eslint/recommended
const typescriptRecommended = {
  plugins: {
    '@typescript-eslint': ts,
  },
  rules: {
    ...ts.configs.recommended.rules,
  },
};

// Recreate plugin:import/errors, plugin:import/warnings, plugin:import/typescript
const importRules = {
  plugins: {
    import: importPlugin,
  },
  rules: {
    ...importPlugin.configs.errors.rules,
    ...importPlugin.configs.warnings.rules,
    ...importPlugin.configs.typescript.rules,
  },
};

// Recreate plugin:prettier/recommended
const prettierRecommended = {
  plugins: {
    prettier: prettierPlugin,
  },
  rules: {
    'prettier/prettier': 'error',
    ...prettier.rules,
  },
};

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'eslint.config.mjs', 'eslint-compat.cjs', '**/*commitlint.config.js'],
  },
  {
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
        },
      },
    },
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      parser: tsParser,
      globals: {
        // Browser environment
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        TextEncoder: 'readonly',
        AbortController: 'readonly',
      },
    },
  },
  {
    files: ['tests/**/*.ts'],
    plugins: {
      jest: pluginJest,
    },
    languageOptions: {
      globals: pluginJest.environments.globals.globals,
    },
    rules: {
      'jest/no-disabled-tests': 'warn',
      'jest/no-focused-tests': 'error',
      'jest/no-identical-title': 'error',
      'jest/prefer-to-have-length': 'warn',
      'jest/valid-expect': 'error',
    },
  },
  // Include all the extended configs
  eslintRecommended,
  typescriptRecommended,
  importRules,
  prettierRecommended,
  prettier, // Additional prettier config
  {
    // Plugin and rule configurations
    plugins: {
      '@typescript-eslint': ts,
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            ['^@?\\w'], // Packages
            ['^\\u0000'], // Side effect imports
            ['^\\.\\.(?!/?$)', '^\\.\\./?$'], // Parent imports
            ['^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$'], // Other relative imports
            ['^.+\\.?(css)$'], // Style imports
          ],
        },
      ],
    },
  },
];
