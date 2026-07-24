# StudyVis — Design System

> Companion to `PLAN.md` and `ARCHITECTURE.md`. This file is the visual + interaction source of truth. Everything that renders in the app obeys what's written here. If you're tempted to introduce a new color, a new font weight, or a new spacing value: don't — extend the token file instead, with reasoning.

## 1. Direction

**Calm Dark — Linear × Things 3.**

Reasoning, in order:
1. **Calm**: this is a focused-work app. The UI must not compete with the user's study material for attention.
2. **Dark by default**: study sessions skew evening / night; long sessions reward low eye-strain.
3. **Warm, not corporate**: friends-only. The aesthetic should feel personal and a bit cozy, not Slack-grey.
4. **Native chrome by default; opt-in custom chrome**: native OS decorations are the default and match every install through v1.0.3. V3-P6 ships an opt-in custom frameless chrome (Settings → Appearance → Window style → Custom) — the studyvis wordmark and a platform-correct control cluster, applied at process boot for a clean state. Tokens in §2: `titleBarHeight` and `titleBarMacInset`. The toggle is honest about needing a relaunch.
5. **Motion sparingly**: a brief transition when a panel opens; nothing decorative, nothing repeating.

What it is **not**:
- Not Discord (too playful, too colorful).
- Not Notion (too neutral, too document-flavored).
- Not Linear (a touch too cold and corporate; we borrow the restraint, not the chill).

The closest reference points: Things 3's typography and quiet confidence; Linear's geometric restraint; Bear's reading-friendly proportions.

## 2. Tokens

`src/design/tokens.ts` is the single source of truth. Tailwind v4's CSS-variable-based config consumes it. Components import from it. No raw color, spacing, or font value appears anywhere else in the codebase — enforced by `scripts/check-tokens.ts` (V1-P2).

```ts
// src/design/tokens.ts

export const tokens = {
  color: {
    bg: {
      base:    '#17130C',   // app canvas
      surface: '#211A11',   // cards, side panels, list rows
      raised:  '#2B2317',   // hovered surfaces, popovers, dialogs
      sunk:    '#100D08',   // text input, scrollable content background
    },
    border: {
      subtle:  '#332A1C',   // divider between rows
      default: '#3F3422',   // around cards, inputs
      strong:  '#52442C',   // active focus ring (combined with accent glow)
    },
    text: {
      primary:   '#F0EBE2', // body, headings, important UI labels
      secondary: '#B0A99C', // captions, helper text, timestamps
      muted:     '#9A8E80', // placeholder, disabled, low-priority (V3-P5: bumped from #7D766A to clear WCAG AA on every dark surface)
      inverse:   '#100D08', // text on accent-filled buttons
    },
    accent: {
      default: '#F2B05A',   // primary actions, focused outlines, brand accents
      hover:   '#F8C079',
      active:  '#D9974A',
      muted:   '#A07043',   // accent pill fill (ModelPicker "Gated"); V3-P5 lightened from #7A5C32 to clear inverse-text contrast
      ring:    '#F2B05A99', // 60% alpha — focus ring; composited ≥3.9:1 on every surface (WCAG 1.4.11)
    },
    status: {
      focused: '#84B061',   // sage green — "user is on task" tile dot
      warning: '#EBC646',   // amber — "self-warning" badge
      alerted: '#DC7860',   // muted red — "peers notified, score deducted"
      offline: '#7D766A',   // friend not currently reachable
      online:  '#84B061',   // friend currently online (same as focused)
    },
    overlay: {
      scrim:    '#0006',    // 0% color, 40% alpha — modal backdrop
      glass:    '#211A11CC',// raised over scrim
    },
  },

  font: {
    family: {
      sans: '"Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
    },
    size: {
      xs:    12,  // timestamps, captions
      sm:    13,  // secondary UI
      base:  14,  // primary UI default
      md:    16,  // body
      lg:    20,  // section heading
      xl:    24,  // page heading
      '2xl': 32,  // hero (used sparingly — onboarding only)
    },
    weight: {
      regular:  400,
      medium:   500,
      semibold: 600,
    },
    lineHeight: {
      tight:  1.25, // headings
      snug:   1.4,  // UI
      normal: 1.5,  // body
    },
    letterSpacing: {
      tight:  '-0.01em', // headings
      normal: '0em',
      wide:   '0.04em',  // small uppercase labels (rare)
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
    sm:   4,    // small inputs
    md:   8,    // buttons, list rows
    lg:   12,   // cards, video tiles
    xl:   16,   // modals, large surfaces
    full: 9999, // pills, dots
  },

  shadow: {
    none: 'none',
    sm:   '0 1px 2px rgba(0,0,0,0.30)',
    md:   '0 4px 12px rgba(0,0,0,0.40)',
    lg:   '0 12px 32px rgba(0,0,0,0.50)',
    glow: '0 0 0 3px var(--accent-ring)', // focus ring glow
  },

  motion: {
    duration: {
      instant: 0,
      fast:    150,
      base:    200,
      slow:    300,
      reveal:  450,  // post-session score reveal only
    },
    easing: {
      out:    'cubic-bezier(0.16, 1, 0.3, 1)',     // default out
      inOut:  'cubic-bezier(0.65, 0, 0.35, 1)',    // for state changes
      spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)', // tiny bounce — used once or twice
    },
  },

  zIndex: {
    base:        0,
    sticky:     10,
    dropdown:   100,
    popover:    200,
    overlay:    300,
    modal:      400,
    toast:      500,
    tooltip:    600,
    aiDialog:   700,  // floating AI text-box always-on-top window content
  },

  // sizing/breakpoint tokens used by layout primitives
  sizes: {
    contentMaxWidth:        1200,
    sidebarWidth:            280,
    auditPanelWidth:         320,
    videoTileMinHeight:      180,
    videoTileMaxHeight:      360,
    // V3-P6 opt-in custom window chrome (TitleBar). The band height is
    // shared across platforms so the wordmark vertical-centre matches on
    // macOS (overlap onto the system traffic-light area via
    // TitleBarStyle::Overlay) and Windows (the app-painted frameless
    // band with our own min/restore/close cluster).
    titleBarHeight:           38,
    // Left inset on macOS reserved for the system traffic lights: 12 + 3
    // × 14 + 2 × 8 + 12 = 78. Windows uses no inset (wordmark sits at the
    // left edge with the standard inline gap).
    titleBarMacInset:         78,
  },
} as const

export type Tokens = typeof tokens
```

