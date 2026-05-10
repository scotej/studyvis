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

// Primitives in src/components/ui/ may not import upward into application
// layers (DESIGN-SYSTEM.md §7 rule 2). The patterns use gitignore-style
// negation because ESLint's group glob is case-insensitive and a PascalCase
// vs kebab-case discriminator wouldn't work. We restrict the whole
// components/ tree and re-allow components/ui/.
const uiLayerImportRule = {
  patterns: [
    {
      group: ['@/components/**', '!@/components/ui', '!@/components/ui/**'],
      message:
        'src/components/ui/ may not import composed app components. Compose at a higher layer.',
    },
    {
      group: ['@/features/*', '@/features/**'],
      message:
        'src/components/ui/ may not import from features/. Pass behavior down via props or hooks.',
    },
    {
      group: ['@/stores/*', '@/stores/**'],
      message:
        'src/components/ui/ may not import from stores/. Primitives stay state-agnostic.',
    },
    {
      group: ['@/routes/*', '@/routes/**'],
      message:
        'src/components/ui/ may not import from routes/. Routes are top-level composition.',
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
      'no-restricted-imports': ['error', uiLayerImportRule],
      'react-refresh/only-export-components': 'off',
    },
  },
  ...storybook.configs['flat/recommended'],
  prettier,
])
