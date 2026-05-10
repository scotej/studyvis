export const tokens = {
  color: {
    bg: {
      base: '#0F1115',
      surface: '#171A21',
      raised: '#1F232C',
      sunk: '#0B0D11',
    },
    border: {
      subtle: '#262A33',
      default: '#2E333D',
      strong: '#3A4150',
    },
    text: {
      primary: '#E5E7EB',
      secondary: '#9CA3AF',
      muted: '#6B7280',
      inverse: '#0F1115',
    },
    accent: {
      default: '#E8A87C',
      hover: '#F0B891',
      active: '#D89B6F',
      muted: '#7A5740',
      ring: '#E8A87C66',
    },
    status: {
      focused: '#7FB069',
      warning: '#E8C547',
      alerted: '#D9776A',
      offline: '#6B7280',
      online: '#7FB069',
    },
    overlay: {
      scrim: '#0006',
      glass: '#171A21CC',
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
      base: '#FAFAF7',
      surface: '#FFFFFF',
      raised: '#F4F4F0',
      sunk: '#EDEDE8',
    },
    border: {
      subtle: '#E5E5E0',
      default: '#D4D4CD',
      strong: '#9CA3AF',
    },
    text: {
      primary: '#0F1115',
      secondary: '#4B5563',
      muted: '#6B7280',
      inverse: '#FFFFFF',
    },
    accent: { ...tokens.color.accent, default: '#C97A4D', hover: '#B86A3D' },
    status: {
      ...tokens.color.status,
      focused: '#5C8A4B',
      warning: '#B89531',
      alerted: '#B5564B',
    },
  },
}