### Light theme

Same hues as dark; lightness/saturation moved so every text/background pairing clears WCAG AA on the warm-honey canvas. Verified by `scripts/check-contrast.ts` over the pair inventory.

```ts
export const lightTokens: Tokens = {
  ...tokens,
  color: {
    ...tokens.color,
    bg: {
      base:    '#FAF6EE',
      surface: '#FFFDF8',
      raised:  '#F3EEE2',
      sunk:    '#EBE4D5',
    },
    border: {
      subtle:  '#E7E0D0',
      default: '#D8CFB9',
      strong:  '#A89A7C',
    },
    text: {
      primary:   '#1F1B12',
      secondary: '#5C5547',
      muted:     '#665F50', // darkened from #857C6A to clear AA on every light surface
      inverse:   '#FFFDF8',
    },
    accent: {
      ...tokens.color.accent,
      default: '#8C5215',   // darkened so amber-pill + white text and the accent/15 chip both clear 4.5:1
      hover:   '#774511',
      active:  '#683C0E',   // explicit override — inherited dark #D9974A is too light for inverse text on light
      muted:   '#7A5C32',   // explicit override — keep light's inverse text legible after dark muted lightened
      ring:    '#8C5215CC', // light accent at 80% alpha; the dark ring color is washed out over light, and light needs more of it to clear 3:1
    },
    status: {
      ...tokens.color.status,
      focused: '#477036',   // each darkened until ≥4.5:1 as text on bg-surface
      warning: '#7D6314',
      alerted: '#A24238',
      online:  '#477036',
    },
    overlay: {
      ...tokens.color.overlay,
      glass: '#FFFDF8CC',   // explicit override — dark glass band on VideoTile figcaption is muddy under light
    },
  },
  shadow: {
    ...tokens.shadow,
    // Warm-canvas-tinted shadows at low alpha. Dark theme shadows (rgba(0,0,0,…))
    // look muddy on near-white surfaces.
    sm: '0 1px 2px rgba(43, 35, 23, 0.10)',
    md: '0 4px 12px rgba(43, 35, 23, 0.12)',
    lg: '0 12px 32px rgba(43, 35, 23, 0.18)',
  },
}
```

A `theme: "dark" | "light" | "auto"` setting decides which token map is active; the active map writes CSS variables on `:root`. Switching theme is a re-render of the variable layer, no component code changes.

## 3. Stack and pinned versions

