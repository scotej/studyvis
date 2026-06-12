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

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

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
  {
    id: 'text-muted on bg-sunk',
    where: 'S3 camera-off placeholder + U2 waiting-tile body',
    fg: tok(['text', 'muted']),
    bg: [tok(['bg', 'sunk'])],
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
  // F2 — RelayDiagnostics per-relay status text labels sit on the sunk row fill.
  {
    id: 'text-status-focused on bg-sunk',
    where: 'F2 RelayDiagnostics "Connected" label on the sunk relay row',
    fg: tok(['status', 'focused']),
    bg: [tok(['bg', 'sunk'])],
    kind: 'text-normal',
  },
  {
    id: 'text-status-warning on bg-sunk',
    where: 'F2 RelayDiagnostics "Connecting…" label on the sunk relay row',
    fg: tok(['status', 'warning']),
    bg: [tok(['bg', 'sunk'])],
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
  // F2 — RelayDiagnostics per-relay dots sit on the sunk relay-row fill. Each
  // dot is paired with a text status label + aria-label, never color-alone.
  {
    id: 'status-focused dot on bg-sunk',
    where: 'F2 RelayDiagnostics connected dot',
    fg: tok(['status', 'focused']),
    bg: [tok(['bg', 'sunk'])],
    kind: 'ui-component',
  },
  {
    id: 'status-warning dot on bg-sunk',
    where: 'F2 RelayDiagnostics connecting dot',
    fg: tok(['status', 'warning']),
    bg: [tok(['bg', 'sunk'])],
    kind: 'ui-component',
  },
  {
    id: 'status-offline dot on bg-sunk',
    where: 'F2 RelayDiagnostics down dot (○ ring shape, not color-alone)',
    fg: tok(['status', 'offline']),
    bg: [tok(['bg', 'sunk'])],
    kind: 'ui-component',
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
    id: 'border-subtle on bg-base',
    where: 'V3-P6 TitleBar bottom divider (border-b on bg-base canvas)',
    fg: tok(['border', 'subtle']),
    bg: [tok(['bg', 'base'])],
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
  {
    id: 'border-subtle on bg-sunk',
    where:
      'U2 WaitingTile dashed outline (also IdentityCategory / ModelPicker)',
    fg: tok(['border', 'subtle']),
    bg: [tok(['bg', 'sunk'])],
    kind: 'border',
    severity: 'info',
  },

  // ── U5 coverage additions ───────────────────────────────────────────
  // Surfaced by the coverage scanner below (the previous PAIRINGS list only
  // proved the listed pairs pass; these are pairs the UI actually uses that
  // were never enumerated). Each was AA-verified in both themes before being
  // added; idle-outline borders follow the WCAG 1.4.11 inactive-component
  // exemption already established above and are logged as `info`.

  // border-default idle outlines on the raised + surface canvases (cards,
  // popovers, the kbd chip, stats tooltips, the AiResponseBubble neutral tone,
  // the AiDialogWindow card). Hairline idle outlines — same exemption as
  // `border-default on bg-base`.
  {
    id: 'border-default on bg-raised',
    where:
      'kbd, AiResponseBubble (neutral), AiDialogWindow, Dashboard/FocusInsights tooltips, SessionTimer hover',
    fg: tok(['border', 'default']),
    bg: [tok(['bg', 'raised'])],
    kind: 'ui-component',
    severity: 'info',
  },
  {
    id: 'border-default on bg-surface',
    where:
      'card/input idle outlines on surface (ModelPicker, PairQrScanner, AddFriendDialogView, FriendsListView, onboarding steps, BipBackupPanel)',
    fg: tok(['border', 'default']),
    bg: [tok(['bg', 'surface'])],
    kind: 'ui-component',
    severity: 'info',
  },
  {
    id: 'border-default on bg-sunk',
    where: 'VideoTile.tsx idle tile border (active state uses status-alerted)',
    fg: tok(['border', 'default']),
    bg: [tok(['bg', 'sunk'])],
    kind: 'ui-component',
    severity: 'info',
  },

  // accent-default as an ACTIVE selection affordance (selected preset border,
  // checked radio dot, focus-within input border). These DO carry the
  // identification load for the active state, so they block at the 3:1 UI
  // threshold rather than being informational.
  {
    id: 'accent-default border on bg-raised',
    where: 'SessionTimer.tsx:225 selected preset chip border',
    fg: tok(['accent', 'default']),
    bg: [tok(['bg', 'raised'])],
    kind: 'ui-component',
  },
  {
    id: 'accent-default dot on bg-sunk',
    where: 'radio-group.tsx:37 checked CircleIcon on the sunk radio fill',
    fg: tok(['accent', 'default']),
    bg: [tok(['bg', 'sunk'])],
    kind: 'ui-component',
  },
  {
    id: 'accent-default border on bg-surface',
    where: 'PairWordInput.tsx:145 focus-within input border',
    fg: tok(['accent', 'default']),
    bg: [tok(['bg', 'surface'])],
    kind: 'ui-component',
  },

  // Tooltip + slider thumb use text-primary as a BACKGROUND fill (bg-text-primary).
  {
    id: 'text-bg-base on bg-text-primary',
    where:
      'tooltip.tsx:45 inverted high-contrast tooltip (bg-base text on the primary fill)',
    fg: tok(['bg', 'base']),
    bg: [tok(['text', 'primary'])],
    kind: 'text-normal',
  },
  {
    id: 'accent-default border on bg-text-primary',
    where: 'slider.tsx:56 thumb border on its near-white fill',
    fg: tok(['accent', 'default']),
    bg: [tok(['text', 'primary'])],
    kind: 'ui-component',
    // The thumb is identified by its shape, position, and the accent
    // focus-visible ring (ring-accent-ring, hover:ring-4 / focus-visible:ring-4
    // at ≥4.7:1). The accent border on the white fill is decorative trim, not
    // the identifying affordance — WCAG 1.4.11 inactive-component exemption.
    severity: 'info',
  },

  // status colors as TEXT on bg-raised (AiResponseBubble approved/denied tones,
  // ModelPicker inline error). Distinct from the bg-base / bg-surface variants
  // already listed — bg-raised is a lighter surface and was never enumerated.
  {
    id: 'text-status-alerted on bg-raised',
    where: 'AiResponseBubble.tsx:53 denied tone, ModelPicker.tsx:345 error',
    fg: tok(['status', 'alerted']),
    bg: [tok(['bg', 'raised'])],
    kind: 'text-normal',
  },
  {
    id: 'text-status-focused on bg-raised',
    where: 'AiResponseBubble.tsx:52 approved tone',
    fg: tok(['status', 'focused']),
    bg: [tok(['bg', 'raised'])],
    kind: 'text-normal',
  },

  // status-warning as an ICON on bg-raised (BreakCountdownBadge / SelfWarningBadge
  // leading glyph, paired with text + an icon — never color-alone).
  {
    id: 'status-warning icon on bg-raised',
    where: 'BreakCountdownBadge.tsx:61, SelfWarningBadge.tsx:41 leading icon',
    fg: tok(['status', 'warning']),
    bg: [tok(['bg', 'raised'])],
    kind: 'icon',
  },

  // status-tinted callout boxes: a `bg-status-X/10` fill composited over the
  // host surface, carrying `text-status-X` body + a `border-status-X/40` rule.
  // (The /15 audit-chip variants over bg-surface are listed above; these are
  // the /10 success/error boxes in AddFriendDialogView, AddFriendStepView and
  // the Report status banner.) The coverage matcher keys on the tint's color
  // token, not its alpha, so one entry per (fg, host-surface) covers /10 + /15.
  {
    id: 'text-status-alerted on (alerted/10 over bg-surface)',
    where: 'AddFriendDialogView.tsx:567, Report.tsx:207 error box body',
    fg: tok(['status', 'alerted']),
    bg: [tok(['status', 'alerted'], 0.1), tok(['bg', 'surface'])],
    kind: 'text-normal',
  },
  {
    id: 'text-status-focused on (focused/10 over bg-surface)',
    where:
      'AddFriendDialogView.tsx:551, AddFriendStepView.tsx:52 success box body',
    fg: tok(['status', 'focused']),
    bg: [tok(['status', 'focused'], 0.1), tok(['bg', 'surface'])],
    kind: 'text-normal',
  },
  {
    id: 'status-alerted/40 border on (alerted/10 over bg-surface)',
    where: 'AddFriendDialogView.tsx:567, Report.tsx:207 error box rule',
    fg: tok(['status', 'alerted'], 0.4),
    bg: [tok(['status', 'alerted'], 0.1), tok(['bg', 'surface'])],
    kind: 'ui-component',
  },
  {
    id: 'status-focused/40 border on (focused/10 over bg-surface)',
    where:
      'AddFriendDialogView.tsx:551, AddFriendStepView.tsx:52 success box rule',
    fg: tok(['status', 'focused'], 0.4),
    bg: [tok(['status', 'focused'], 0.1), tok(['bg', 'surface'])],
    kind: 'ui-component',
  },

  // status-tinted borders on a plain host surface (no same-color tint fill):
  // the BreakCountdown/SelfWarning/MediaError callouts and the PairWordInput
  // valid/invalid input rings. These are active-state UI rules (3:1).
  {
    id: 'status-warning/40 border on bg-raised',
    where: 'BreakCountdownBadge.tsx:55, SelfWarningBadge.tsx:35 callout rule',
    fg: tok(['status', 'warning'], 0.4),
    bg: [tok(['bg', 'raised'])],
    kind: 'ui-component',
  },
  {
    id: 'status-warning/40 border on bg-surface',
    where: 'MediaErrorBanner.tsx:38 callout rule',
    fg: tok(['status', 'warning'], 0.4),
    bg: [tok(['bg', 'surface'])],
    kind: 'ui-component',
  },
  {
    id: 'status-alerted/60 border on bg-surface',
    where: 'PairWordInput.tsx:147 invalid input ring',
    fg: tok(['status', 'alerted'], 0.6),
    bg: [tok(['bg', 'surface'])],
    kind: 'ui-component',
  },
  {
    id: 'status-focused/50 border on bg-surface',
    where: 'PairWordInput.tsx:149 valid input ring',
    fg: tok(['status', 'focused'], 0.5),
    bg: [tok(['bg', 'surface'])],
    kind: 'ui-component',
  },
  // AiResponseBubble approved/denied tone borders are `border-status-X/40`
  // on the bg-raised bubble fill.
  {
    id: 'status-focused/40 border on bg-raised',
    where: 'AiResponseBubble.tsx:42 approved tone rule',
    fg: tok(['status', 'focused'], 0.4),
    bg: [tok(['bg', 'raised'])],
    kind: 'ui-component',
  },
  {
    id: 'status-alerted/40 border on bg-raised',
    where:
      'AiResponseBubble.tsx:43 denied tone rule, ModelPicker.tsx:345 error rule',
    fg: tok(['status', 'alerted'], 0.4),
    bg: [tok(['bg', 'raised'])],
    kind: 'ui-component',
  },
  {
    id: 'status-alerted border on bg-sunk',
    where: 'VideoTile.tsx:102 alerted tile border against its own sunk fill',
    fg: tok(['status', 'alerted']),
    bg: [tok(['bg', 'sunk'])],
    kind: 'ui-component',
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

// ─────────────────────────────────────────────────────────────────────
// COVERAGE CHECK (U5)
//
// The PAIRINGS array above proves the *listed* pairs clear AA. It does not
// prove the house rule — "every foreground/background pairing the UI uses
// passes" — because a combination that is simply never enumerated (e.g.
// text-muted on bg-sunk before it was added) passes by omission. This pass
// closes that gap: it walks the same src/ tree as scripts/check-tokens.ts,
// finds Tailwind token-class co-occurrences (a text/border color token sharing
// a className expression with a bg color token), and FAILS when a discovered
// combination has no PAIRINGS entry.
//
// Parsing strategy — an AST walk via the TypeScript compiler (already a dep),
// chosen over a raw regex because it ignores comments natively (inline-code
// backticks in JSDoc were the dominant source of false positives in a
// regex-over-text prototype) and lets conditional class branches be scoped
// precisely:
//   • Each string / template literal is a co-occurrence unit.
//   • cn()/clsx()/cva()/twMerge() calls union their unconditional string args
//     into a base set; each ternary branch and `cond && '…'` right-hand side
//     forms its own unit COMBINED with the base — so the two arms of a
//     `isAlerted ? 'border-status-alerted' : 'border-border-default'` ternary
//     are never cross-paired, but a bg in the base string still pairs with the
//     border from whichever arm applies.
//   • cva variant strings are scanned per-variant: each `{ variants: { axis:
//     { name: '…' } } }` value is its own branch unit, combined with the cva
//     base string (the `focus-visible:border-…` / `aria-invalid:…` shared
//     classes) the same way a ternary arm is. Mutually-exclusive variants
//     across an axis are NOT cross-paired (matching cva semantics); cross-axis
//     combos (variant × size) are likewise not paired — fine, since the size
//     axis carries no color. clsx object (`{ 'cls': cond }`) and array
//     (`['a','b']`) args are expanded the same way.
//   • Tailwind modifier prefixes (`hover:`, `focus-visible:`, `aria-invalid:`,
//     `data-[…]:`, `[a&]:…`) are stripped at the leading boundary, so a
//     modifier-gated color is paired against the rest of its unit.
//
// Documented limits (conservative by design — a missed real pairing is worse
// than an over-pairing, which is cheap to silence with one IGNORED entry):
//   • It pairs every text/border token with every bg token in the SAME unit.
//     A bg on a child wrapper paired against text that is really inherited by a
//     sibling is a false co-occurrence; resolve it with an IGNORED_COOCCURRENCES
//     entry (file + combo + reason), never by loosening the scanner.
//   • Coverage matching keys on the fg token (group+key) and the TOPMOST bg
//     layer's token (group+key), IGNORING alpha. A /10 vs /15 tint of the same
//     color is treated as covered by one curated entry; the curated entry still
//     carries the worst-case alpha for the actual AA computation above.
//   • Scope mirrors check-tokens: every .ts/.tsx under src/ (stories INCLUDED),
//     skipping node_modules and dist.

const ROOT = resolvePath(fileURLToPath(import.meta.url), '..', '..')
const SRC = join(ROOT, 'src')

const TOKEN_GROUPS: Record<string, ReadonlySet<string>> = {
  bg: new Set(Object.keys(tokens.color.bg)),
  border: new Set(Object.keys(tokens.color.border)),
  text: new Set(Object.keys(tokens.color.text)),
  accent: new Set(Object.keys(tokens.color.accent)),
  status: new Set(Object.keys(tokens.color.status)),
  overlay: new Set(Object.keys(tokens.color.overlay)),
}

// `<prefix>-<group>-<key>` with an optional `/NN` opacity, bounded by class
// separators so `text-sm`, `border-b`, `text-center` etc. never match (their
// second segment is not one of our color groups). The leading boundary also
// admits `:` and `[` so Tailwind modifier prefixes — `hover:bg-…`,
// `focus-visible:border-…`, `aria-invalid:…`, `data-[…]:…`, `[a&]:hover:…` —
// expose their color utility instead of hiding it (the prefixed bg over-pairs
// with the same unit's base text, the documented-conservative direction).
// Validated against the live token map below so a typo'd token does not
// silently slip through as a pair.
const TOKEN_CLASS =
  /(?:^|[\s'"`:[])(bg|text|border)-(bg|border|text|accent|status|overlay)-([a-z]+)(?:\/\d+)?(?=$|[\s'"`])/g

type ScannedTok = { group: string; key: string }
type Cooccurrence = { fg: ScannedTok; bg: ScannedTok; file: string }

function comboKey(fg: ScannedTok, bg: ScannedTok): string {
  return `${fg.group}-${fg.key} on ${bg.group}-${bg.key}`
}

function tokensInUnit(text: string): { bg: ScannedTok[]; fg: ScannedTok[] } {
  const bg: ScannedTok[] = []
  const fg: ScannedTok[] = []
  TOKEN_CLASS.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_CLASS.exec(text))) {
    const [, prefix, group, key] = m
    if (!TOKEN_GROUPS[group]?.has(key)) continue
    const tok: ScannedTok = { group, key }
    if (prefix === 'bg') bg.push(tok)
    else fg.push(tok)
    // Overlapping matches share the boundary char; rewind one so adjacent
    // classes ("bg-bg-sunk text-text-muted") are both seen.
    TOKEN_CLASS.lastIndex = m.index + 1
  }
  return { bg, fg }
}

function staticText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text
    for (const span of node.templateSpans) s += ' ' + span.literal.text
    return s
  }
  return null
}

// Expand a class-valued expression into the list of class-string units that can
// co-apply. Ternary arms and `&&` branches are kept separate so mutually
// exclusive variants are not cross-paired; `+` concatenation merges.
function unitsFromExpr(node: ts.Node): string[][] {
  if (ts.isParenthesizedExpression(node)) return unitsFromExpr(node.expression)
  if (ts.isConditionalExpression(node)) {
    return [...unitsFromExpr(node.whenTrue), ...unitsFromExpr(node.whenFalse)]
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return unitsFromExpr(node.right)
    }
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return [...unitsFromExpr(node.left), ...unitsFromExpr(node.right)]
    }
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = unitsFromExpr(node.left)
      const right = unitsFromExpr(node.right)
      const merged: string[][] = []
      for (const a of left.length ? left : [[]]) {
        for (const b of right.length ? right : [[]]) merged.push([...a, ...b])
      }
      return merged
    }
  }
  // cva({ variants: { axis: { name: 'classes' } } }) and clsx({ 'classes': cond })
  // object args, plus clsx(['a', 'b']) array args: each contained string is its
  // own branch unit (mutually-exclusive cva variants must not be cross-paired,
  // exactly like ternary arms), and combines with the cva base via the call's
  // base-set merge in visitCalls.
  if (ts.isObjectLiteralExpression(node)) {
    const out: string[][] = []
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        for (const u of unitsFromExpr(prop.initializer)) out.push(u)
        const nameUnit = staticText(prop.name)
        if (nameUnit != null) out.push([nameUnit])
      }
    }
    return out
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((el) => unitsFromExpr(el))
  }
  const text = staticText(node)
  return text != null ? [[text]] : []
}

