import type { Preview } from '@storybook/react-vite'
import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import '../src/design/index.css'

import { ThemeProvider } from '../src/design/theme'
import { tokens, lightTokens } from '../src/design/tokens'

const preview: Preview = {
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
  },
  decorators: [
    (Story) => (
      <ThemeProvider defaultMode="dark">
        <Story />
      </ThemeProvider>
    ),
  ],
}

export default preview