| Concern | Choice | Version floor | Notes |
|-|-|-|-|
| UI framework | React | 19.x | Vite 8+ |
| CSS engine | Tailwind CSS | v4.x | Native CSS layers, variable-based theming |
| Component primitives | shadcn/ui (Radix) | latest as of V1-P2 | Vendored under `src/components/ui/` |
| Icons | lucide-react | 0.x latest | Stroke 1.5, default size 16 |
| Font (sans) | Inter Variable | via @fontsource-variable/inter | Bundled, no CDN. Static `@fontsource/inter` is NOT used. |
| Font (mono) | JetBrains Mono | via @fontsource-variable/jetbrains-mono | Used only for BIP39 display + debug log. |
| Motion | Tailwind transitions | (built-in) | V1 uses Tailwind transition utilities for the ≤5 motion uses (see §6); framer-motion is not a V1 dep. Reduced-motion mode + any heavier motion library deferred to V3. |
| State | Zustand | 5.x | Picked default; Jotai acceptable substitute |

Bumps are fine; downgrades are not without reason.

## 4. Component inventory

Two layers, with a wall between them.

### `src/components/ui/` — primitives (vendored shadcn)

These are the only components allowed to read raw HTML / Radix primitives. Modify only via tokens. Never reach past this layer when building features.

| Component | Notes |
|-|-|
| `Button` | Variants: `default`, `secondary`, `ghost`, `destructive`, `outline`, `link`. Sizes: `default`, `xs`, `sm`, `lg`, `icon`, `icon-xs`, `icon-sm`, `icon-lg`. |
| `Input` | Single-line text. |
| `Textarea` | |
| `Label` | |
| `Dialog` | Modal centered. Backdrop is `overlay.scrim`. |
| `Sheet` | Side-panel sliding modal. |
| `Popover` | Floating anchor. |
| `DropdownMenu` | |
| `Tooltip` | Default delay 400 ms. |
| `Toast` | `sonner`-backed (`src/components/ui/sonner.tsx`). Bottom-right. Auto-dismiss 4 s default. |
| `Avatar` | With fallback initials. Always circular, sizes 24/32/48. |
| `Badge` | Pill. Variants: `default`, `secondary`, `destructive`, `outline`, `ghost`, `link`. Status-toned variants (focused / warning / alerted) are V2 polish. |
| `Switch` | |
| `Checkbox` | Square check control (distinct from `Switch`; boolean opt-in). |
| `Slider` | |
| `RadioGroup` | One-of-N selection. Used by Settings → Appearance (theme) and Settings → Network (TURN preference). |
| `Tabs` | |
| `ScrollArea` | Custom scrollbars, themed. |
| `Separator` | |
| `Card` | |
| `Progress` | |
| `Skeleton` | Loading placeholder block — the app's only sanctioned loading affordance, no spinners (§6, §10). |
| `Kbd` | Inline keyboard-cap rendering for shortcut hints. |

### `src/components/` — app-specific (composed, never raw)

These components only import from `ui/`, `design/tokens.ts`, and shared utilities. They do not touch Radix, raw HTML beyond layout, or arbitrary colors.

