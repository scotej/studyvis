# StudyVis — Design System

> Companion to `PLAN.md` and `ARCHITECTURE.md`. This file is the visual + interaction source of truth. Everything that renders in the app obeys what's written here. If you're tempted to introduce a new color, a new font weight, or a new spacing value: don't — extend the token file instead, with reasoning.

## 1. Direction

**Calm Dark — Linear × Things 3.**

Reasoning, in order:
1. **Calm**: this is a focused-work app. The UI must not compete with the user's study material for attention.
2. **Dark by default**: study sessions skew evening / night; long sessions reward low eye-strain.
3. **Warm, not corporate**: friends-only. The aesthetic should feel personal and a bit cozy, not Slack-grey.
4. **Native chrome v1**: respect each OS's window decorations and system menus. Custom frameless chrome is V3 polish.
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
      base:    '#0F1115',   // app canvas
      surface: '#171A21',   // cards, side panels, list rows
      raised:  '#1F232C',   // hovered surfaces, popovers, dialogs
      sunk:    '#0B0D11',   // text input, scrollable content background
    },
    border: {
      subtle:  '#262A33',   // divider between rows
      default: '#2E333D',   // around cards, inputs
      strong:  '#3A4150',   // active focus ring (combined with accent glow)
    },
    text: {
      primary:   '#E5E7EB', // body, headings, important UI labels
      secondary: '#9CA3AF', // captions, helper text, timestamps
      muted:     '#6B7280', // placeholder, disabled, low-priority
      inverse:   '#0F1115', // text on accent-filled buttons
    },
    accent: {
      default: '#E8A87C',   // primary actions, focused outlines, brand accents
      hover:   '#F0B891',
      active:  '#D89B6F',
      muted:   '#7A5740',   // accent backgrounds at low opacity
      ring:    '#E8A87C66', // 40% alpha — focus ring
    },
    status: {
      focused: '#7FB069',   // sage green — "user is on task" tile dot
      warning: '#E8C547',   // amber — "self-warning" badge
      alerted: '#D9776A',   // muted red — "peers notified, score deducted"
      offline: '#6B7280',   // friend not currently reachable
      online:  '#7FB069',   // friend currently online (same as focused)
    },
    overlay: {
      scrim:    '#0006',    // 0% color, 40% alpha — modal backdrop
      glass:    '#171A21CC',// raised over scrim
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
    glow: '0 0 0 4px var(--accent-ring)', // focus ring glow
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
    contentMaxWidth:    1200,
    sidebarWidth:        280,
    auditPanelWidth:     320,
    videoTileMinHeight:  180,
    videoTileMaxHeight:  360,
  },
} as const

