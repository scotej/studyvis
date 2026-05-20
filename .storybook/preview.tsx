/* eslint-disable react-refresh/only-export-components */
// Storybook preview config; not part of the runtime build, so fast-refresh
// doesn't apply. Mixing the default `preview` export with the local
// `ThemedStoryFrame` component is intentional.
import type { Preview, Decorator } from '@storybook/react-vite'
import { useEffect } from 'react'
import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import '../src/design/index.css'

import { ThemeProvider } from '../src/design/theme'
import { tokens, lightTokens } from '../src/design/tokens'
import { useSettingsStore } from '../src/stores/settingsStore'

// V3-P5: theme toolbar so every story can be flipped between dark and light
// from the Storybook UI without hand-duplicating 55 story files. Drift between
// the two token maps is one click away on any story.
//
// The wrapper forces the settings-store theme to match the toolbar so
// `ThemeProvider` (which reads the store as its source of truth past
// hydration) resolves to the right map. Storybook isn't a Tauri runtime, so
// `useSettingsStore.hydrate()` resolves with DEFAULT_SETTINGS instantly; we
// then overwrite the value the toolbar dictates. `status: 'ready'` short-
// circuits the provider's `defaultMode` fallback.
function ThemedStoryFrame({
  theme,
  children,
}: {
  theme: 'dark' | 'light'
  children: React.ReactNode
}) {
  useEffect(() => {
    useSettingsStore.setState((s) => ({
      values: { ...s.values, theme },
      status: 'ready',
    }))
  }, [theme])
  return (
    <ThemeProvider defaultMode={theme}>
      {/* Wrapper inherits bg-bg-base so the canvas behind each story tracks
          the toolbar, independent of Storybook's own background addon. */}
      <div className="bg-bg-base p-4 text-text-primary">{children}</div>
    </ThemeProvider>
  )
}

const withTheme: Decorator = (Story, context) => {
  const theme = (context.globals.theme as 'dark' | 'light') ?? 'dark'
  return (
    <ThemedStoryFrame theme={theme}>
      <Story />
    </ThemedStoryFrame>
  )
}

const preview: Preview = {
  globalTypes: {
    theme: {
      name: 'Theme',
      description: 'Token map applied by ThemeProvider',
      defaultValue: 'dark',
      toolbar: {
        icon: 'paintbrush',
        items: [
          { value: 'dark', title: 'Dark' },
          { value: 'light', title: 'Light' },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    backgrounds: {
      default: 'dark',
      values: [
        { name: 'dark', value: tokens.color.bg.base },
        { name: 'light', value: lightTokens.color.bg.base },
      ],
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    // V3-P7 — `@storybook/addon-a11y` axe-core integration. `test: 'error'`
    // turns any violation into a `test-storybook` failure in CI; the panel
    // in the dev Storybook UI shows them while developing. Element scope
    // ('#storybook-root') keeps Storybook's own chrome out of the audit.
    a11y: {
      test: 'error',
      element: '#storybook-root',
    },
  },
  decorators: [withTheme],
}

export default preview
