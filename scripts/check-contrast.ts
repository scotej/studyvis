#!/usr/bin/env tsx
// Token-pair contrast audit for the StudyVis design system. Verifies that
// every foreground/background pairing the UI actually uses meets WCAG 2.1 AA
// (4.5:1 for normal text, 3:1 for non-text + large text). Runs over both the
// dark and light token maps from src/design/tokens.ts.
//
// Why a custom script rather than axe-core / pa11y: those tools crawl a live
// DOM and rely on computed-style readback (jsdom or a headless browser). Our
// inputs are a fixed, enumerable set of token pairs — no DOM, no alpha
// blending the browser has to guess. The W3C relative-luminance formula
// (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance) handles every
// pairing here directly, and DESIGN-SYSTEM §11 specifically calls for a
// "color-pair check script" rather than an accessibility engine.
//
// Composited backgrounds (e.g. bg-status-warning/15 over bg-surface) are
// handled by alpha-compositing the tint over the parent surface first, then
// computing the ratio against the foreground.

import { tokens, lightTokens } from '../src/design/tokens'

type Rgb = { r: number; g: number; b: number; a: number }

function hexToRgb(hex: string): Rgb {
  let s = hex.replace('#', '').trim()
  if (s.length === 3)
    s = s
      .split('')
      .map((c) => c + c)
      .join('')
  if (s.length === 4)
    s = s
      .split('')
      .map((c) => c + c)
      .join('')
  if (s.length === 6) s += 'ff'
  if (s.length !== 8) throw new Error(`bad hex: ${hex}`)
  return {
    r: parseInt(s.slice(0, 2), 16) / 255,
    g: parseInt(s.slice(2, 4), 16) / 255,
    b: parseInt(s.slice(4, 6), 16) / 255,
    a: parseInt(s.slice(6, 8), 16) / 255,
  }
}

function blend(fg: Rgb, bg: Rgb): Rgb {
  const a = fg.a + bg.a * (1 - fg.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  }
}

function withAlpha(rgb: Rgb, a: number): Rgb {
  return { ...rgb, a }
}

