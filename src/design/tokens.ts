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
      // Was #7D766A — fails WCAG AA (3.45:1 on bg-raised). Bumped a hair
      // lighter so timestamps, the kbd hint, and BipBackupPanel indices
      // clear 4.5:1 on every surface they sit on. Cleared by check-contrast.
      muted: '#9A8E80',
      inverse: '#100D08',
    },
    accent: {
      default: '#F2B05A',
      hover: '#F8C079',
      active: '#D9974A',
      // Was #7A5C32 — too dark to carry text-inverse at 4.5:1
      // (the ModelPicker "Gated" pill is `bg-accent-muted text-text-inverse`).
      // Light theme explicitly re-pins the original darker value (see
      // lightTokens) so the inverted text-inverse there stays legible.
      muted: '#A07043',
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
    // V3-P6 custom window chrome (opt-in). The TitleBar band height is shared
    // across platforms so the wordmark sits at the same vertical centre on
    // macOS (overlapped onto the system traffic-light area via
    // TitleBarStyle::Overlay) and Windows (a frameless top band with our own
    // min/restore/close cluster). 38 was picked to comfortably contain the
    // macOS traffic lights (≈14 px diameter, ~12 px top inset on Sonoma).
    titleBarHeight: 38,
    // Left inset on macOS reserved for the system traffic lights when the
    // custom chrome is on: 12 px left margin + 3 × 14 px buttons + 2 × 8 px
    // gaps + 12 px calm gap before the wordmark ≈ 78 px. Windows uses 0.
    titleBarMacInset: 78,
  },
}

export type Tokens = typeof tokens

// Light theme — first-class, not a fallback. Every text/background pairing
// here clears WCAG AA (verified by scripts/check-contrast.ts in both themes).
// Same hues as dark; lightness/saturation moved so the warm-honey palette
// still reads warm on a light canvas. Token shape mirrors :root.light in
// src/design/index.css (the runtime mechanism is CSS variables; this map is
// the JS-side source of truth for documentation and Storybook).
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
      // Darkened from #857C6A — original failed AA on every light surface.
      muted: '#665F50',
      inverse: '#FFFDF8',
    },
    accent: {
      ...tokens.color.accent,
      // Darkened from #A8691E so both the amber-pill + inverse-white text
      // pairing AND the `accent/15` tinted chip with `text-accent-default`
      // (AuditLogRow accent tone, Report event row) clear 4.5:1 on a light
      // canvas. Same hue, just turned down.
      default: '#8C5215',
      // Hover is one step darker than default (pressed-into-surface read).
      hover: '#774511',
      // Was inherited from dark (#D9974A) — far too light to carry inverse
      // text on a light canvas. Pinned darker than hover so the pressed
      // state still reads as the most-committed step.
      active: '#683C0E',
      // Re-pinned: dark `accent.muted` had to lighten to clear AA on dark
      // theme. Light theme needs the original darker brown so light
      // text-inverse stays legible on the "Gated" pill.
      muted: '#7A5C32',
      // Light accent at 40% alpha — the dark ring color (#F2B05A66) is
      // washed out over a light surface.
      ring: '#8C521566',
    },
    status: {
      ...tokens.color.status,
      // Each darkened until ≥4.5:1 as text on bg-surface (the worst case
      // for the audit-row + report event chips). Same hue families.
      focused: '#477036',
      warning: '#7D6314',
      alerted: '#A24238',
      online: '#477036',
    },
    overlay: {
      ...tokens.color.overlay,
      // Was inherited from dark (#211A11CC) — dark frosted band on the
      // VideoTile figcaption looked grimy under a light canvas. Light glass
      // at 80% alpha keeps the caption legible whether the video is dark or
      // (when the camera is off) the sunk surface shows through.
      glass: '#FFFDF8CC',
    },
  },
  shadow: {
    ...tokens.shadow,
    // Warm-canvas-tinted shadows at low alpha. Dark theme shadows
    // (rgba(0,0,0,0.30+)) look muddy on a near-white surface — these are
    // softened and tinted to match the warm palette without hue drift.
    sm: '0 1px 2px rgba(43, 35, 23, 0.10)',
    md: '0 4px 12px rgba(43, 35, 23, 0.12)',
    lg: '0 12px 32px rgba(43, 35, 23, 0.18)',
  },
}
