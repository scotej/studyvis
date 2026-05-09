import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import storybook from 'eslint-plugin-storybook'
import prettier from 'eslint-config-prettier/flat'
import { defineConfig, globalIgnores } from 'eslint/config'

const radixImportRule = {
  patterns: [
    {
      group: ['radix-ui', '@radix-ui/*'],
      message:
        'Radix imports are only allowed in src/components/ui/. Compose primitives from there.',
    },
  ],
}

const inlineHexStyleRule = {
  selector:
    "JSXAttribute[name.name='style'] Literal[value=/#[0-9a-fA-F]{3,8}\\b/]",
  message:
    'Raw hex in inline style is forbidden. Use a token-derived class or a CSS variable from src/design/tokens.ts.',
}

export default defineConfig([
  globalIgnores([
    'dist',
    'storybook-static',
    'src-tauri/target',
    'src-tauri/gen',
    'node_modules',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'no-restricted-imports': ['error', radixImportRule],
      'no-restricted-syntax': ['error', inlineHexStyleRule],
    },
  },
  {
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
      'react-refresh/only-export-components': 'off',
    },
  },
  ...storybook.configs['flat/recommended'],
  prettier,
])