| Component | Purpose |
|-|-|
| `VideoTile` | One peer's video + name + per-tile status dot + PTT indicator. |
| `VideoGrid` | Mesh layout of tiles (1, 2, 3, or 4). Aspect-aware. |
| `WaitingTile` | Calm "waiting for your friend" tile shown beside the self tile when alone in an active session. §10 empty-state pattern, no spinner. `invite` / `reconnect` variants. |
| `AudioOutputPicker` | Speaker/headphone output selector for the session footer (`setSinkId`). Feature-detected — renders nothing where unsupported (macOS WKWebView). |
| `AudioDevicePicker` | Session-footer dropdown that swaps the active microphone mid-session without renegotiating SDP; refreshes on `devicechange`. |
| `FocusIndicator` | Per-tile dot: `focused` / `warning` / `alerted` / `offline`. |
| `PttIndicator` | Visible while a peer is transmitting audio. |
| `SelfWarningBadge` | Silent, off-task-user-only warning surface, fixed bottom-right above the audit panel; `aria-live=polite`, presentational (TTL owned by the alerts store). |
| `BreakCountdownBadge` | Fixed bottom-right countdown badge while an approved break is active; ticks mm:ss once per second. |
| `MediaErrorBanner` | Inline recovery banner when camera/mic acquisition fails at session join; calm copy keyed on the error name + "Try again". |
| `ScreenCapturePermissionOverlay` | Dialog tutorial for the macOS screen-recording grant when `getDisplayMedia` is denied; deep-links to System Settings, textual fallback elsewhere. |
| `AuditLogPanel` | Right-rail panel listing `AuditEvent`s. |
| `AuditLogRow` | Single event with avatar + action + timestamp. |
| `AiStatusChip` | Persistent read-out of whether the camera is being analyzed (`off` / `active` / `paused` / `error`); status by icon + label, never color alone. |
| `AiTextBox` | Floating dialog for `Ctrl+]` AI input. Renders in always-on-top window. |
| `AiResponseBubble` | AI's text reply in the same dialog. |
| `ScoreGauge` | Post-session arc gauge from 0–100. |
| `SessionTimer` | Pomodoro timer with phase indicator, broadcaster badge if you're broadcasting. |
| `PairQrCode` | Renders an arbitrary string as a scannable QR image (`Skeleton` placeholder while encoding). Generic — knows nothing about pairing. |
| `PairQrScanner` | Opens the webcam and scans each frame for a QR code, firing `onDecode` with the raw payload; releases the camera on unmount / first decode. |
| `RelayDiagnostics` | Settings → Network: live per-relay connection status (one row per signaling WebSocket, polled while mounted). Status by glyph + text, never color alone. |
| `OnboardingStep` | Full-bleed onboarding surface, single CTA, optional secondary. |
| `BipBackupPanel` | Mono-font 24-word display + copy + "I've saved them" confirmation. Standalone component (`src/components/BipBackupPanel.tsx`), imported by `IdentitySetup.tsx`, with its own Storybook story. |
| `SettingsLayout` | Left rail + right pane shell. |
| `SettingsRow` | Label + control + helper text. |
| `KeybindCapture` | Listens for next key combo, displays `Kbd`s. |
| `Disclosure` | Native default-collapsed `<details>` disclosure (Settings → Network → Advanced, AI model guide); instant chevron rotation, no transition. |
| `TitleBar` | Opt-in custom window chrome: §15 wordmark left, OS-correct controls (macOS keeps the native traffic lights, Windows renders min / restore / close), drag region between. |
| `UpdateReadyBanner` | Quiet "update ready" banner (X6) shown once the new version is downloaded and signature-verified; `Restart now` / `Later`, never mid-session. |
| `ErrorBoundary` | Class-component render-fault boundary: catches an uncaught render throw, keeps the app shell mounted, offers a retry that remounts the subtree. |
| `Logo` | App mark: rounded square + focus dot, sizes 24/32/48/96, `monochrome` variant. |

Feature-owned surfaces — the friends list, the add-friend flow, the model picker (its download and benchmark progress render inline on the card, not as a separate component), cross-session focus insights, the identity-load-error screen, and the onboarding / settings / session views — live under `src/features/*`, obey the same wall (`eslint.config.js` applies the Radix restriction tree-wide), and are exhibited in Storybook rather than enumerated here.

## 5. Themes

Three modes wired through the same token map:

- **Dark** (default) — `tokens` from §2.
- **Light** — `lightTokens` from §2.
- **Auto** — follows OS via Tauri's `theme()` helper and the `prefers-color-scheme` media query.

Theme switch is purely a re-render of the variable layer; component logic does not branch on theme.

## 6. Motion

Use motion only when it serves comprehension. Five permitted uses:

1. **Modal / dialog enter-leave**: `fast` duration, `out` easing, fade + zoom-in. Wired through `tw-animate-css` (V3-P8); `--tw-enter-duration` / `--tw-exit-duration` map to `--duration-fast` in `src/design/index.css`.
2. **Sheet / side-panel enter-leave**: `base` duration, `out` easing, slide-from-edge. Same plugin; the Sheet primitive overrides duration to `base` per side.
3. **AI dialog appear**: `base` duration, `out` easing, fade-in (no slide; positional stability). Same plugin family; the floating Tauri window inherits the fade.
4. **Audit log new row**: `fast` duration, `out` easing, fade + 6-px slide-down. New row only — no re-shuffles.
5. **Post-session score reveal**: `reveal` duration, `spring` easing, gauge sweep from 0 to final score. Sound: none. Implemented directly in `ScoreGauge` using `tokens.motion.duration.reveal` + `tokens.motion.easing.spring`.

State-change transitions on `color` / `background-color` / `border-color` / `opacity` are also allowed for discrete UI state changes (hover, focus, selected / `aria-current`, transient indicator visibility such as the PTT mic dot or a progress-step fill), with `duration: fast` and `easing: out`. These are not animations — they soften the swap between two stable states.