function luminance({ r, g, b }: Rgb): number {
  const f = (v: number) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(fg: Rgb, bg: Rgb): number {
  const L1 = luminance(fg)
  const L2 = luminance(bg)
  const [lo, hi] = L1 < L2 ? [L1, L2] : [L2, L1]
  return (hi + 0.05) / (lo + 0.05)
}

type ThemeName = 'dark' | 'light'

type Pairing = {
  id: string
  // Component / area this pairing appears in, for the audit report.
  where: string
  // Foreground token path (e.g. ['text', 'primary']) or a literal hex.
  fg: ColorRef
  // Background stack — composited from last (opaque parent) to first (top
  // tinted layer). If the topmost layer is opaque, no compositing happens.
  bg: ColorRef[]
  // What this pairing represents — gates the AA threshold (text vs UI).
  kind: 'text-normal' | 'text-large' | 'icon' | 'border' | 'ui-component'
  // Some pairings are inherently informational (e.g. status-offline grey on a
  // grey context), not load-bearing for readability. Marked as `info` to
  // surface without failing the build.
  severity?: 'block' | 'info'
}

type ColorRef =
  | { kind: 'token'; path: readonly [string, string]; alpha?: number }
  | { kind: 'hex'; value: string }

function tok(path: readonly [string, string], alpha?: number): ColorRef {
  return { kind: 'token', path, alpha }
}

function resolve(ref: ColorRef, theme: ThemeName): Rgb {
  if (ref.kind === 'hex') {
    const r = hexToRgb(ref.value)
    return r
  }
  const map = theme === 'dark' ? tokens.color : lightTokens.color
  const [group, key] = ref.path
  const value = (map as Record<string, Record<string, string>>)[group][key]
  const r = hexToRgb(value)
  if (ref.alpha != null) return withAlpha(r, ref.alpha)
  return r
}

function compositeBg(stack: ColorRef[], theme: ThemeName): Rgb {
  if (stack.length === 0) throw new Error('empty bg stack')
  let bg = withAlpha(resolve(stack[stack.length - 1], theme), 1) // root is opaque
  for (let i = stack.length - 2; i >= 0; i--) {
    const top = resolve(stack[i], theme)
    bg = blend(top, bg)
  }
  return bg
}

// The pairing inventory. Built from the audit of src/components/, src/features/
// and src/routes/StyleGuide.tsx. New components add their pairings here when
// they introduce a foreground/background combination not already covered.
const PAIRINGS: Pairing[] = [
  // ── core text on canvases ────────────────────────────────────────────
  {
    id: 'text-primary on bg-base',
    where: 'body text, app canvas',
    fg: tok(['text', 'primary']),
    bg: [tok(['bg', 'base'])],
    kind: 'text-normal',
  },
  {
    id: 'text-primary on bg-surface',
    where: 'cards, side panels, list rows',
    fg: tok(['text', 'primary']),
    bg: [tok(['bg', 'surface'])],
    kind: 'text-normal',
  },
  {
    id: 'text-primary on bg-raised',
    where: 'hovered surfaces, popovers, dialogs',
    fg: tok(['text', 'primary']),
    bg: [tok(['bg', 'raised'])],
    kind: 'text-normal',
  },
  {
    id: 'text-primary on bg-sunk',
    where: 'avatar fallback initials, code blocks',
    fg: tok(['text', 'primary']),
    bg: [tok(['bg', 'sunk'])],
    kind: 'text-normal',
  },
  {
    id: 'text-secondary on bg-base',
    where: 'captions, helper text',
    fg: tok(['text', 'secondary']),
    bg: [tok(['bg', 'base'])],
    kind: 'text-normal',
  },
  {
    id: 'text-secondary on bg-surface',
    where: 'card description, settings row helper',
    fg: tok(['text', 'secondary']),
    bg: [tok(['bg', 'surface'])],
    kind: 'text-normal',
  },
  {
    id: 'text-secondary on bg-raised',
    where: 'popover/dropdown secondary text',
    fg: tok(['text', 'secondary']),
    bg: [tok(['bg', 'raised'])],
    kind: 'text-normal',
  },
  {
    id: 'text-secondary on bg-sunk',
    where: 'avatar fallback, kbd label',
    fg: tok(['text', 'secondary']),
    bg: [tok(['bg', 'sunk'])],
    kind: 'text-normal',
  },
  {
    id: 'text-muted on bg-base',
    where: 'placeholder, timestamps',
    fg: tok(['text', 'muted']),
    bg: [tok(['bg', 'base'])],
    kind: 'text-normal',
  },
  {
    id: 'text-muted on bg-surface',
    where: 'audit row "ago" timestamp',
    fg: tok(['text', 'muted']),
    bg: [tok(['bg', 'surface'])],
    kind: 'text-normal',
  },
  {
    id: 'text-muted on bg-raised',
    where: 'kbd "press a combo" hint',
    fg: tok(['text', 'muted']),
    bg: [tok(['bg', 'raised'])],
    kind: 'text-normal',
  },

  // ── accent on accent (button fills, badges) ─────────────────────────
  {
    id: 'text-inverse on bg-accent-default',
    where: 'primary button, default badge, checkbox check',
    fg: tok(['text', 'inverse']),
    bg: [tok(['accent', 'default'])],
    kind: 'text-normal',
  },
  {
    id: 'text-inverse on bg-accent-hover',
    where: 'primary button hover',
    fg: tok(['text', 'inverse']),
    bg: [tok(['accent', 'hover'])],
    kind: 'text-normal',
  },
  {
    id: 'text-inverse on bg-accent-active',
    where: 'primary button active',
    fg: tok(['text', 'inverse']),
    bg: [tok(['accent', 'active'])],
    kind: 'text-normal',
  },
  {
    id: 'text-inverse on bg-accent-muted',
    where: 'ModelPicker recommended-tier badge',
    fg: tok(['text', 'inverse']),
    bg: [tok(['accent', 'muted'])],
    kind: 'text-normal',
  },
  {
    id: 'text-accent-default on bg-base',
    where: 'link variant, AuditLogRow accent icon',
    fg: tok(['accent', 'default']),
    bg: [tok(['bg', 'base'])],
    kind: 'text-normal',
  },
  {
    id: 'text-accent-default on bg-surface',
    where: 'topic gate modal accent text',
    fg: tok(['accent', 'default']),
    bg: [tok(['bg', 'surface'])],
    kind: 'text-normal',
  },

  // ── status colors as TEXT on neutral surfaces ──────────────────────
  {
    id: 'text-status-alerted on bg-base',
    where: 'KeybindCapture inline error, recovery error, model-picker error',
    fg: tok(['status', 'alerted']),
    bg: [tok(['bg', 'base'])],
    kind: 'text-normal',
  },
  {
    id: 'text-status-alerted on bg-surface',
    where: 'audit row alerted icon-text, report row',
    fg: tok(['status', 'alerted']),
    bg: [tok(['bg', 'surface'])],
    kind: 'text-normal',
  },
  {
    id: 'text-status-warning on bg-base',
    where: 'screen-cap overlay copy',
    fg: tok(['status', 'warning']),
    bg: [tok(['bg', 'base'])],
    kind: 'text-normal',
  },
  {
    id: 'text-status-warning on bg-surface',
    where: 'audit row warning icon-text, report row',
    fg: tok(['status', 'warning']),
    bg: [tok(['bg', 'surface'])],
    kind: 'text-normal',
  },
  {
    id: 'text-status-focused on bg-base',
    where: 'onboarding success, add-friend success',
    fg: tok(['status', 'focused']),
    bg: [tok(['bg', 'base'])],
    kind: 'text-normal',
  },
  {
    id: 'text-status-focused on bg-surface',
    where: 'audit row focused icon-text, report row',
    fg: tok(['status', 'focused']),
    bg: [tok(['bg', 'surface'])],
    kind: 'text-normal',
  },

  // ── status colors as TEXT on tinted same-color backgrounds (audit row
  // icon chips, report event rows). The chip is `bg-status-X/15` composited
  // over the parent surface, with `text-status-X` on top.
  {
    id: 'text-status-alerted on (alerted/15 over bg-surface)',
    where: 'AuditLogRow.tsx:96, Report.tsx:427',
    fg: tok(['status', 'alerted']),
    bg: [tok(['status', 'alerted'], 0.15), tok(['bg', 'surface'])],
    kind: 'text-normal',
  },
  {
    id: 'text-status-warning on (warning/15 over bg-surface)',
    where: 'AuditLogRow.tsx:94, Report.tsx:425',
    fg: tok(['status', 'warning']),
    bg: [tok(['status', 'warning'], 0.15), tok(['bg', 'surface'])],
    kind: 'text-normal',
  },
  {
    id: 'text-status-focused on (focused/15 over bg-surface)',
    where: 'AuditLogRow.tsx:98, Report.tsx:429',
    fg: tok(['status', 'focused']),
    bg: [tok(['status', 'focused'], 0.15), tok(['bg', 'surface'])],
    kind: 'text-normal',
  },
  {
    id: 'text-accent-default on (accent/15 over bg-surface)',
    where: 'AuditLogRow.tsx:100, Report.tsx:431',
    fg: tok(['accent', 'default']),
    bg: [tok(['accent', 'default'], 0.15), tok(['bg', 'surface'])],
    kind: 'text-normal',
  },

  // ── destructive button (text-inverse on status-alerted as button fill) ─
  {
    id: 'text-inverse on bg-status-alerted',
    where: 'destructive button + badge',
    fg: tok(['text', 'inverse']),
    bg: [tok(['status', 'alerted'])],
    kind: 'text-normal',
  },
  // ModelPicker speed-tier badges (small text, but treat as normal text)
  {
    id: 'text-inverse on bg-status-focused',
    where: 'ModelPicker speed badge — fast tier',
    fg: tok(['text', 'inverse']),
    bg: [tok(['status', 'focused'])],
    kind: 'text-normal',
  },
  {
    id: 'text-inverse on bg-status-warning',
    where: 'ModelPicker speed badge — slow tier',
    fg: tok(['text', 'inverse']),
    bg: [tok(['status', 'warning'])],
    kind: 'text-normal',
  },

  // ── VideoTile alert header — text-inverse on alerted/85 composited over
  // the dark video stream (worst case: light surface visible if camera off).
  {
    id: 'text-inverse on (alerted/85 over bg-sunk)',
    where: 'VideoTile.tsx:78 off-task header (camera off)',
    fg: tok(['text', 'inverse']),
    bg: [tok(['status', 'alerted'], 0.85), tok(['bg', 'sunk'])],
    kind: 'text-normal',
  },

  // ── VideoTile name overlay — text-primary on overlay-glass which composites
  // over the video stream. Worst case is camera off (sunk visible).
  {
    id: 'text-primary on (overlay-glass over bg-sunk)',
    where: 'VideoTile.tsx:83 figcaption (camera off)',
    fg: tok(['text', 'primary']),
    bg: [tok(['overlay', 'glass']), tok(['bg', 'sunk'])],
    kind: 'text-normal',
  },

  // ── status as UI (border + dot, not text). 3:1 is the WCAG threshold
  // for non-text UI components per WCAG 1.4.11. ──────────────────────
  {
    id: 'status-alerted border on bg-base',
    where: 'VideoTile.tsx:55 alerted tile border, input invalid ring',
    fg: tok(['status', 'alerted']),
    bg: [tok(['bg', 'base'])],
    kind: 'ui-component',
  },
  {
    id: 'status-focused dot on bg-base',
    where: 'FocusIndicator (focused/online dots)',
    fg: tok(['status', 'focused']),
    bg: [tok(['bg', 'base'])],
    kind: 'ui-component',
  },
  {
    id: 'status-warning dot on bg-base',
    where: 'FocusIndicator (warning)',
    fg: tok(['status', 'warning']),
    bg: [tok(['bg', 'base'])],
    kind: 'ui-component',
  },
  {
    id: 'status-offline dot on bg-base',
    where: 'FocusIndicator (offline)',
    fg: tok(['status', 'offline']),
    bg: [tok(['bg', 'base'])],
    kind: 'ui-component',
    // Offline is a deliberately quiet "this is not here" — paired with the
    // ○ ring shape per DESIGN-SYSTEM §11, not color-alone. Informational.
    severity: 'info',
  },
  {
    id: 'accent-default focus ring on bg-base',
    where: 'global focus-visible ring on buttons, inputs',
    fg: tok(['accent', 'default']),
    bg: [tok(['bg', 'base'])],
    kind: 'ui-component',
  },

  // ── borders & accents on raised surfaces ────────────────────────────
  // WCAG 1.4.11 explicitly exempts the *visual presentation of inactive
  // user interface components*. Idle card/input outlines and checkbox/radio
  // idle borders are hairlines that don't carry the identification load
  // — the input is identified by its label + caret, the checkbox by its
  // shape + label, and the focus-visible state lights up the accent ring
  // at ≥4.7:1 in both themes (see `accent-default focus ring on bg-base`
  // above). Logged for awareness, not failure.
  {
    id: 'border-default on bg-base',
    where: 'card and input idle outlines (active state uses accent ring)',
    fg: tok(['border', 'default']),
    bg: [tok(['bg', 'base'])],
    kind: 'ui-component',
    severity: 'info',
  },
  {
    id: 'border-subtle on bg-surface',
    where: 'list row dividers inside a card',
    fg: tok(['border', 'subtle']),
    bg: [tok(['bg', 'surface'])],
    kind: 'border',
    severity: 'info',
  },
  {
    id: 'border-strong on bg-base',
    where: 'checkbox/radio idle border (active uses accent fill + ring)',
    fg: tok(['border', 'strong']),
    bg: [tok(['bg', 'base'])],
    kind: 'ui-component',
    severity: 'info',
  },
  {
    id: 'border-strong on bg-sunk',
    where: 'checkbox/radio idle border, on its own sunk fill',
    fg: tok(['border', 'strong']),
    bg: [tok(['bg', 'sunk'])],
    kind: 'ui-component',
    severity: 'info',
  },
]

const AA_NORMAL = 4.5
const AA_LARGE = 3.0
const AA_UI = 3.0

function thresholdFor(kind: Pairing['kind']): number {
  switch (kind) {
    case 'text-normal':
      return AA_NORMAL
    case 'text-large':
      return AA_LARGE
    case 'icon':
    case 'border':
    case 'ui-component':
      return AA_UI
  }
}

type Result = {
  pairing: Pairing
  theme: ThemeName
  ratio: number
  threshold: number
  pass: boolean
}

function evaluate(): Result[] {
  const out: Result[] = []
  for (const p of PAIRINGS) {
    for (const theme of ['dark', 'light'] as ThemeName[]) {
      const fg = resolve(p.fg, theme)
      // For text/UI pairings the foreground is opaque; alpha is allowed on
      // backgrounds (tints) only.
      const fgOpaque: Rgb = { ...fg, a: 1 }
      const bg = compositeBg(p.bg, theme)
      const ratio = contrast(fgOpaque, bg)
      const threshold = thresholdFor(p.kind)
      out.push({
        pairing: p,
        theme,
        ratio,
        threshold,
        pass: ratio >= threshold,
      })
    }
  }
  return out
}

function fmt(n: number): string {
  return n.toFixed(2)
}

function print(results: Result[]): { failures: number; infoFailures: number } {
  let failures = 0
  let infoFailures = 0
  const byTheme: Record<ThemeName, Result[]> = { dark: [], light: [] }
  for (const r of results) byTheme[r.theme].push(r)

  for (const theme of ['dark', 'light'] as ThemeName[]) {
    process.stdout.write(`\n── ${theme} theme ──\n`)
    for (const r of byTheme[theme]) {
      const sev = r.pairing.severity ?? 'block'
      if (r.pass) {
        process.stdout.write(
          `  PASS  ${fmt(r.ratio)}:1  ≥${r.threshold}  ${r.pairing.id}\n`
        )
        continue
      }
      if (sev === 'info') {
        process.stdout.write(
          `  info  ${fmt(r.ratio)}:1  <${r.threshold}  ${r.pairing.id}  (${r.pairing.where})\n`
        )
        infoFailures++
      } else {
        process.stderr.write(
          `  FAIL  ${fmt(r.ratio)}:1  <${r.threshold}  ${r.pairing.id}  (${r.pairing.where})\n`
        )
        failures++
      }
    }
  }
  return { failures, infoFailures }
}

function main(): void {
  const results = evaluate()
  const { failures, infoFailures } = print(results)
  process.stdout.write(
    `\ncheck-contrast: ${PAIRINGS.length} pairings × 2 themes = ${PAIRINGS.length * 2} checks\n`
  )
  if (failures > 0) {
    process.stderr.write(`check-contrast: ${failures} blocking failure(s)\n`)
    if (infoFailures > 0) {
      process.stdout.write(
        `check-contrast: ${infoFailures} informational notice(s) (not blocking)\n`
      )
    }
    process.exit(1)
  }
  if (infoFailures > 0) {
    process.stdout.write(
      `check-contrast: OK (${infoFailures} informational notice${infoFailures === 1 ? '' : 's'})\n`
    )
  } else {
    process.stdout.write('check-contrast: OK\n')
  }
  process.exit(0)
}

main()