export type Tokens = typeof tokens
```

### Light theme (V1 ships toggle, default off)

```ts
export const lightTokens: Tokens = {
  ...tokens,
  color: {
    ...tokens.color,
    bg: {
      base:    '#FAFAF7',
      surface: '#FFFFFF',
      raised:  '#F4F4F0',
      sunk:    '#EDEDE8',
    },
    border: {
      subtle:  '#E5E5E0',
      default: '#D4D4CD',
      strong:  '#9CA3AF',
    },
    text: {
      primary:   '#0F1115',
      secondary: '#4B5563',
      muted:     '#6B7280',
      inverse:   '#FFFFFF',
    },
    // accent + status: same hues, slightly higher saturation for light bg contrast
    accent: { ...tokens.color.accent, default: '#C97A4D', hover: '#B86A3D' },
    status: { ...tokens.color.status, focused: '#5C8A4B', warning: '#B89531', alerted: '#B5564B' },
  },
}
```

A `theme: "dark" | "light" | "auto"` setting decides which token map is active; the active map writes CSS variables on `:root`. Switching theme is a re-render of the variable layer, no component code changes.

## 3. Stack and pinned versions

| Concern | Choice | Version floor | Notes |
|-|-|-|-|
| UI framework | React | 19.x | Vite 6 |
| CSS engine | Tailwind CSS | v4.x | Native CSS layers, variable-based theming |
| Component primitives | shadcn/ui (Radix) | latest as of V1-P2 | Vendored under `src/components/ui/` |
| Icons | lucide-react | 0.x latest | Stroke 1.5, default size 16 |
| Font (sans) | Inter Variable | via @fontsource-variable/inter | Bundled, no CDN. Static `@fontsource/inter` is NOT used. |
| Font (mono) | JetBrains Mono | via @fontsource-variable/jetbrains-mono | Used only for BIP39 display + debug log. |
| Motion | framer-motion | 12.x | Used for ≤5 places (see §6) |
| State | Zustand | 5.x | Picked default; Jotai acceptable substitute |

Bumps are fine; downgrades are not without reason.

## 4. Component inventory

Two layers, with a wall between them.

### `src/components/ui/` — primitives (vendored shadcn)

These are the only components allowed to read raw HTML / Radix primitives. Modify only via tokens. Never reach past this layer when building features.

| Component | Notes |
|-|-|
| `Button` | Variants: `default`, `secondary`, `ghost`, `destructive`. Sizes: `sm`, `md`, `lg`, `icon`. |
| `Input` | Single-line text. |
| `Textarea` | |
| `Label` | |
| `Dialog` | Modal centered. Backdrop is `overlay.scrim`. |
| `Sheet` | Side-panel sliding modal. |
| `Popover` | Floating anchor. |
| `DropdownMenu` | |
| `Tooltip` | Default delay 400 ms. |
| `Toast` | Bottom-right. Auto-dismiss 4 s default. |
| `Avatar` | With fallback initials. Always circular, sizes 24/32/48. |
| `Badge` | Pill, color variants from status tokens. |
| `Switch` | |
| `Slider` | |
| `Tabs` | |
| `ScrollArea` | Custom scrollbars, themed. |
| `Separator` | |
| `Card` | |
| `Progress` | |
| `Kbd` | Inline keyboard-cap rendering for shortcut hints. |

### `src/components/` — app-specific (composed, never raw)

These components only import from `ui/`, `design/tokens.ts`, and shared utilities. They do not touch Radix, raw HTML beyond layout, or arbitrary colors.

| Component | Purpose |
|-|-|
| `VideoTile` | One peer's video + name + per-tile status dot + PTT indicator. |
| `VideoGrid` | Mesh layout of tiles (1, 2, 3, or 4). Aspect-aware. |
| `FocusIndicator` | Per-tile dot: `focused` / `warning` / `alerted` / `offline`. |
| `PttIndicator` | Visible while a peer is transmitting audio. |
| `AuditLogPanel` | Right-rail panel listing `AuditEvent`s. |
| `AuditLogRow` | Single event with avatar + action + timestamp. |
| `AiTextBox` | Floating dialog for `Ctrl+]` AI input. Renders in always-on-top window. |
| `AiResponseBubble` | AI's text reply in the same dialog. |
| `ScoreGauge` | Post-session arc gauge from 0–100. |
| `FriendsList` | Scrollable list of friends, online dots, last-studied label. |
| `FriendRow` | Single friend with `Invite` button. |
| `AddFriendDialog` | 12-word generate / paste flow. |
| `OnboardingStep` | Full-bleed onboarding surface, single CTA, optional secondary. |
| `BipBackupPanel` | Mono-font 24-word display + copy + "I've saved them" confirmation. |
| `SessionTimer` | Pomodoro timer with phase indicator, broadcaster badge if you're broadcasting. |
| `ModelPicker` | (V2) Radio cards: name, size, RAM, measured speed badge. |
| `BenchmarkRunner` | (V2) 30-second benchmark progress display. |
| `SettingsLayout` | Left rail + right pane shell. |
| `SettingsRow` | Label + control + helper text. |
| `KeybindCapture` | Listens for next key combo, displays `Kbd`s. |

## 5. Themes

Three modes wired through the same token map:

- **Dark** (default) — `tokens` from §2.
- **Light** — `lightTokens` from §2.
- **Auto** — follows OS via Tauri's `theme()` helper and the `prefers-color-scheme` media query.

Theme switch is purely a re-render of the variable layer; component logic does not branch on theme.

## 6. Motion

Use motion only when it serves comprehension. Five permitted uses:

1. **Modal / dialog enter-leave**: `fast` duration, `out` easing, fade + 4-px slide-up.
2. **Sheet / side-panel enter-leave**: `base` duration, `out` easing, slide-from-edge.
3. **AI dialog appear**: `base` duration, `out` easing, fade-in (no slide; positional stability).
4. **Audit log new row**: `fast` duration, `out` easing, fade + 6-px slide-down. New row only — no re-shuffles.
5. **Post-session score reveal**: `reveal` duration, `spring` easing, gauge sweep from 0 to final score. Sound: none.

Everything else: instant. No hover bounces, no card lifts, no spinning loaders (use shadcn's `Skeleton` instead). Reduced-motion preference (V3) replaces all of the above with simple opacity changes.

## 7. Six rules that keep it consistent

1. **All color, spacing, font, radius, shadow, motion values come from `tokens.ts`.** No hex codes, no `px` literals, no `cubic-bezier` strings outside the tokens file. Pre-commit: `scripts/check-tokens.ts` greps the codebase and fails the build on violations.
2. **All primitives come from `src/components/ui/`.** Application code imports from `components/`, `components/` imports from `ui/`. Reverse imports are an ESLint error.
3. **One typeface, one accent.** A new design that needs a second accent color or a third font is a redesign — open a discussion, not a hex value.
4. **Every component has a Storybook story.** Adding a component without a story fails the PR check (V1-P2 sets up Storybook + the lint rule).
5. **`/style` dev route shows every primitive and every status state side by side.** Smoke-check before each release; visible in dev builds, hidden in production. Keeps drift visible.
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

Online dot uses `status.online`; offline uses `status.offline`. Invite button is `accent` variant; appears only on hover for online friends to keep the list calm.

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
│                │                                                     │
│  Identity      │   Appearance                                        │
│  Friends       │   ───────────                                       │
│  Sessions      │                                                     │
│ ▶ Appearance   │   Theme                                             │
│  Notifications │     ○  Dark   ○  Light   ●  Auto (follow system)    │
│  Shortcuts     │                                                     │
│  AI            │   Reduce motion           [  ◐  ]                   │
│  Network       │     Replaces transitions with fades.                │
│  Advanced      │                                                     │
│                │                                                     │
│                │                                                     │
│                │                                                     │
└────────────────┴─────────────────────────────────────────────────────┘
```