Everything else — layout, transform, and decorative motion — is instant. No card lifts, no slide-ins, no scale-on-hover, no bounces, no spinning loaders (use the vendored `Skeleton` primitive instead — `src/components/ui/skeleton.tsx`). Recharts is configured with `isAnimationActive={false}` so the stats bars paint without an entrance sweep. Reduced-motion (V3-P7) is the global kill switch: `[data-reduce-motion='true']` on `<html>` collapses every transition and animation to ~1ms via `@layer base` in `index.css`, so any motion site is gated by default — new sites never need per-component handling.

## 7. Six rules that keep it consistent

1. **All color, spacing, font, radius, shadow, motion values come from `tokens.ts`.** No hex codes, no `px` literals, no `cubic-bezier` strings outside the tokens file. Pre-commit: `scripts/check-tokens.ts` greps the codebase and fails the build on violations.
2. **All primitives come from `src/components/ui/`.** Application code imports from `components/`, `components/` imports from `ui/`. Reverse imports are an ESLint error.
3. **One typeface, one accent.** A new design that needs a second accent color or a third font is a redesign — open a discussion, not a hex value.
4. **Every primitive and composed component gets a Storybook story** (V1-P2 sets up Storybook + the lint rule). `npm run check-a11y` runs axe-core over every story that exists in CI, but there is no automated coverage gate — a component that ships without a story is caught in review, not by a build check.
5. **`/style` dev route shows every `ui/` primitive and every status state side by side.** Smoke-check before each release; visible in dev builds, hidden in production. Keeps primitive-layer drift visible. Composed app components (`src/components/*`, the AI dialog, the audit panel, ScoreGauge, etc.) live in Storybook stories — that's the canonical exhibit for the composed layer, and the same a11y / visual axe-core gate runs against it (`npm run check-a11y`). Reducing `/style`'s scope to `ui/` keeps the dev route fast to walk without losing coverage.
6. **No inline `style={...}` with raw values.** All styling is Tailwind classes (which derive from the token map) or component variants. Inline `style` allowed only for genuinely dynamic numeric values (e.g. video tile aspect ratio); ESLint rule forbids string literals in `style`.

## 8. Wireframes (ASCII)

### 8.1 Onboarding — step 3 of 5 (BIP39 backup)

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│                                                                  ··· │
│                                                                      │
│                                                                      │
│                Save these 24 words somewhere safe                    │
│                                                                      │
│       If you lose this laptop, these words are the only way to       │
│        recover this identity. Pen and paper. No cloud sync.          │
│                                                                      │
│                                                                      │
│   ┌────────────────────────────────────────────────────────────┐    │
│   │  01 ocean        09 quartz       17 lantern               │    │
│   │  02 ladder       10 fountain     18 pebble                │    │
│   │  03 cinnamon     11 pencil       19 vapor                 │    │
│   │  04 trumpet      12 bridge       20 oasis                 │    │
│   │  05 cobalt       13 mosaic       21 cipher                │    │
│   │  06 hammock      14 thistle      22 maple                 │    │
│   │  07 pine         15 rumor        23 garnet                │    │
│   │  08 mirror       16 saffron      24 horizon               │    │
│   │                                                            │    │
│   │                       [ Copy to clipboard ]                │    │
│   └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│                                                                      │
│       ☐ I've saved these words. I understand losing them              │
│         means losing this identity.                                  │
│                                                                      │
│                                                                      │
│                                              [Back]   [Continue]    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

Mono font for the wordlist. Accent only on the active "Continue" button (disabled until checkbox is true).

### 8.2 Friends list (idle, in tray-restored window)

```
┌──────────────────────────────────────────────────────────────────────┐
│  StudyVis                                              ─  □  ✕      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Friends                                          [+ Add friend]   │
│   ─────────                                                          │
│                                                                      │
│   ●  Alice                       last together · yesterday          │
│      Available                                       [ Invite ]    │
│   ─────────────────────────────────────────────────────────────     │
│   ●  Bo                          last together · 4 days ago         │
│      Available                                       [ Invite ]    │
│   ─────────────────────────────────────────────────────────────     │
│   ○  Mei                         last together · 2 weeks ago        │
│      Offline                                                         │
│   ─────────────────────────────────────────────────────────────     │
│                                                                      │
│                                                                      │
│                                                                      │
│   Settings                                                Theme: ●  │
└──────────────────────────────────────────────────────────────────────┘
```

Online dot uses `status.online`; offline uses `status.offline`. The Invite button on online friend rows is always visible at reduced emphasis (`outline` variant at rest) so the action is discoverable on first look and reachable on touch, and elevates to the `accent` fill on row hover / keyboard focus to keep the list calm.

