import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  // V3-P7 — `@storybook/addon-a11y` adds an axe-core panel in the Storybook
  // UI and (paired with `@storybook/test-runner`) provides the headless CI
  // gate that runs every story through axe with zero-violations enforcement.
  // The companion `parameters.a11y.test: 'error'` setting in preview.tsx
  // turns runtime violations into test failures.
  addons: ['@storybook/addon-a11y'],
  framework: '@storybook/react-vite',
}
export default config