const CN_HELPERS = new Set(['cn', 'clsx', 'cva', 'twMerge'])

function unitsForFile(sf: ts.SourceFile): string[] {
  const consumed = new Set<ts.Node>()
  const units: string[] = []

  const markConsumed = (n: ts.Node) => {
    consumed.add(n)
    ts.forEachChild(n, markConsumed)
  }

  const visitCalls = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      CN_HELPERS.has(node.expression.text)
    ) {
      const base: string[] = []
      const branchUnits: string[][] = []
      for (const arg of node.arguments) {
        markConsumed(arg)
        const direct = staticText(arg)
        if (direct != null) base.push(direct)
        else for (const u of unitsFromExpr(arg)) branchUnits.push(u)
      }
      if (branchUnits.length === 0) units.push(base.join(' '))
      else for (const u of branchUnits) units.push([...base, ...u].join(' '))
    }
    ts.forEachChild(node, visitCalls)
  }
  visitCalls(sf)

  const visitLiterals = (node: ts.Node) => {
    if (!consumed.has(node)) {
      const text = staticText(node)
      if (text != null) units.push(text)
    }
    ts.forEachChild(node, visitLiterals)
  }
  visitLiterals(sf)

  return units
}

async function walkSrc(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue
      await walkSrc(p, out)
    } else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

