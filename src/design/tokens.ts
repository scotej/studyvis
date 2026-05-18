export const tokens = {
  color: {
    bg: {
      base: '#17130C',
      surface: '#211A11',
      raised: '#2B2317',
      sunk: '#100D08',
    },
    border: {
      subtle: '#332A1C',
      default: '#3F3422',
      strong: '#52442C',
    },
    text: {
      primary: '#F0EBE2',
      secondary: '#B0A99C',
      muted: '#7D766A',
      inverse: '#100D08',
    },
    accent: {
      default: '#F2B05A',
      hover: '#F8C079',
      active: '#D9974A',
      muted: '#7A5C32',
      ring: '#F2B05A66',
    },
    status: {
      focused: '#84B061',
      warning: '#EBC646',
      alerted: '#DC7860',
      offline: '#7D766A',
      online: '#84B061',
    },
    overlay: {
      scrim: '#0006',
      glass: '#211A11CC',
    },
  },

  font: {
    family: {
      sans: '"Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
    },
    size: {
      xs: 12,
      sm: 13,
      base: 14,
      md: 16,
      lg: 20,
      xl: 24,
      '2xl': 32,
    },
    weight: {
      regular: 400,
      medium: 500,
      semibold: 600,
    },
    lineHeight: {
      tight: 1.25,
      snug: 1.4,
      normal: 1.5,
    },
    letterSpacing: {
      tight: '-0.01em',
      normal: '0em',
      wide: '0.04em',
    },
  },

  space: {
    0: 0,
    1: 4,
    2: 8,
    3: 12,
    4: 16,
    5: 24,
    6: 32,
    7: 48,
    8: 64,
    9: 96,
  },

  radius: {
    none: 0,
    sm: 4,
    md: 8,
    lg: 12,
    xl: 16,
    full: 9999,
  },

  shadow: {
    none: 'none',
    sm: '0 1px 2px rgba(0,0,0,0.30)',
    md: '0 4px 12px rgba(0,0,0,0.40)',
    lg: '0 12px 32px rgba(0,0,0,0.50)',
    glow: '0 0 0 3px var(--accent-ring)',
  },

  motion: {
    duration: {
      instant: 0,
      fast: 150,
      base: 200,
      slow: 300,
      reveal: 450,
    },
    easing: {
      out: 'cubic-bezier(0.16, 1, 0.3, 1)',
      inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
      spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    },
  },

  zIndex: {
    base: 0,
    sticky: 10,
    dropdown: 100,
    popover: 200,
    overlay: 300,
    modal: 400,
    toast: 500,
    tooltip: 600,
    aiDialog: 700,
  },

  sizes: {
    contentMaxWidth: 1200,
    // Reading/list screens (Report, FriendsListView). DESIGN-SYSTEM §12 only
    // specifies a measure for settings/onboarding (contentMaxWidth: 1200); a
    // 1200-wide line length hurts readability on text-dense screens, so these
    // screens share one narrower measure instead of the page max.
    readingMaxWidth: 896,
    sidebarWidth: 280,
    auditPanelWidth: 320,
    videoTileMinHeight: 180,
    videoTileMaxHeight: 360,
  },
}

export type Tokens = typeof tokens

export const lightTokens: Tokens = {
  ...tokens,
  color: {
    ...tokens.color,
    bg: {
      base: '#FAF6EE',
      surface: '#FFFDF8',
      raised: '#F3EEE2',
      sunk: '#EBE4D5',
    },
    border: {
      subtle: '#E7E0D0',
      default: '#D8CFB9',
      strong: '#A89A7C',
    },
    text: {
      primary: '#1F1B12',
      secondary: '#5C5547',
      muted: '#857C6A',
      inverse: '#FFFDF8',
    },
    accent: { ...tokens.color.accent, default: '#A8691E', hover: '#945A1A' },
    status: {
      ...tokens.color.status,
      focused: '#5C8A4B',
      warning: '#9A7B1F',
      alerted: '#B5564B',
      online: '#5C8A4B',
    },
  },
}