### 8.3 Session view (3 peers, AI off — V1)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Studying with Alice, Bo                              ─  □  ✕      │
├──────────────────────────────────────────────────────────────────────┤
│                                                  ┌────────────────┐ │
│ ┌─────────────────┐  ┌─────────────────┐         │   Session log  │ │
│ │                 │  │                 │         ├────────────────┤ │
│ │     [video]     │  │     [video]     │         │ 00:00 You join │ │
│ │                 │  │                 │         │ 00:03 Alice j. │ │
│ │ ●  You          │  │ ●  Alice        │         │ 00:21 Bo joins │ │
│ └─────────────────┘  └─────────────────┘         │ 12:10 Bo break │ │
│                                                  │ 12:15 Bo back  │ │
│ ┌─────────────────┐                              │                │ │
│ │                 │                              │                │ │
│ │     [video]     │                              │                │ │
│ │                 │                              │                │ │
│ │ ●  Bo           │                              │                │ │
│ └─────────────────┘                              │                │ │
│                                                  └────────────────┘ │
│                                                                      │
│  hold ⌘[  to talk        ⏱  free-form         [ Pomodoro ▾ ] [Leave]│
└──────────────────────────────────────────────────────────────────────┘
```

Tile dot is `status.focused` (sage green) for V1 since AI is off; in V2 it shifts based on AI judgment.

### 8.4 Floating AI dialog (V2, `Ctrl+]`)

```
                            ┌──────────────────────────────────┐
                            │  Ask the AI                    × │
                            ├──────────────────────────────────┤
                            │                                  │
                            │  > 5 minute water break please   │
                            │                                  │
                            │                                  │
                            │  ─────────────                   │
                            │                                  │
                            │  Approved · 5 minutes.           │
                            │  You've been working for 28 min, │
                            │  this is your second break.      │
                            │                                  │
                            └──────────────────────────────────┘