function toRel(abs: string): string {
  return relative(ROOT, abs).split(sep).join('/')
}

// Narrowly-scoped escape hatch for co-occurrences the scanner sees but that are
// NOT real adjacencies (a bg on a child wrapper whose text is inherited by a
// sibling, etc.). Each entry must name the file, the exact combo, and a reason.
// Prefer adding a real PAIRINGS entry; reach for this only when the pixels do
// not actually overlap.
type IgnoredCooccurrence = { file: string; combo: string; reason: string }

const IGNORED_COOCCURRENCES: IgnoredCooccurrence[] = [
  // cva base × variant cross-modifier artifacts in button/badge: the shared base
  // string carries `focus-visible:border-accent-default` and
  // `aria-invalid:border-status-alerted`, which the per-variant merge pairs with
  // each variant's resting/hover fill. A focus-visible (or aria-invalid) border
  // and a hover/resting fill are mutually-exclusive interaction states — the
  // border never sits on that fill as a load-bearing fg/bg. The real fills
  // (`text-inverse on bg-accent-default`, `…on bg-status-alerted`) are listed.
  {
    file: 'src/components/ui/button.tsx',
    combo: 'accent-default on accent-hover',
    reason:
      'focus-visible:border-accent-default (base) × hover:bg-accent-hover (default variant) — different interaction states, never co-applied',
  },
  {
    file: 'src/components/ui/badge.tsx',
    combo: 'accent-default on accent-hover',
    reason:
      'focus-visible:border-accent-default (base) × [a&]:hover:bg-accent-hover (default variant) — different interaction states',
  },
  {
    file: 'src/components/ui/button.tsx',
    combo: 'accent-default on status-alerted',
    reason:
      'focus-visible:border-accent-default (base) × bg-status-alerted (destructive variant fill) — focus border is decorative trim; the focus affordance is the ring (destructive overrides to ring-status-alerted)',
  },
  {
    file: 'src/components/ui/badge.tsx',
    combo: 'accent-default on status-alerted',
    reason:
      'focus-visible:border-accent-default (base) × bg-status-alerted (destructive variant fill) — focus affordance is the ring, not the border',
  },
  {
    file: 'src/components/ui/button.tsx',
    combo: 'status-alerted on accent-default',
    reason:
      'aria-invalid:border-status-alerted (base) × bg-accent-default (default variant fill) — invalid border and default resting fill are mutually-exclusive states',
  },
  {
    file: 'src/components/ui/badge.tsx',
    combo: 'status-alerted on accent-default',
    reason:
      'aria-invalid:border-status-alerted (base) × bg-accent-default (default variant fill) — mutually-exclusive states',
  },
  {
    file: 'src/components/ui/button.tsx',
    combo: 'status-alerted on accent-hover',
    reason:
      'aria-invalid:border-status-alerted (base) × hover:bg-accent-hover (default variant) — invalid border and hover fill never co-apply',
  },
  {
    file: 'src/components/ui/badge.tsx',
    combo: 'status-alerted on accent-hover',
    reason:
      'aria-invalid:border-status-alerted (base) × [a&]:hover:bg-accent-hover (default variant) — never co-applied',
  },

  // input.tsx: `selection:bg-accent-default` is the highlight color of selected
  // TEXT inside the field, not a surface the border/placeholder/file-button text
  // ever renders on. The only real selection pairing — text-inverse on
  // accent-default — is `selection:text-text-inverse` and is already listed.
  {
    file: 'src/components/ui/input.tsx',
    combo: 'border-default on accent-default',
    reason:
      'border-border-default (field outline) × selection:bg-accent-default (selected-text highlight) — the outline never sits on the text-selection fill',
  },
  {
    file: 'src/components/ui/input.tsx',
    combo: 'text-primary on accent-default',
    reason:
      'file:text-text-primary (file-button label) × selection:bg-accent-default (selected-text highlight) — distinct surfaces',
  },
  {
    file: 'src/components/ui/input.tsx',
    combo: 'text-secondary on accent-default',
    reason:
      'placeholder:text-text-secondary × selection:bg-accent-default — placeholder is gone once there is text to select; distinct surfaces',
  },
  {
    file: 'src/components/ui/input.tsx',
    combo: 'status-alerted on accent-default',
    reason:
      'aria-invalid:border-status-alerted (invalid outline) × selection:bg-accent-default (selected-text highlight) — distinct surfaces',
  },

  // checkbox.tsx: the idle box (border-border-strong on bg-bg-sunk) and the
  // checked box (border/bg-accent-default with a text-inverse glyph) are
  // mutually-exclusive data-[state] variants. The real checked pairing —
  // text-inverse on bg-accent-default — is already listed.
  {
    file: 'src/components/ui/checkbox.tsx',
    combo: 'border-strong on accent-default',
    reason:
      'border-border-strong (idle border) × data-[state=checked]:bg-accent-default (checked fill) — checked state swaps the border to accent; states never co-apply',
  },
  {
    file: 'src/components/ui/checkbox.tsx',
    combo: 'text-inverse on bg-sunk',
    reason:
      'data-[state=checked]:text-text-inverse (check glyph) × bg-bg-sunk (idle fill) — when checked the fill is accent-default, not sunk; the glyph never renders on the sunk fill',
  },

  // dropdown-menu.tsx item: the destructive-focus state colors text AND bg with
  // status-alerted (text-status-alerted on bg-status-alerted/10 — already covered
  // via the status-alerted self-pair). The default-variant focus text
  // (text-primary / leading-icon text-secondary) never renders on the
  // destructive bg.
  {
    file: 'src/components/ui/dropdown-menu.tsx',
    combo: 'text-primary on status-alerted',
    reason:
      'focus:text-text-primary (default variant) × data-[variant=destructive]:focus:bg-status-alerted/10 — destructive focus uses text-status-alerted, not text-primary; mutually-exclusive variants',
  },
  {
    file: 'src/components/ui/dropdown-menu.tsx',
    combo: 'text-secondary on status-alerted',
    reason:
      'leading-icon text-text-secondary (default) × data-[variant=destructive]:focus:bg-status-alerted/10 — destructive focus recolors the icon to status-alerted; mutually-exclusive variants',
  },
]