Settings categories visible: Identity, Friends, Sessions, Appearance, Notifications, Shortcuts, AI (V2), Network, Advanced. AI is hidden in V1.

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

## 11. Accessibility (V1 minimums)

- Every interactive element keyboard-reachable (Tab order matches DOM order; `tabIndex={0}` only when needed).
- Visible focus ring (`shadow.glow` + `border.strong`) on focused element.
- Icon-only buttons get `aria-label`.
- Color contrast ≥ WCAG AA on all text + background pairings (verify in V1-P2 with a color-pair check script).
- Dynamic events (audit log row arriving) use `aria-live="polite"`.
- Dialog focus trap via Radix.
- No information conveyed by color alone — status dots also have shape (●/○) or label.

V3 adds: full screen-reader pass, reduced-motion mode, customizable font sizing.

## 12. Layout grids

- **Window minimum**: 1024 × 640.
- **Window default on first launch**: 1280 × 800.
- **Content max width** (settings panes, onboarding): 1200.
- **Audit log panel**: fixed 320 wide, full height of session view.
- **Sidebar (settings)**: fixed 280 wide.
- **Video grid**: flex; tiles maintain a minimum aspect 16:9 and a clamped height (180–360 px).
- **Spacing**: page padding `space.5` (24); section gap `space.6` (32); inline gap `space.3` (12).

## 13. Sound

V1 sounds:
- Incoming invite notification: OS-native via `tauri-plugin-notification`.
- Peer-alert ping (V2): a short, soft tone — designed in V2-P6 with a focus on "noticeable but not jarring." Stored as `assets/sounds/peer_alert.opus`.

No background music, no UI click sounds, no error chimes.

## 14. Copy and tone

Short, direct, second person, no hype. The product is for friends; sound like a friend wrote it.

| Avoid | Prefer |
|-|-|
| "Welcome to StudyVis! 🎉" | "Let's set you up." |
| "Oops, something went wrong." | "Couldn't reach Alice. Try again?" |
| "You have successfully created your identity." | "Identity ready." |
| "Click here to add a friend!" | "Add a friend" (button label) |
| "Your AI focus score is 87/100" | "87 / 100" (on the score gauge) |

Period at the end of full sentences, none on labels, none on button text.

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

V1 ships two global shortcuts. Both are registered in the system layer via `tauri-plugin-global-shortcut` and fire even when the StudyVis window is not focused — that is the point.

| Action | macOS | Windows / Linux | State (V1) |
| --- | --- | --- | --- |
| Push to talk · friends | `⌘ [` | `Ctrl [` | Press unmutes mic, release mutes; the audio path lands in V1-P8. |
| Talk to AI | `⌘ ]` | `Ctrl ]` | Registered (key reserved on the user's machine) but the handler is a no-op. V2-P7 wires it to the floating AI dialog window. |

**Conflicts to know about.** `⌘ [` is "back" in many macOS apps (Safari, Finder, IDEs). When the StudyVis window has focus, the global shortcut wins and our PTT fires instead of the app-level back action. This is intentional: PTT must be reliable mid-session regardless of which app is foreground. Users who can't live with the conflict can rebind in Settings → Shortcuts (lands in V1-P11). Until then, the binding is fixed.

**Surface in the UI.** Show the active binding via `<Kbd>` in any session-time UI that mentions PTT (the wireframe footer in §8.3, the temporary debug panel that ships before V1-P11). Use `⌘` glyph on macOS, the literal `Ctrl` on other platforms — match the OS-native rendering convention.