```

This window:
- Transparent, no decorations, always-on-top.
- macOS: `canJoinAllSpaces | fullScreenAuxiliary`.
- Centered on the active screen.
- `Esc` closes; `Enter` submits; click outside also closes.

### 8.5 Settings — appearance pane

```
┌──────────────────────────────────────────────────────────────────────┐
│  Settings                                              ─  □  ✕      │
├────────────────┬─────────────────────────────────────────────────────┤
│  YOU           │                                                     │
│  ◦ Identity    │   Appearance                                        │
│  ◦ Friends     │   ───────────                                       │
│  STUDY         │                                                     │
│  ◦ Sessions    │   Theme                                             │
│  ◦ Stats       │     ○  Dark   ○  Light   ●  Auto (follow system)    │
│  ◦ AI          │                                                     │
│  APP           │   Reduce motion           [  ◐  ]                   │
│ ▌◦ Appearance  │     Replaces transitions with fades.                │
│  ◦ Notificat…  │                                                     │
│  ◦ Shortcuts   │   Window                                            │
│  SYSTEM        │   ───────                                           │
│  ◦ Network     │   Window style   ● System  ○ Custom                 │
│  ◦ Advanced    │   Remember size and position   [  ◐  ]              │
│  ◦ About       │   Window size                       [ Reset ]       │
└────────────────┴─────────────────────────────────────────────────────┘
```

Settings categories: eleven panes in four nav groups — **You** (Identity, Friends), **Study** (Sessions, Stats, AI), **App** (Appearance, Notifications, Shortcuts), **System** (Network, Advanced, About). Each nav item carries a 16px stroke-1.5 lucide glyph (`◦` above); the active item gets `bg.raised` + medium weight + a 2px accent edge (`▌`), never color alone. A search field tops the rail: it filters the panes by label, group heading, and a set of concept keywords (so "theme", "window size", "ptt", "relay" each resolve — the query is tokenised, matching when every whitespace-separated token lands in some searchable text) and is keyboard-first — type, `ArrowDown` into the list, arrow through it, `Enter` to open the first match, `Esc` to clear the query before it bubbles up to close the panel. A non-matching query shows a calm "No settings match." line; a polite live region announces the result count. AI is hidden in V1. Stats (added in V3-P1) is a local-only dashboard computed from the on-device sessions + friends tables; it transmits nothing. About shows app version + license string + a link to GitHub Releases (added in V1-P12). The Appearance pane hosts a second **Window** section: window style (V3-P6 custom chrome), remember-window-layout (on by default; geometry restored by Rust at boot before `show()`), and reset-to-default-size.

## 9. Iconography

- **Source**: `lucide-react` only.
- **Stroke**: 1.5.
- **Sizes**: 14, 16 (default), 20, 24. No other sizes.
- **Color**: inherits text color via `currentColor`. Status icons may take a status-token color.
- **Custom**: only the StudyVis logo (a small mark — designed in V1-P2). No other custom icons in V1–V2.

## 10. Empty / loading / error states

Every component that fetches or computes anything async ships three states:

- **Empty**: `text.secondary` copy, no-op CTA when applicable. Friend list with zero friends shows: *"Add a friend to start studying together."* with the same `[+ Add friend]` button as the populated state.
- **Loading**: shadcn `Skeleton` shaped like the eventual content. No spinners. No "loading…" text.
- **Error**: inline `Toast` for transient errors. For blocking errors (no internet during pairing), a small inline banner with a `Retry` button. Never a modal-of-doom.

## 11. Accessibility

- Every interactive element keyboard-reachable (Tab order matches DOM order; `tabIndex={0}` only when needed).
- Visible focus ring on the focused element, painted by `focus-visible:ring-3 focus-visible:ring-accent-ring` (the `shadow.glow` token describes the same 3px/`accent.ring` geometry but is not what the primitives use). Implementation uses the existing tokens via per-component `focus-visible:` utilities (every primitive in `src/components/ui/` and the V3-P6 `<TitleBar />` controls ship one); the global `:focus-visible { outline: none }` reset relies on this convention. The axe-core gate (`npm run check-a11y`) covers DOM and ARIA semantics; pixel-level focus-indicator visibility is verified by manual walk-through on the live app.
- Icon-only buttons get `aria-label`.
- Color contrast ≥ WCAG AA on all text + background pairings (verified by `scripts/check-contrast.ts` over both themes; V3-P5).
- Dynamic events (audit log) use `role="log"` + `aria-live="polite"`; alerts use `role="alert"` + `aria-live="assertive"`; status surfaces (AI response bubble, self-warning badge, break countdown) use `role="status"` + `aria-live="polite"`.
- Dialog focus trap + focus-restore-on-close via Radix.
- No information conveyed by color alone — status dots also have shape (●/○) or label.
- One `h1` per route, no skipped levels. `Home`/`SessionView` use a visually-hidden `h1`; other routes have visible headings.
- Reduced motion (V3-P7): `[data-reduce-motion='true']` on the document element collapses every animation and transition to ~1ms via a `@layer base` CSS rule. The attribute is set OR-of-two-sources (the V1-P11 setting and `prefers-reduced-motion: reduce`), pre-painted by an inline script in `index.html` / `ai-dialog.html`, kept in sync after hydration by `<ApplyReduceMotion />` (the central source in `src/design/reduce-motion.ts`). Because the kill switch is CSS-driven and not per-component, new motion sites are gated by default — no future component can forget.

V3 ships: full screen-reader pass, reduced-motion mode, axe-core CI gate over every Storybook story. Customizable font sizing is **deferred to post-1.0**.

## 12. Layout grids

- **Window minimum**: 1024 × 640.
- **Window default on first launch**: 1280 × 800.
- **Content max width** (onboarding): 1200 (`sizes.contentMaxWidth`).
- **Reading max width** (Home/FriendsList, Report, other text-dense screens): 896 (`sizes.readingMaxWidth`). A 1200-wide measure on a list of friends or a report timeline hurts readability; these screens share one narrower measure instead of the page max.
- **Settings max width** (settings pane content): 768 (`sizes.settingsMaxWidth`). Settings rows pair a left label with a right-aligned control; at 1200 the control sat ~700 px from its label at the window minimum, so settings use a tighter measure than onboarding. All three come from `tokens.sizes` — no hard-coded `1200`/`896`/`768` literals anywhere in app code.
- **Audit log panel**: fixed 320 wide, full height of session view.
- **Sidebar (settings)**: fluid — `clamp(224px, 22vw, 280px)` (`sizes.settingsRailMinWidth` → `sizes.sidebarWidth`, expressed as `--settings-rail-width` in `src/design/index.css`). A fixed 280 was 27% of the window at the 1024 minimum and squeezed the content column below its 768 measure; wide windows still get the full 280.
- **Video grid**: flex; tiles maintain a minimum aspect 16:9 and a clamped height (180–360 px).
- **Spacing**: page padding `space.5` (24); section gap `space.6` (32); inline gap `space.3` (12). The route shells (Home, Onboarding, Report) use `px-4 py-4 sm:px-6 sm:py-6` so the page padding steps down to `space.4` (16) below the `sm` breakpoint — a deliberate responsive concession; ≥ `sm` (the realistic minimum window) is on-grid at `space.5`. The Settings pane uses a constant `px-6 py-6`: its `sm:` step-down could never trigger inside the 1024-minimum window, and dead phone branches mislead edits (the same rationale removed the `sm:` variants inside the settings categories and the dialog/input primitives).
- **Custom titlebar (V3-P6, opt-in)**: 38 px tall (`sizes.titleBarHeight`). macOS reserves 78 px on the left (`sizes.titleBarMacInset`) for the system traffic-light cluster; the wordmark sits to its right. Windows hosts the app-painted min/restore/close cluster on the right edge. Native chrome is the default; this row of the grid only applies when the user has opted in.

## 13. Sound

V1 sounds:
- Incoming invite notification: OS-native via `tauri-plugin-notification`.
- Peer-alert ping (V2): a short, soft tone — designed in V2-P6 with a focus on "noticeable but not jarring." Stored as `assets/sounds/peer_alert.opus`.

No background music, no UI click sounds, no error chimes.

## 14. Copy and tone

Short, direct, second person, no hype. The product is for friends; sound like a friend wrote it. Every user-facing string lives in `src/strings.ts` — that's the single source of truth (V3-P8). The `scripts/check-strings.ts` guard runs in pre-commit and fails the build when raw `toast(…)` / `sendNotification(…)` literals slip into components; hoist them into the strings module and reference.

| Avoid | Prefer |
|-|-|
| "Welcome to StudyVis! 🎉" | "Let's set you up." |
| "Oops, something went wrong." | "Couldn't reach Alice. Try again?" |
| "You have successfully created your identity." | "Identity ready." |
| "Click here to add a friend!" | "Add a friend" (button label) |
| "Your AI focus score is 87/100" | "87 / 100" (on the score gauge) |
| "Could not save your name." | "Couldn't save your name." (use contractions) |
| "AI failed to start" | "AI failed to start." (period on full sentences) |

Period at the end of full sentences, none on labels, none on button text. Use contractions — "Couldn't" reads as a friend; "Could not" reads as a form letter.

## 15. Brand mark

- Wordmark: "studyvis" lowercase, `font.weight.semibold`, `font.letterSpacing.tight`, in `text.primary`.
- Standalone mark: a small geometric form to be drafted in V1-P2 (placeholder: a sage-green circle inscribed in an amber square at radius `lg`). Designed once, used in installer icon + tray icon + about dialog.
- Tray icon: monochrome, 16/20/22/24 px depending on OS, white on dark systems, dark on light.

## 16. What changes when

- **Token additions**: bump a minor version number in `tokens.ts` comment header. Note in `CHANGELOG.md` (added in V1 polish).
- **Token replacements** (e.g. accent hue changes): require updating wireframes here, reviewing affected components, and a `/style` page diff.
- **New component in `ui/`**: requires a Storybook story, a `/style` page entry, and an ESLint allowlist update (because `ui/` is the only place Radix imports are allowed).
- **New component in `components/`**: requires a Storybook story.
- **Theme variant additions** (e.g. sepia): treated as a new release feature, not a tokens.ts edit.

## 17. Keybindings

Two global shortcuts, registered in the system layer via `tauri-plugin-global-shortcut` so they fire even when the StudyVis window is not focused. Their registration windows differ (#47 B5):

| Action | macOS | Windows / Linux | Registered |
| --- | --- | --- | --- |
| Push to talk · friends | `⌘ [` | `Ctrl [` | Only while a session is live — registered on session start, released on end, so a tray-idle StudyVis never swallows `⌘ [` ("back" in Safari/Finder/IDEs) system-wide. |
| Talk to AI | `⌘ ]` | `Ctrl ]` | For the app's lifetime, gated by the AI-features flag; opens the floating AI dialog window (V2-P7). |

**Conflicts to know about.** During a session, the friends-PTT shortcut wins over app-level `⌘ [` bindings in whatever app is foreground. This is intentional: PTT must be reliable mid-session regardless of focus. Both shortcuts are rebindable in Settings → Shortcuts (V3-P3).

**Surface in the UI.** Show the active binding via `<Kbd>` in any session-time UI that mentions PTT (the wireframe footer in §8.3, the onboarding tutorial). The label derives from the persisted binding — never hardcode the default. Use the `⌘` glyph on macOS, the literal `Ctrl` on other platforms — match the OS-native rendering convention.