// The covered set: each PAIRINGS entry's fg token + its TOPMOST (index 0) bg
// layer token, alpha-ignored. Hex foregrounds (none today) are skipped since
// the scanner only emits token classes.
function coveredComboKeys(): Set<string> {
  const covered = new Set<string>()
  for (const p of PAIRINGS) {
    if (p.fg.kind !== 'token') continue
    const top = p.bg[0]
    if (top.kind !== 'token') continue
    const fg: ScannedTok = { group: p.fg.path[0], key: p.fg.path[1] }
    const bg: ScannedTok = { group: top.path[0], key: top.path[1] }
    covered.add(comboKey(fg, bg))
  }
  return covered
}

async function scanCooccurrences(): Promise<{
  cooccurrences: Cooccurrence[]
  scannedFiles: number
}> {
  const files = await walkSrc(SRC)
  const seen = new Set<string>()
  const out: Cooccurrence[] = []
  for (const abs of files) {
    const rel = toRel(abs)
    const text = await readFile(abs, 'utf8')
    const sf = ts.createSourceFile(
      abs,
      text,
      ts.ScriptTarget.Latest,
      true,
      /\.tsx$/.test(abs) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
    for (const unit of unitsForFile(sf)) {
      const { bg, fg } = tokensInUnit(unit)
      if (bg.length === 0 || fg.length === 0) continue
      for (const f of fg) {
        for (const b of bg) {
          const dedupe = `${rel}::${comboKey(f, b)}`
          if (seen.has(dedupe)) continue
          seen.add(dedupe)
          out.push({ fg: f, bg: b, file: rel })
        }
      }
    }
  }
  return { cooccurrences: out, scannedFiles: files.length }
}

type CoverageReport = {
  scannedFiles: number
  cooccurrences: number
  unmatchedIgnores: IgnoredCooccurrence[]
  missing: Cooccurrence[]
}

async function checkCoverage(): Promise<CoverageReport> {
  const covered = coveredComboKeys()
  const ignored = new Map<string, IgnoredCooccurrence>()
  for (const i of IGNORED_COOCCURRENCES) {
    ignored.set(`${i.file}::${i.combo}`, i)
  }
  const usedIgnores = new Set<string>()

  const { cooccurrences, scannedFiles } = await scanCooccurrences()
  const missing: Cooccurrence[] = []
  for (const c of cooccurrences) {
    const combo = comboKey(c.fg, c.bg)
    if (covered.has(combo)) continue
    const ignoreKey = `${c.file}::${combo}`
    if (ignored.has(ignoreKey)) {
      usedIgnores.add(ignoreKey)
      continue
    }
    missing.push(c)
  }

  const unmatchedIgnores: IgnoredCooccurrence[] = []
  for (const [key, entry] of ignored) {
    if (!usedIgnores.has(key)) unmatchedIgnores.push(entry)
  }

  return {
    scannedFiles,
    cooccurrences: cooccurrences.length,
    unmatchedIgnores,
    missing,
  }
}

function printCoverage(report: CoverageReport): number {
  process.stdout.write('\n── coverage check ──\n')
  process.stdout.write(
    `  scanned ${report.scannedFiles} src file(s), ${report.cooccurrences} token co-occurrence(s)\n`
  )

  let failures = 0

  if (report.unmatchedIgnores.length > 0) {
    for (const i of report.unmatchedIgnores) {
      process.stderr.write(
        `  FAIL  stale IGNORED_COOCCURRENCES entry — no longer seen: ${i.file}  ${i.combo}\n`
      )
      failures++
    }
  }

  if (report.missing.length > 0) {
    const grouped = new Map<string, string[]>()
    for (const m of report.missing) {
      const combo = comboKey(m.fg, m.bg)
      if (!grouped.has(combo)) grouped.set(combo, [])
      grouped.get(combo)!.push(m.file)
    }
    for (const [combo, files] of [...grouped.entries()].sort()) {
      const where = [...new Set(files)].sort().join(', ')
      process.stderr.write(`  FAIL  uncovered pairing: ${combo}\n`)
      process.stderr.write(`        used in: ${where}\n`)
      process.stderr.write(
        `        fix: add a PAIRINGS entry (must then clear AA, or be a documented\n` +
          `             informational border case) — or, if this is a false\n` +
          `             co-occurrence (bg on a child wrapper vs. inherited text),\n` +
          `             add an IGNORED_COOCCURRENCES entry { file, combo, reason }.\n`
      )
      failures += files.length
    }
  }

  if (failures === 0) {
    process.stdout.write(
      '  OK  every token co-occurrence has a PAIRINGS entry\n'
    )
  }
  return failures
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

async function main(): Promise<void> {
  const results = evaluate()
  const { failures, infoFailures } = print(results)
  process.stdout.write(
    `\ncheck-contrast: ${PAIRINGS.length} pairings × 2 themes = ${PAIRINGS.length * 2} checks\n`
  )

  const coverage = await checkCoverage()
  const coverageFailures = printCoverage(coverage)

  const blocking = failures + coverageFailures
  if (blocking > 0) {
    if (failures > 0) {
      process.stderr.write(`check-contrast: ${failures} AA failure(s)\n`)
    }
    if (coverageFailures > 0) {
      process.stderr.write(
        `check-contrast: ${coverageFailures} coverage failure(s) (token co-occurrences with no PAIRINGS entry)\n`
      )
    }
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

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
