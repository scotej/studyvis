# Changelog

## 1.11.3-rc.3 — 2026-08-19 — Linux release candidate

### Added

- **StudyVis adds an x86_64 Linux AppImage release candidate.** CachyOS with KDE
  Plasma on Wayland is the reference Linux desktop. The packaged build includes
  a pinned WebRTC-enabled WebKitGTK 2.52.5 + librice 0.4.3 runtime and CPU-only
  llama.cpp engine, stores private credentials through the freedesktop Secret
  Service, and uses the KDE desktop portal + PipeWire for screen sharing and
  optional AI capture. Linux is not promoted to supported-release status by
  this implementation alone.
- **Every desktop artifact now carries a locked third-party notice inventory.**
  `THIRD-PARTY-NOTICES.txt` and its machine-readable JSON manifest cover the
  npm production tree, all three target-filtered normal Cargo closures, and the
  pinned llama.cpp runtime. Explicit version-bound handling includes vendored
  Wry's MIT alternative, Inter and JetBrains Mono's OFL texts, llama.cpp b9095,
  and victory-vendor's omitted root MIT plus all 13 nested licenses. CI
  regenerates offline and fails on drift; extracted-artifact checks require the
  packaged bytes and hashes. The inventory supports review but is not legal
  advice or sign-off. Linux's separately built librice libraries also carry a
  generated text/JSON inventory of the exact locked `rice-proto`/`rice-io`
  normal dependency union selected by `cargo-c`, including `capi` features,
  direct source checksums, and hash-checked license evidence.
- **StudyVis now offers to put you back into a session it closed on.** If the
  app quits or crashes while you are in a friend's session, the next launch
  opens on a full-screen prompt to rejoin that room or end it — nothing
  reconnects on its own. The record it uses is sealed to your own identity key,
  so the room's topic and password are never written to disk in the clear, and
  it expires after twelve hours. An ordinary Leave clears it; only quitting
  keeps it. Sessions you hosted are not offered, because the friends who stayed
  froze admission against your previous connection and cannot readmit a
  restarted app.

### Changed

- **A push-to-talk problem can now be diagnosed from the diagnostics you
  export.** The last report arrived with logs from both machines that showed
  push-to-talk working perfectly, because nothing recorded the layers between
  the app's own state and what you actually saw and heard. StudyVis now checks
  those layers against each other about once a second and writes a single
  labelled record the moment they disagree for more than a moment — a lit
  indicator over a muted microphone, a hold the two-minute cutoff ended, a key
  the system reports as released while the app is still transmitting. Exporting
  diagnostics also records what was live at the instant you clicked, and the
  macOS shortcut layer now writes its own entries, so an event the app sent and
  the interface never received is visible as the gap it is. A healthy session
  adds a handful of entries an hour; a stuck one is capped so it can never bury
  the history that explains it.

- **Discovery defaults now use the endpoints verified by the release health
  check.** Nostr no longer depends on `nos.lol` after it began requiring proof
  of work for anonymous events, and MQTT now pins three brokers that passed the
  same subscribe/publish/receive path used by rendezvous instead of inheriting
  `@trystero-p2p/mqtt`'s unavailable first default.
- **The Linux candidate now carries its production WebRTC runtime instead of
  trusting distro WebKitGTK.** Official distro release builds in the maintained
  path compile GTK's `ENABLE_WEB_RTC` peer-connection binding out while leaving
  the media-device API present; no runtime preference can reverse that compile
  gate. StudyVis therefore builds the bundled runtime from hash-verified
  WebKitGTK 2.52.5 (`8a531a9…f3364b`) and librice 0.4.3
  (`4671e183…1e3f4b`) sources plus the reviewed AppImage runtime portability
  patch (`907380c8…837eb8`). The patch resolves the packaged Web/Network/GPU
  subprocesses, injected bundle, and sandbox helpers relative to the AppImage
  executable before native fallbacks. The full hashes and source URLs live in
  `INSTALL.md` and `ARCHITECTURE.md`. The build keeps other experimental
  features off, preserves WebKit's Web/GPU/Network process sandbox, and packages
  an exact build manifest, the applied patch, librice licenses, and a
  readable/hash-addressed inventory of all 59 upstream WebKit license/notice
  files. Tagged builds also create a deterministic corresponding-source archive
  containing the exact upstream archives, full patch, pinned env, builder,
  manifest, reconstruction README, and internal checksums. A companion
  deterministic Linux system-source bundle inventories the finished AppImage's
  ELF/symlink/hash/build-ID and dynamic-link closure, maps Ubuntu bytes to exact
  package/source/copyright material, and includes pinned packaging-tool,
  AppRun, and llama.cpp sources/notices. Both archive/checksum pairs are
  mandatory and fail closed on an unmapped modeled byte, unavailable modeled
  source, or bad checksum. The system-source pair now includes StudyVis's
  source-built AppImage type-2 runtime revision 2: exact hash-pinned
  type2/musl/zlib/decompression-only-zstd/libfuse/squashfuse/Meson sources and
  licenses, exact Noble toolchain/CRT provenance, build metadata, a link map,
  and per-input hashes. Verification requires an `x86_64-linux-musl` static PIE
  with no interpreter or dynamic dependencies, using musl mallocng and no
  mimalloc. This completes the pre-SquashFS runtime's static source/notice/link
  closure. The hosted Noble image and apt indexes remain a bounded baseline,
  not a bit-reproducible environment, and the evidence is not legal sign-off.
  Because distro upgrades cannot service this copy, StudyVis now owns WebKitGTK/librice
  advisory response, rebuilds, license/source obligations, physical
  revalidation, and updater delivery.
- **The Linux build baseline is Ubuntu 24.04.** WebKit's librice ICE agent
  subclasses GStreamer's `GstWebRTCICE`, which exists only from GStreamer 1.22,
  while WebKit's own configure gate still accepts 1.20 — Ubuntu 22.04 therefore
  configured cleanly and failed hours later inside the unified build. The
  private WebKit runtime (now revision 5), the AppImage, and the source-built
  type-2 runtime (now revision 2, same sources and compiler generations
  re-pinned to Noble packages) all build on Ubuntu 24.04 with GStreamer 1.24,
  and the builder now asserts `gstreamer-webrtc-1.0 >= 1.22` up front. Noble's
  own GStreamer 1.24.2 then broke the final link of `libwebkit2gtk-4.1.so`:
  its `gst/webrtc/webrtc_fwd.h` ships without `G_BEGIN_DECLS`, so WebKit's C++
  translation units declared `gst_webrtc_error_quark()` with C++ linkage and
  emitted a mangled reference `libgstwebrtc-1.0`'s C symbol cannot satisfy.
  Upstream added the guard before 1.24.12 and Ubuntu 24.04 is frozen at 1.24.2
  in every pocket, so the portability patch now resolves that error domain by
  its documented quark name below 1.24.12. The
  AppImage consequently needs glibc 2.39 or newer — every rolling desktop,
  CachyOS included, already satisfies that — and no longer carries the
  `webrtcdsp` GStreamer element, which Ubuntu 24.04 does not ship and
  WebKitGTK never loads.
- **Linux peer-connection preferences and media permission are applied at the
  correct boundaries.** The vendored wry 0.55.1 constructor passes WebRTC and
  media-stream settings into `WebView::builder()` before the first document is
  created. The native permission bridge then handles only WebKit's user-media
  request class. Because WebKitGTK's public wrapper does not expose the
  requesting `SecurityOrigin` values, it checks the current top-level WebView
  URI: the exact bundled `tauri://localhost` URI (plus the fixed loopback dev
  URI in debug builds) can receive user-media permission, the same request is
  denied whenever the current top-level URI is external, the CSP keeps child
  frames self-only, and unrelated permission types stay at WebKit's default.
  Independently, a cross-platform trusted-navigation plugin rejects top-level
  navigation outside the exact production app origin (plus the fixed debug
  loopback origin); intended external links remain in the system opener.
- **Preview and tagged-release coverage now includes Linux.** Installable
  x86_64 AppImages are built beside macOS arm64 and Windows x86_64 artifacts;
  a release draft is incomplete until its signed updater manifest carries all
  three platform keys. Pull-request CI also builds and starts a packaged
  AppImage under Xvfb after checking a Secret Service round-trip. Release
  builds repeat the native inspection and first-document data-channel-offer
  startup check against the exact Linux AppImage they produced and uploaded.
  Release publication is blocked on the PLAN §8 physical CachyOS KDE Wayland
  matrix for the exact draft AppImage: an exchanged WebRTC data channel,
  bidirectional camera/microphone/screen media, AI capture, and same-draft
  Linux↔Linux, Linux↔macOS, and Linux↔Windows physical peer runs, plus launch,
  in-app key custody, bundled AI, and writable-AppImage update behaviour. A
  dedicated publication workflow now revalidates exact-commit CI, requires the
  latest `release.yml` run for the exact tag/commit to have succeeded after its
  uploaded-AppImage runtime smoke. That run now attests each downloadable build
  output and the final updater manifest. Publishing accepts the physical-test
  AppImage SHA-256, downloads the exact twelve expected assets, byte-compares the
  updater sidecars, verifies exact-workflow/tag/commit provenance for every
  asset, and re-downloads/re-hashes the AppImage immediately before making the
  draft public. On 2026-08-15, the required `release` environment, active
  `v*` lifecycle rule with its `Always` `RepositoryRole 5` (admin) bypass for
  the owner-scoped `RELEASE_PAT`, and immutable releases were configured.
  GitHub hides the bypass list from the workflow's read-only ruleset response,
  so an admin must verify that no broader bypass is configured. The physical
  candidate matrix remains a separate publication gate.
- **Linux install and support boundaries are documented end to end.** The
  install guide covers CachyOS dependencies, FUSE and extraction launch paths,
  Secret Service providers, KDE Wayland portals/PipeWire, automatic-update
  write permissions, and the current x86_64/CPU-only/native-package limits.

### Fixed

- **Expanding a shared screen now actually shows the screen.** The full-size
  viewer opened onto an empty box every time, because the video element it
  fills is created one frame after the dialog opens and the share was already
  running by then — so nothing ever handed it the picture. It is now wired up
  the moment the element exists, and the tile it was opened from keeps playing
  underneath. Expanding still puts the whole window into fullscreen, which is
  deliberate: a screen is only readable at that size.

- **The private "looking off-task" warning can now be waved off.** It ignored
  the mouse entirely, so the only way past it was to wait out its thirty-second
  timer. Hovering the card — or tabbing to it — now reveals an X that clears it
  immediately, matching the dismiss already on the same warning when it appears
  over another app.

- **Exported diagnostics no longer silently lose their most recent entries.**
  When more than 256 records were written at once — a burst is exactly what a
  problem produces — everything past the first 256 was discarded while the app
  recorded the write as successful. The newest entries are the ones a report
  needs, and they were the ones being dropped.

- **Diagnostics saved from Settings now identify their session.** They were
  always written without the session marker, so an archive from one machine
  could not be matched up with a friend's archive of the same session.

- **Push-to-talk can no longer stay lit after you let go.** On macOS StudyVis
  reads the real state of the key so a native release event that never arrives
  cannot leave your microphone open. It published each reading once and assumed
  it landed, so a single reading the app never received was treated as delivered
  and never sent again — leaving you shown as transmitting until the two-minute
  safety cutoff or your next session. Each reading is now repeated for a second,
  counted only once it is genuinely delivered, and a reading that says the key
  is up ends the hold even if StudyVis never saw the key go down.

- **Rejoining a session you just left no longer drops you into an empty room.**
  Accepting a fresh invite to the same room reuses its discovery topics exactly,
  and the old room's still-unwinding relay cleanup could delete the new room's
  subscription — permanently silencing that relay, so neither side ever saw the
  other. A leaving room now retracts only the subscription it registered itself.

- **A friend's shared screen comes back when you rejoin.** Rejoining a room you
  were already in replaces your earlier connection without ever reporting the
  old one as gone, so the replacement was treated as already served: your
  friend's screen never reappeared, and a share of your own was never re-sent
  to them. Every join is now treated as a fresh connection — the stale tile is
  retired, and the share has to be re-announced before it is re-attached.

- **Overlay notifications are no longer cut off after three lines.** The small
  window that shows session alerts over other apps was a fixed size with the
  message clamped to three lines, so anything longer was silently truncated
  with no way to read the rest. It now measures the message and sizes itself to
  fit; past a bounded maximum the text scrolls and can be reached from the
  keyboard.

## 1.11.2 — 2026-08-12 — More dependable study sessions

### Added

- **AI can now use the hardware you choose.** In Settings → AI, select
  Automatic, CPU, or a detected accelerator. The choice is remembered and
  used consistently for both live checks and benchmarks; Windows builds now
  include the cross-vendor Vulkan engine while retaining an explicit CPU
  fallback.

### Fixed

- **A friend leaving no longer ends the session for the person who stayed.**
  Zero connected friends is now a supported active solo state: the same room,
  camera, optional AI checks, elapsed time, Pomodoro, invitations, and Leave
  control remain available until the local user chooses to finish. The short
  Rejoin opportunity belongs only to someone who left; it never starts a
  countdown for the survivor.

- **Partner statistics no longer include a session's later solo time.** New
  session rows record each authenticated friend's actual overlap across
  leave/rejoin intervals, and “last studied with” advances when that overlap
  really ends. Existing rows without reliable overlap data retain their legacy
  interpretation instead of inventing precision or becoming unreadable.

- **In-session AI chat accepts replies from the local engine reliably.**
  Structured requests and bounded response handling keep valid local replies
  from being discarded, while timeouts and cancellations stay contained.

- **Push-to-talk is safer through duplicate or missing shortcut events.** A
  repeated press cannot mute an active hold, an ambiguous repeat fails closed
  instead of leaving the microphone live, and diagnostics now preserve the
  relevant shortcut and media timeline without recording speech.

- **Sessions, local AI, and connections recover more predictably at their
  boundaries.** The default relay pool has been refreshed; reconnects and host
  changes keep mesh membership bounded and authenticated; and stale sidecar,
  hardware, benchmark, or cleanup work cannot take over newer state.

## 1.11.1 — 2026-08-10 — Safer AI and steadier sessions

### Fixed

- **Settings confirmations now stay visible during a study session, and the
  floating AI chat follows Appearance changes immediately.** Dialogs no longer
  open behind Settings, while the separate AI window also tracks your system
  preference when Appearance is set to Auto.

- **Rapid break requests and invitation retries no longer race each other.** A
  second request cannot approve a duplicate break while the first is being
  recorded, and an invitation is only considered delivered after the intended
  friend has verified it. Ending a session now also cancels a retry already in
  progress.

- **Local AI lifecycle operations recover cleanly under quick changes.** A
  stale start or shutdown cannot take over a newer engine, interrupted engine
  replacement preserves the working install, and shutdown leaves no inherited
  engine process behind after reopening the app.

- **The floating AI window and model downloads have tighter safety boundaries.**
  The dialog can call only the native commands it needs, model downloads stay
  on approved Hugging Face endpoints, and friends-backup imports reject
  oversized input before it can consume excessive memory.

## 1.11.0 — 2026-08-09 — Stay connected and look back honestly

### Added

- **Past sessions can be reviewed from Settings.** Historical reports keep the
  topic timeline, focus summary, breaks, and local audit evidence available on
  this device, with text export when you want to keep or share a copy.

- **Invites survive restarts and temporary connection failures.** The invite
  inbox is scoped to the active identity and retains a session credential until
  an admitted peer has actually authenticated in the room; a delayed join
  cannot consume a newer replacement invite.

- **Sessions now carry images, direct messages, and an integrated AI chat.**
  Image notes are signed and session-scoped, private peer messages remain
  end-to-end within the room, and the local model can answer bounded questions
  about the current study context.

- **Session alerts can appear in a small desktop overlay.** The overlay uses a
  restricted native window and only surfaces short-lived notifications while a
  session is active.

### Fixed

- **Rejoining a session no longer combines whole-session minutes with one
  stint's focus result.** A same-process rejoin continues the score and sample
  state. If that state is unavailable after a restart, StudyVis combines the
  raw sample counts it can prove and leaves the stateful score unknown rather
  than presenting mismatched figures.

- **Historical reports keep the identity that participated in the session.**
  Restoring another identity no longer changes which signed events are treated
  as local or who is labelled “You”; older rows whose owner cannot be proven
  say so instead of guessing.

- **Oversized peer actions are stopped during receive reassembly.** StudyVis's
  pinned peer transport now bounds action payloads, metadata, and queued bytes
  before a complete image can be handed to the app, disconnecting a peer that
  exceeds the limit.

- **Concurrent AI startup callers now share one native start.** Overlapping
  requests resolve to the same engine port instead of one caller receiving a
  false failure while startup is still in progress.

- **Post-inference network work can no longer freeze future focus checks.** A
  stalled audit or alert callback is bounded and recorded without leaving the
  sampling loop permanently busy.

- **Fullscreen, screen sharing, and brief disconnects recover more reliably.**
  Native fullscreen transitions are serialized, Windows sharing requires the
  entire display, and an accidental leave offers a short same-session re-entry
  path without counting the gap as study time.

## 1.10.1 — 2026-08-04 — Accurate AI timing on slower PCs

### Fixed

- **The AI benchmark now measures the same cache-cold vision work as a live
  session.** Repeated benchmark requests no longer reuse llama-server's prompt
  cache and report an unrealistically fast result, especially on Windows PCs
  running inference on the CPU. Results from the old benchmark protocol are
  marked stale and no longer shorten the sampling cadence or request timeout;
  re-run the benchmark to calibrate them again.

## 1.10.0 — 2026-08-03 — More reliable study sessions

### Added

- **AI can be set up without waiting for a benchmark.** Download and choose a
  model whenever you are ready; benchmarking is now an optional calibration
  step rather than a prerequisite. If you turn AI on before benchmarking,
  StudyVis explains the trade-off and keeps its conservative defaults.

- **Download diagnostics saves a shareable local report.** From the just-ended
  session report or Settings → Advanced, you can now export a ZIP containing a
  manifest and bounded tails of the app and AI-engine logs. It stays on your
  device until you choose to share it, and the export keeps prompts, session
  topics, notes, captures, AI reasoning, credentials, and HTTP response bodies
  out of the report.

### Fixed

- **Screen sharing stays attached to the right tile after reconnects and
  stops.** A friend's camera can no longer be mistaken for their screen when
  peer-to-peer media renegotiates, and late metadata from a stopped share is
  discarded instead of bringing an old screen tile back.

- **The Cmd+] AI dialog can talk to the running engine.** The separate dialog
  now asks the Rust side of the app for the current sidecar endpoint, so it no
  longer falsely says that AI is off after startup or an engine restart.

- **Push-to-talk has an immediate escape hatch if its release event is lost.**
  Pressing the shortcut again now mutes a latched microphone rather than
  extending the failsafe window.

### Changed

- **Linux development builds can retain their identity and friends data.**
  StudyVis now uses the desktop Secret Service for its keychain on Linux.
  Linux is still not an installer release target, so this does not add a Linux
  download to this release.

All notable changes to StudyVis, grouped by version era. The product
was built in roughly three phases — V1 (study with friends, no AI),
V2 (on-device AI focus detection), V3 (polish + breadth) — described
in `PLAN.md`. Each build prompt landed as a single squash-merged PR;
the history below collapses to the user-facing story rather than the
per-PR ledger.

v1.0.0 through v1.0.3 shipped during V1 + V2 + the audit pass. The V3
polish phase landed in **v1.0.5** — the polished 1.0 `PLAN.md` set out
to build: feature-complete (V1's study-with-friends loop, V2's
on-device AI focus detection, V3's breadth + polish) and gated by the
success-criteria walkthrough in PR #40 (every V1 + V2 criterion
explicitly met-with-evidence or deferred-with-reason). **v1.1.0** and
**v1.2.0** followed with a feature pass and post-1.0 maintenance. (The
V3 work was drafted as v1.0.4 but shipped under the **v1.0.5** tag —
there is no v1.0.4 tag; the section below is labelled by the tag that
shipped it.)

## 1.9.0 — 2026-07-29 — Show each other what you're working on

A session gets a screen to look at, your history gets a year of squares to
look back on, and when something breaks there is finally a record of what
happened. This release also carries the fixes drafted as **1.8.2**, which was
never tagged — there is no v1.8.2, and everything below ships together here.
Two of those matter before you next sit down with someone: **you and your
friends all need to be on this build** for the camera of whoever starts a
session to reach the people who join, and macOS could not run on-device AI at
all until now.

### Added

- **When something goes wrong, there's now a record of it.** StudyVis
  keeps a diagnostic log on your own disk — what the app was doing, which
  relay refused a publish, why focus detection stopped scoring, what the
  updater choked on — instead of writing it to a developer console nobody
  has open. Settings → Advanced → **Copy diagnostics** now puts your
  version, machine and the last eighty records on the clipboard, ready to
  paste into an issue, and **Open log** reveals the log folder.

  It is written for someone reading it cold: one record per line, each
  naming the event and its details rather than a sentence someone has to
  grep. Usernames are cut out of file paths, keys and session topics are
  shortened to a prefix, and anything shaped like a recovery phrase is
  removed — as are your session notes, your study topic, and anything the
  AI said about your screen. Nothing is uploaded, ever; the log is a file
  on your machine that you choose whether to share. It stays under 2 MB
  and keeps one previous copy, so it can't grow without bound.

  **Debug log** in Settings → Advanced now does something: it adds
  verbose per-sample detail on top of what is always recorded.

- **Screen sharing, for everyone in the session at once.** A Share button in
  the session footer hands your screen to your friends the same way your
  camera already is — peer-to-peer, never through a server, never recorded.
  Everyone can share at the same time: each shared screen appears as its own
  tile beside the face it belongs to, so a two-person session where you are
  both sharing is four tiles rather than a fight over one slot. Screens are
  letterboxed instead of cropped (cropping loses whatever you were pointing
  at), and every screen tile has an expand control that opens it at full size
  — a 4K display at quarter-tile is unreadable, so that view is where the
  screen is actually read. Stopping is a button, or your operating system's
  own "Stop sharing" control; either way your friends' tiles clear
  immediately instead of freezing on a last frame. Nothing is shared until
  you press the button, and your own screen is shown back to you the whole
  time so what your friends can see is never a guess.

  Sharing sends video only — no system audio, which would echo against the
  live mic — and caps the frame rate rather than the resolution, because a
  screen is read rather than watched and the pixels are what make text
  legible. A friend still on 1.8.x can keep studying with you normally: they
  simply never receive a screen, deliberately, since an older build would
  bind it to your face tile with no way to clear it.

  On macOS this rides on the screen-recording permission fix tracked in #94 /
  I79 — without it, macOS builds cannot capture a screen at all.

- **A year of your studying, one square per day.** Settings → Stats opens on a
  calendar of the last year: every day is a square, darker the longer you
  studied, so a month of steady evenings and a fortnight you lost are both
  visible at a glance. Hovering a square names the day and its minutes. Under
  it sit the three numbers the grid can't say precisely — how many of the last
  365 days you studied, how many hours those came to, and the longest run of
  days in a row you've ever put together. (#99)

- **Every friend now has a page of their own.** Settings → Friends listed a
  name and a shortened key and nothing else. Each row now opens into the four
  things StudyVis already knew about that person but never showed you: the
  safety number — the same digits the import sheet shows once and then throws
  away, so there is at last a way to re-verify a friend long after adding
  them — their full public key, whether they are reachable right now, and how
  many sessions and minutes the two of you have actually studied together,
  and when you last did. Nothing new is stored and nothing is fetched: every
  line is worked out on your own device from what is already on it. (#101)

### Changed

- **The people in your session are now as big as the window allows.** Tiles
  used to stop growing at 360 px tall and to sit side by side whatever the
  shape of the window, so you and one friend were a pair of small strips with
  most of the screen empty underneath. The session now measures the room it has
  and arranges the tiles the way that makes them largest — for two people that
  is usually one above the other, each about a third wider and a third taller
  than before. A third friend, or a shared screen, rearranges everyone again to
  suit; no one's tile is ever bigger than anyone else's, and faces stay 16:9
  and uncropped at every size. Sitting alone also stops laying two tiles out in
  three columns' worth of space. (#95)

- **The settings nav rail sits evenly again.** The search box added in 1.6.0
  left the first group heading closer to it than every later heading is to
  what precedes it, so the top group read as glued to the box, and the text
  you typed sat a few pixels left of the labels it was filtering. Both line up
  now. (#100)

### Fixed

- **You could never see the camera or hear the mic of the friend who
  started the session.** If they hosted and you joined, their tile stayed
  dark and silent for the whole session while they saw and heard you
  normally — a day-one bug, present in every build StudyVis has ever
  shipped. The app handed your camera to the peer-to-peer layer exactly
  once, and that layer only delivers a stream to the friends who are
  already connected at that moment — it never passes it on to someone who
  joins afterwards. The host opens their camera before the invite has even
  been sent, so there was nobody there to hand it to, and nothing ever
  re-sent it. Your camera reached them only because you join a session
  that is already running. StudyVis now also re-sends your camera and mic
  to each friend as they arrive. **You and your friends all need to
  update:** an updated host reaches a friend on an older build, but if the
  host is on an older build you still won't see them. (I77)

- **On macOS, on-device AI never worked at all: the model appeared to load
  and then vanish.** Every attempt spawned the engine, loaded a multi-GB
  model and killed it milliseconds later, leaving nothing in the diagnostic
  log but a bare "terminated" line — which made it look like the engine was
  at fault when the real failure was one step earlier, in screen capture.
  macOS stopped letting apps like StudyVis ask for a screen at all unless
  they answer a specific system question the app was never answering, so
  every request was refused before the user could even see a picker — no
  gesture, and no amount of granting Screen Recording in System Settings,
  could change that. StudyVis now answers it, and the OS shows its normal
  screen picker. The engine is also no longer started until the screen has
  actually been handed over, so a cancelled or refused picker costs nothing
  instead of loading a model only to throw it away. Windows was never
  affected. (I79)

- **Your session history and stats could error out on every single session,
  with nothing ever recorded.** On some machines Settings → Sessions and
  Settings → Stats both failed to load, no session was ever written down, and
  no post-session report appeared — while friends, pairing and AI carried on
  normally. The cause was old: the very first database layout was edited in
  place three days after it shipped to add two columns, and a database created
  in those three days records itself as already up to date, so it never picked
  them up. Every read and write of your session table named a column that
  wasn't there. StudyVis now checks the shape of your database at every launch
  and adds anything missing, leaving all existing data untouched.

  Your past sessions are not lost with it. The session log — who joined, when
  everyone left, every focus alert — was written to a different table that was
  never affected, and StudyVis already knows how to rebuild a session from that
  log when a crash stopped it being saved. The first launch after this fix does
  exactly that, so sessions you have already studied reappear in your history
  with their real dates, lengths and study partners. They carry no focus score,
  because none was ever recorded for them. (#99)

- **On-device AI never started unless you had opened Settings → AI at least
  once since launching.** The app remembered which model you had chosen, but
  only read that memory when the AI settings pane was on screen, so a normal
  launch began every session believing no model was picked — and the whole
  focus pipeline is gated on that. Sessions ran to completion with AI switched
  on and nothing watching: no score, no focused-time, and a report that could
  not tell a deliberate choice from a malfunction. The saved model is now read
  at startup, the report distinguishes "AI was off" from "AI was on and got
  nothing" from an older session that predates the distinction, and a session
  that starts with AI on but no usable model says so instead of running
  silently. (#92, #94, I83)

- **When on-device AI couldn't take a single reading, nothing said so — the
  session simply ended with an empty focus score.** A Windows friend studied
  for ten minutes with AI switched on and got a report with no score, no
  focused-time, no distractions and no explanation, indistinguishable from a
  report for a session where AI had never been turned on. The AI loop has
  several ways to come up empty — the engine still loading, a check timing
  out because the model is heavier than the machine (Windows and Linux run the
  model on the CPU, where macOS uses the GPU, so the same model can be much
  slower there), the engine answering with an error, the camera frame or
  screen snapshot failing, or screen sharing having stopped — and every one of
  them used to pass in silence. The in-session indicator kept reading "AI
  watching" the whole time.

  StudyVis now notices when AI has gone a couple of minutes without managing a
  single check. The indicator stops claiming to watch — it reads "AI error"
  when the engine itself is the problem and "AI paused" when there is simply
  nothing to look at — a message names what is actually in the way, with a
  shortcut to Settings → AI when that is where the fix lives, and a line goes
  into the session log, so the report afterwards says why the AI section is
  empty rather than leaving you to guess whether AI was even on. If AI
  recovers, it says that too, and it will speak up again if it stalls a second
  time. Deliberate pauses are not treated as a stall: taking a break, turning
  your camera off, a Pomodoro rest, and a battery pause all stay quiet as
  before. Nothing about this crosses to your friends — the log line is local to
  your device. (#92, I82)

- **Starting a session with AI already enabled could throw a raw
  "getDisplayMedia must be called from a user gesture handler" error and
  silently kill the just-started on-device engine.** WebView2 (Windows) and
  WKWebView (macOS) require every `getDisplayMedia()` call — not only the
  first — to run inside an active user gesture, but the AI sample loop
  acquired its long-lived screen stream from a React effect with no click in
  its call stack, so the acquisition was rejected outright and the engine
  that had just started was torn down as a result. A friend hitting this
  would then separately see a misleading "AI isn't running yet, turn it on
  in Settings → AI" from the AI chat dialog, even though AI genuinely was
  on. Starting a session via the AI topic gate, flipping the Settings → AI
  toggle mid-session, and retrying from the capture-permission overlay now
  all acquire that stream at the moment of the actual click and hand it off
  to the sample loop, instead of the loop acquiring it itself later with no
  gesture to satisfy. The in-session AI status indicator also now correctly
  flips to "error" when this happens, instead of continuing to read
  "active" after AI had already died. (I76)

- **On macOS the floating Ask AI panel was ringed by a phantom outline.**
  Ctrl+] opened the panel inside a rounded rectangle that hung off its left,
  right and bottom edges instead of hugging it. macOS shapes a see-through
  window from whatever its contents leave visible, and what it had found was
  the panel's drop shadow rather than the panel — so it drew a rim around the
  shadow. The panel keeps its shadow and is unchanged on Windows, which never
  showed the artifact. (#97, I81)

- **Text written by a signalling relay could forge lines in your own
  diagnostic log.** StudyVis records a relay's complaints word for word, so a
  relay that quietly starts refusing our messages cannot go unnoticed — but
  nothing stopped that text from containing line breaks, which let a relay
  write what looked like StudyVis's own records, or invisible characters that
  reorder what a human reads without changing the bytes underneath. Relay text
  is now stripped of control characters and clamped to 200 characters before
  it is written down. (I80)

- **A security advisory in the application framework is closed.** Tauri 2.11.0
  and earlier carried an origin-confusion flaw (GHSA-7gmj-67g7-phm9, CVSS 8.8)
  by which a remote page could invoke commands meant only for the app itself.
  StudyVis now builds on 2.11.5. (I78)

## 1.8.1 — 2026-07-26 — The AI engine now actually loads a model

A same-day follow-up to 1.8.0: that release fixed the engine failing to
_start_ (I73); this fixes the very next link in the same chain — the engine
starting, then refusing to load a model.

### Fixed

- **On-device AI still couldn't run, even on 1.8.0.** The bundled llama.cpp
  engine spawned, printed its startup banner, and then exited every time
  with "no backends are loaded" / "failed to load model" — on every Windows
  and macOS install, not an edge case. The prebuilt engine loads its CPU
  (and, on Apple Silicon, Metal) backend as a separate library it opens at
  startup rather than links directly into itself, and that lookup only
  checks the executable's own folder and the app's current working
  directory — neither of which was where StudyVis kept that library. The
  engine now launches with its companion-library folder set as its working
  directory, so the backend is found and a model actually loads. (I75)

## 1.8.0 — 2026-07-26 — AI starts, and friends stop showing a false "Offline"

The second half of the "AI never actually ran" story: 1.7.1 fixed model
downloads, and this fixes the engine those models were supposed to run on.
It starts now, and installs itself if it's missing. Separately, friends
stop showing a false "Offline" when only the direct connection between you
is blocked.

### Added

- **The AI engine installs itself.** If the engine binary is ever missing
  or unusable when AI starts, StudyVis downloads the exact pinned
  llama.cpp build (about 8–16 MB from GitHub depending on your platform,
  verified against a pinned checksum) and installs it under the app's data
  folder — no manual step, as long as the new **Install engine
  automatically** toggle stays on. It's on by default; turn it off if
  you'd rather AI never touch the network, and use **Install now**
  instead. If the download itself fails — you're offline, GitHub is down —
  the Settings row says why and the next AI start tries again. A new
  **Settings → AI → AI engine** row shows what's installed, with live
  download progress, and offers Install / Reinstall. On Windows, a failed
  engine start now names the missing Microsoft VC++ runtime — with the
  link — instead of a bare error code. (I73)

### Fixed

- **AI could never start: the app looked for its inference engine in the
  wrong place.** The bundled llama-server binary sits next to the app
  executable, but the spawn call looked for it under a `binaries/`
  subfolder that has never existed in a shipped build — so every "start
  AI" attempt failed on the spot ("AI failed to start" / "AI model
  crashed"). With 1.7.1's download fix, this was the last wall between
  installing a model and the first real focus check. The engine is now
  resolved to its real absolute path, verified against the actual
  installed-app layout. (I73)

- **Friends no longer show "Offline" to each other when only the direct
  connection between them is blocked.** Presence heartbeats used to ride
  WebRTC datachannels exclusively, so two friends whose networks a
  STUN-only connection can't cross (symmetric NAT, CGNAT, strict
  firewalls — no TURN ships) each saw the other permanently offline, with
  no error anywhere. Presence now also publishes small sealed heartbeats
  straight to the pinned Nostr relays — the same infrastructure that
  already proved reachable — so "their app is running" reads truthfully
  even when the peer-to-peer path can't form. Both of you need this
  version to see each other through the relay leg; either side on an
  older build behaves exactly as before. (I74)

- Dropped `wss://offchain.pub` from the pinned relay list. It now rejects
  anonymous publishes, which breaks the exact round-trip that rendezvous —
  and now relay presence — depends on.

### Changed

- **The friends list tells the truth in more detail.** Three states
  instead of two: _Available_ (green — a direct connection is working, or
  a friend who just arrived is still establishing one), _Available ·
  limited connection_ (amber — reachable through the relay, but a video
  session likely won't connect until a TURN relay is set up), and
  _Offline_ with recency ("seen 12 min ago") once someone drops. Amber
  only appears after a friend has been online a couple of minutes without
  a direct connection forming, so a normal arrival never flickers through
  it. While any friend is limited, a one-line hint above the list explains
  why sessions may fail and links straight to Settings → Network.

- **Presence costs a little more network while the app is idle.** The
  relay leg opens one more WebSocket to each pinned relay and sends one
  sealed ~300-byte beacon to each every 30 seconds, for as long as
  StudyVis is running. Idle traffic goes from a few KB/hour to a few
  hundred KB/hour. The beacon says nothing but "still here", sealed so
  only your friends can read it, and there's no switch for it — presence is
  how friends see you're around. Full accounting in `PLAN.md` §3.

- **The AI pane's privacy line is more precise.** It used to say flatly
  that nothing leaves your computer. Camera and screen captures still
  never do — but downloading a model or the engine plainly fetches files,
  so the text now says both. The promise it makes is one we keep.

### Known issue

- **Mid-session, the Invite list doesn't show the limited state yet.** The
  friends list on the home screen does; the in-session picker still shows a
  limited-connection friend as plain _Available_. Inviting them can sit for
  15 seconds and then report that they may be offline — they aren't, the
  direct connection just isn't forming. If it happens, check the home
  screen: a friend sitting at _Available · limited connection_ needs a TURN
  relay in Settings → Network before a session with them will connect.

### For developers

- A fresh checkout runs without `scripts/fetch-llama-server.sh` first:
  `build.rs` writes a debug-only placeholder sidecar, and the app installs
  the real engine on first AI use while the auto-install toggle is on. The
  script is still required before a release build — a release-profile
  build fails on the placeholder, by design.

## 1.7.1 — 2026-07-26 — Model downloads actually work

One fix, and it's the big one: installing an AI model from
Settings → AI works now.

### Fixed

- **Every model download was rejected before a single byte moved.**
  The pre-download safety check asks the server how big each file is
  and compares that against the built-in catalog — but it read the
  answer from a field that is always zero for that kind of request, so
  every model failed with "The model manifest may be stale." no matter
  which one you picked. The catalog was never stale; the check was
  reading the wrong number. It has been wrong since the model picker
  first shipped, which means this is the first release where the
  download path can actually run — the check now reads the size the
  server really advertises, and all ten files in the catalog were
  verified byte-for-byte against it. If a download misbehaves for you,
  cancel and press Download again: it resumes where it left off. (I72)

## 1.7.0 — 2026-07-25 — Gemma without a token, a fixed add-friend screen, and a broad correctness pass

A feature pass on the AI model picker and the add-a-friend screen, plus
a verified round of fixes across sessions, friend presence, the AI focus
loop, accessibility, settings, and the updater — the third improvement
wave. Nothing changes about your identity, friends, or history.

### Added

- **Gemma 3 4B no longer asks for a Hugging Face token — and now comes
  in three sizes.** The "Best" model was marked as gated, but the mirror
  StudyVis downloads from never required an account; the token-paste
  step is gone. The card also gained a quantization selector: the
  recommended Q4_K_M (~3.1 GB), a near-lossless Q8_0 (~4.6 GB), and
  full-precision f16 (~8.0 GB) for machines with RAM to spare. Each size
  installs and benchmarks independently, and anything you already
  installed stays installed.

- **The add-a-friend screen has a new cardstock backdrop** — a quiet
  graph-paper texture that follows both themes — in place of the flat
  panel.

- **A failed 24-word recovery names the words that aren't real.** Mistype one
  word restoring your identity and the error now tells you which word(s)
  aren't in the wordlist, instead of rejecting all 24 at once.

- **The stats CSV export leads with your headline numbers** — total
  sessions, streak, average score — which it previously omitted entirely.

- **The focus-over-time chart's tooltip shows the day** each point belongs
  to, so a dip is anchorable to a date.

- **The corrupt-data recovery dialog points at the friends backup.** If
  StudyVis ever has to reset unreadable local data, the dialog now tells you
  to restore from a friends backup if you made one, instead of only "pair
  again".

### Fixed

- **The add-a-friend screen fits the window.** The QR code used to sit
  above the paste box in one tall column that outgrew the default
  window — and because dialogs center themselves with nothing to scroll,
  the title, Cancel button, and close control were clipped off the top
  and bottom edges. The QR (slightly smaller, still comfortably
  scannable) now sits beside the paste box, the whole dialog scrolls in
  the rare case it needs to, and the camera-scan view no longer outgrows
  the window either.

- **Database problems now read like sentences.** In the rare cases
  StudyVis can't read its local data — the session-history list, the
  friends list, or the worst-case startup failure — you get one plain
  explanation instead of a wall of raw SQLite error text. The full
  technical detail still lands in the debug log for troubleshooting.

- **Settings panes share one spacing rhythm.** The AI pane had rows
  floating without the divider-and-padding treatment every other row
  gets, and the Stats pane drew each of its loading states at a
  different offset — so the pane visibly jumped when the charts arrived.
  Every pane now sits on the same grid.

- **Study time no longer counts the hours your laptop was asleep.** Ending
  a session by closing the lid used to persist the entire span until wake —
  a 45-minute session slept on could show up as a ~10-hour bar and a free
  streak day. Elapsed time is now measured on a clock that stops while the
  machine is suspended, so the recorded minutes match the minutes you were
  actually there. (Sessions already recorded stay as they were — the fix
  isn't retroactive.)

- **Opening Settings or starting a session no longer flickers you offline
  to your friends.** A view switch was tearing down and rebuilding the
  always-on presence connection, which broadcast a spurious "left" and
  blanked your friends list for up to 30 seconds — occasionally firing a
  phantom "came online" ping and dropping an invite that arrived in the gap.
  The connection now persists across every screen change.

- **When a friend clicks Leave, the session ends right away** instead of
  sitting on "Waiting for your friend to reconnect…" for 20 seconds and
  then offering to rejoin a room nobody is in. A genuine connection blip
  still gets the full grace window — including when another friend joins or
  leaves in the meantime.

- **A friend's first arrival of the day now notifies you.** The "friend
  came online" notification was suppressing every friend's first online
  moment after launch — the one event it exists for.

- **The pending-invite countdown is honest on the first glance.** A row that
  appeared after the app sat idle briefly showed a wildly wrong "expires in"
  time for its first ten seconds.

- **A dead webcam no longer floods the session with error toasts.** If a
  camera is unplugged or grabbed by another app mid-session, the AI focus
  loop reports it once and quietly skips checks until it's back, instead of
  a fresh toast every few seconds.

- **The keyboard focus ring is visible.** The ring that marks the focused
  control fell below the contrast floor in both themes — nearly invisible in
  light mode. It's now measured against the surfaces it's actually drawn on
  and clears the bar.

- **Dropdown and menu rows highlight the one you're on.** The highlight
  painted the same color as the menu, so keyboard and mouse users had no
  cue — most visible in the in-session microphone and speaker pickers.

- **The session log and notes are reachable by keyboard.** Both scrolling
  panels can now be focused and scrolled without a mouse.

- **Settings search finds what it promises.** Typing "tray", "minimize",
  "capture displays", or "auto-update" landed on a pane that doesn't hold
  those settings; "launch at login", "clear history", and "onboarding" found
  nothing. Each now opens the pane that owns it.

- **"Reset shortcuts to defaults" always works** — a shortcut collision used
  to make it silently do nothing, with no error.

- **Settings → About won't restart the app mid-session.** The Restart-now
  and Check-now buttons there now defer during a live session, matching the
  update banner, so a stray click can't drop you (and your friend) out of a
  session. About also stops claiming "you're on the latest" before any
  update check has actually run.

## 1.6.0 — 2026-07-21 — a searchable settings rail, lighter and faster

The first update that installs itself. Nothing changes about your
identity, friends, or history, and there's nothing to do after updating.

### Added

- **Search your settings.** The settings nav rail gains a search box:
  type "camera", "relay", "shortcut", or any category name and the rail
  filters to the matching panes as you go — no more remembering which of
  the eleven categories a control lives under. It matches pane names,
  group headings, and concept keywords, and it's keyboard-first: arrow
  down into the results, Enter opens the first match, Esc clears. The
  grouping, icons, and active-item accent are unchanged when the box is
  empty.

### Changed

- **Smoother sessions.** The session view no longer re-renders itself
  every second just to advance the elapsed-time clock; the video and
  status surfaces update without the extra churn.
- **Faster startup.** Split the startup bundle so roughly 500 KB of code
  (the stats charts and the pairing QR reader) is fetched only when you
  open those screens instead of up front, trimming what the app parses
  before the first screen appears. Nothing moved or changed — only when
  its code loads did.

## 1.5.0 — 2026-07-21 — auto-update + a window-size settings pass

> **This is the last version you install by hand.** From here on StudyVis
> updates itself. **Windows:** this release switched installer format —
> uninstall your existing StudyVis from Settings → Apps _before_ running the
> new `-setup.exe`, or Windows will list two copies. Your identity, friends,
> and history are untouched. **macOS:** after a self-update, macOS may ask
> for camera / microphone / screen-recording permission again (the app isn't
> notarized yet); granting it is safe.

### Added

- **StudyVis updates itself.** It checks for new releases in the
  background, downloads them, and shows a "StudyVis X.Y.Z is ready"
  banner with a Restart now button — the restart is a couple of seconds
  because the download already happened. Nothing checks, downloads, or
  interrupts during a session. Dismissing with "Later" leaves the update
  waiting in Settings → About.

  Each update is signature-verified before it is installed, so a tampered
  download is rejected. This does not require the code-signing
  certificates StudyVis still lacks — the updater carries its own key.

- **Remember window size and position** (Settings → Appearance → Window,
  on by default): the window reopens where you left it — size, position,
  and maximized state — restored by Rust before the window is shown, so
  there's no resize flash. Geometry saved on an unplugged monitor falls
  back to centering instead of opening off-screen. A **Reset** row returns
  the window to the default 1280 × 800, centered.

### Changed

- **Automatic updates are ON by default** (Settings → About). This widens
  the privacy stance: previously the only outbound request beyond P2P was
  an opt-in, OFF-by-default version check. The requests are still
  anonymous fetches of a public file with no identifiers and no payload,
  and turning the toggle off restores zero outbound. If you had
  deliberately turned the old version check off, that choice carries over
  and auto-update stays off.
- **The Windows installer is now `-setup.exe` (NSIS), not `.msi`.**
  Applying an MSI update needs an administrator prompt every single time,
  which defeats the point. **Upgrading from 1.4.0 or earlier: uninstall
  the old StudyVis from Settings → Apps first**, then run the new
  installer — otherwise Windows lists two copies. Your data is untouched.
- Settings nav rework: the eleven categories are grouped (You / Study /
  App / System) with lucide icons and an accent edge on the active item;
  the rail is now fluid (`clamp(224px, 22vw, 280px)`) so narrow windows
  give the freed width back to the content column.
- Settings over a live session no longer covers the custom title bar's
  window controls (custom window style only).
- Overflow hardening across every pane: raw backend errors (autostart,
  AI sidecar, session history, model downloads) and long URLs now wrap
  instead of forcing a horizontal scrollbar; relay URLs show the full
  value on hover, and your public key wraps in place — one click selects
  the whole thing to copy.
- Layout-shift fixes: notification-permission and sessions/stats loading
  skeletons now match their resolved shape; the window-style Relaunch
  button, TURN status line, and shortcut-rebind controls no longer move
  mid-interaction.
- Consistency: friend fingerprints render mono and use the same 8-char
  truncation as the friends list; remove buttons name the friend they
  remove; button sizing and icon placement unified across panes; the
  About pane's copyright line sits beside the version it belongs to; the
  two stats charts share one left plot edge.

### Known issue

- **macOS may re-ask for camera / microphone / screen-recording
  permission after an update.** macOS ties those grants to a signed app
  identity, and StudyVis is not yet notarized. Granting again is safe.
  A Developer ID certificate would remove this.

## 1.4.0 — 2026-07-19 — multi-friend sessions, faster AI, and the verified backlog

Everything merged since v1.3.1: a production-readiness audit, a settings
GUI pass, the 26-item verified improvement backlog (#47, PRs #49–#74), and
a follow-up wave of verified fixes.

> **After updating on Apple Silicon:** re-run the benchmark in
> Settings → AI. Inference now uses the GPU (Metal) and is typically
> 5–10× faster; the app flags the old measurement as stale, and
> re-benchmarking lets it check your focus more often.

### Added

- **Study together, 3–4 people.** An Invite button in the session footer
  opens an online-friends picker, so multi-friend sessions are reachable
  (inviting a second friend used to lock the host into a 1:1 session).
- **Quiet in-session notes.** A small text panel for "brb 5" or dropping a
  link without breaking the silence or switching to a messenger. Notes are
  signed, capped, and never saved; friends on older versions simply don't
  see them.
- **Settings during a session.** The gear button (and error messages that
  point at Settings) now open Settings over the live session — video,
  friends, and AI keep running underneath.
- **Rejoin after a drop.** If a network blip ends a session for you, the
  report offers Rejoin while the room is still live — and rejoining now
  adds to the same session's history instead of overwriting the minutes
  you'd already studied.
- **Invites you can actually catch.** Incoming invites persist as an
  accept row for their full validity (previously a ~4-second toast), and
  they now show on the report and Settings views too. "Invite sent" is
  honest: delivery is confirmed by the friend's app, and unconfirmed sends
  say so with a nudge to check they've added you back.
- **Connectivity that survives blocked networks.** Presence, invites, and
  the invite inbox race Nostr + MQTT (previously pairing only), so a friend
  behind a Nostr-blocking firewall no longer shows permanently offline with
  undeliverable invites. Your own TURN server (Settings → Network) now
  applies to presence and invite delivery too, with a Test-connection
  button to verify it before a session depends on it.
- **Faster AI on Apple Silicon.** Inference runs on the GPU via Metal
  (it was CPU-only). Re-run the benchmark after updating — see above.
- **AI honesty in the report.** Sessions where many AI checks were skipped
  now say so instead of presenting a confident focused-time percentage.
- **Audio that remembers.** Your microphone/speaker picks and per-friend
  volumes persist across sessions, and the device menus mark which device
  is actually selected.
- **Notification health.** Settings → Notifications shows the OS-level
  permission state with a fix path, so toggles can't look on while the OS
  silently drops every notification.
- **Study time survives crashes.** If StudyVis (or your machine) dies
  mid-session, the next launch reconstructs the session's study time from
  its activity log — previously the whole session vanished from history.

### Fixed

- **Study history integrity.** Quitting mid-session via the confirm dialog
  persists the session; re-entering a room merges rather than rewinds the
  record; stats and streaks stop under-counting after rejoins.
- **Pomodoro rest is actually a break.** Focus detection pauses during
  synced rest phases — the app no longer tells you to rest and then flags
  you for resting.
- **Push-to-talk correctness.** Swapping microphones mid-session keeps
  device-loss recovery armed and applies your current talk/mute state to
  the new mic (no more silently hot mic); the PTT hint shows your actual
  binding after a rebind; the global shortcut is only registered while a
  session is live, so an idle StudyVis no longer swallows Cmd+[ system-wide.
- **Identity recovery.** A restored machine whose keychain lost its keys is
  detected at boot and steered to the 24-word restore — which now
  recognizes your own words (no scary "replace identity?" warning), keeps
  your display name, and no longer silently breaks invite sending.
- **AI model management.** Download/Re-benchmark/Remove are locked during a
  live session (a mid-session re-benchmark silently killed focus detection
  and corrupted the measurement); removing a model stops the AI process
  serving it first (no more failed deletes on Windows or gigabytes of
  invisible disk on macOS); model downloads are pinned to verified
  revisions so an upstream re-upload can't break new installs.
- **Friend pairing and presence.** Starting a second pairing cancels the
  first instead of leaving it invisibly live; editing your friends list no
  longer flickers your online dot on friends' screens; importing a friends
  backup merges instead of rewinding fresher local data.
- Assorted accessibility fixes: the camera toggle no longer announces the
  inverted state to screen readers, the in-session Settings overlay manages
  keyboard focus properly, and device menus expose selection to assistive
  tech.

### Release & data safety (mostly invisible)

- Database corruption from a power loss no longer bricks the app; recovery
  sets the damaged file aside and starts clean.
- Release pipeline hardening: version/tag lockstep is enforced before
  anything irreversible, release notes are required and become the GitHub
  Release body, third-party CI actions are pinned to exact commits, shipped
  database migrations are checksummed against silent edits, and the pinned
  signaling relays _and_ MQTT brokers get a health check at release time.

## 1.3.1 — 2026-07-01 — offline friend codes

Adding a friend no longer depends on a live connection at all. The v1.2.2
Nostr+MQTT race made the rendezvous more reliable, but pairing still needed
both friends online at once on a working discovery relay _and_ a WebRTC
datachannel — either failing left you stuck. The information that actually
needs to cross is tiny and static (two public keys + a name), so it no
longer travels over a live channel.

### Added

- **Offline friend codes (ContactCard).** Your friend code is now a
  self-contained, self-signed card carrying your public keys and name. Swap
  codes with a friend — scan each other's QR in person, or paste a
  `studyvis://add#…` code into any chat — and each side imports the other.
  Importing is a pure local step: **no relays, no WebRTC, no waiting**, so it
  works even when one of you is offline or behind a strict firewall. Before a
  friend is added over a pasted/linked code, a **safety number** is shown to
  compare out-of-band (on a call or in person), which catches a tampered or
  impersonated code. Sharing a code is safe — it holds only public keys.
- **Legacy 12-word pairing is retained** behind a "friend on an older
  StudyVis?" link, so you can still pair with anyone on v1.2.x. Old builds
  ignore the new code format cleanly, and no stored friend data changes.

## 1.2.2 — 2026-06-14 — pairing discovery reliability

Adding a friend could hang forever on "waiting for friend" — the two
sides never found each other on the signaling relays, sometimes even on
the same network. Pairing now races a second, independent discovery
transport, so a friend is reachable if either path works.

### Fixed

- **Friend pairing races Nostr + MQTT for discovery.** The pairing
  handshake previously rendezvoused only over Nostr relays, so a dark or
  network-blocked relay set — or a peer whose system clock was skewed,
  which silently drops Nostr's time-stamped rendezvous events — left both
  sides stuck on "waiting for friend" with no recovery. Pairing now opens
  the room over Nostr **and** MQTT at once and proceeds on whichever
  connects first. The two transports share no infrastructure and no
  clock-sensitivity, so one failing no longer strands the pair. The
  pairing flow is unchanged (same code entry, same UX); both friends must
  be on v1.2.2+ for the MQTT path to engage. Sessions, inbox, and presence
  are unchanged.

## 1.2.1 — 2026-06-13 — reliability, honesty, and quality-of-life pass

A broad maintenance + feature wave across eight clusters, drawn from the
`IMPROVEMENTS.md` backlog. Reliability of friend-finding and live
sessions, more honest AI and stats, safer identity error paths, new
notifications and custom pomodoro durations, a stricter accessibility
gate, and release/CI hardening. New outbound behaviour stays opt-in and
OFF by default; the one sanctioned outbound request is carved out in
PLAN §3.

### Added

- **Connection diagnostics + your own relays/TURN (Settings → Network).**
  A live per-relay status panel (state by glyph + text, never color
  alone) and fields to add your own signaling relay URLs and a TURN
  server without a new build — the one path through strict/CGNAT
  networks now that no public TURN ships.
- **Friends-list backup.** Export / Import friends to a sealed
  `.svfriends` file encrypted to your own key; import upserts. The
  recovery gap (24 words restore only the keypair) is now self-serve.
- **Focus insights (Stats).** A local, cross-session view of when
  distractions cluster, recurring reasons, and a focused-time trend —
  read from `audit_events` on-device, nothing transmitted.
- **File exports.** Save the post-session report (markdown), a raw
  per-session audit JSON, and a stats CSV of daily study minutes +
  partner counts.
- **Session history management.** Delete a single session
  (Settings → Sessions) or clear all history (Advanced), behind confirm
  dialogs; stats and the report follow.
- **Pomodoro break/work OS notifications** (opt-out, ON by default) and a
  gentle phase-transition chime (opt-in, OFF by default) — so a break
  boundary is visible while the window is in the tray.
- **"Friend came online" notification** (opt-in, OFF by default), honest
  about the ~60 s presence latency.
- **Custom pomodoro durations** (5–120 work / 1–60 rest) with a
  backward-compatible wire: explicit durations ride alongside a
  legacy-preset fallback, so a custom-split host never strands a friend
  on an older build.
- **Camera on/off toggle, audio-output picker, and a per-peer volume
  slider** in the session footer.
- **"Waiting for your friend" tile** when you're alone in a session, and
  per-peer connection states (connecting / failed) instead of a frozen
  offline tile.
- **Opt-in new-version check (Settings → About), OFF by default.** When
  on, a single unauthenticated GET to the public GitHub Releases API
  compares tags and shows a quiet update row; zero outbound while off,
  silent on failure. This is the one sanctioned outbound request beyond
  P2P + Nostr signaling — carved out in PLAN §3.
- **`studyvis://` deep link.** A pairing link now prefills (never
  auto-connects) the add-a-friend form; relaunching a tray-hidden app
  focuses the existing window (single-instance guard).
- **Quit confirmation during an active session.**

### Changed

- **Honest AI focus pipeline.** Malformed/empty model responses, and
  low-confidence off-task calls below the `off_task_confidence_floor`
  (default 0.6, with a Settings → AI slider), are now treated as
  _uncertain_ skips — they neither reset an off-task streak nor count
  toward focused-time %, instead of being fabricated as `on_task`. The
  benchmark and live request are built from one shared builder so the
  predicted cadence is achievable. A duration-based cadence backoff
  replaces the dangling "thermal-aware notice" (engages after 2 slow
  ticks vs the benchmark p95, recovers after 3 normal ticks). Model
  downloads resume from a surviving `.tmp` via HTTP Range.
- **Honest scores and labels.** AI-off sessions no longer persist a
  fabricated `score=100` — the report shows a calm no-score state and
  averages skip nulls. Stats' "Focused minutes" is renamed "Study
  minutes" so "Focused" stays the AI concept; the average-score tile
  says how many sessions it covers.
- **Legible connection failures.** The pairing dialog distinguishes
  "can't reach the network" (your side) from "your friend hasn't
  arrived"; an invite to an offline friend retries when they flip online
  (deduped) and reads differently from a relay-down failure; a
  best-effort goodbye flips presence offline near-instantly on quit.
- **Accessibility gate proves coverage.** `check-contrast` now scans
  `src/` for every text/bg/border token co-occurrence and fails on any
  pairing missing from the allowlist — not just that the listed pairs
  pass. Surfaced previously-unlisted real pairings, all AA-verified.
- **Always-visible invite button**, onboarding **Back** navigation, one
  CTA on the zero-friends empty state, and the SessionTimer presets now
  use the themed `RadioGroup` primitive.

### Fixed

- **Push-to-talk can no longer latch the mic open** — a dropped release
  event or a stale latch can never bring a fresh session's first audio
  track up live (a privacy defect); a stuck-key guard and per-session
  reset back it up.
- **Grace window before auto-ending.** A transient transport drop no
  longer ends a long session instantly — a 20 s grace window cancels on
  any rejoin.
- **Corrupt-identity and corrupt-DB safety.** An unreadable
  `identity.json` routes to a calm Retry/Restore screen and can never be
  steered into new-identity onboarding that clobbers keychain keys; a
  corrupt `app.db` is set aside and recreated with an explanatory dialog
  instead of a startup panic; a DB written by a newer build is refused
  distinctly. Recovery now skips the overwrite warning when you re-type
  the same 24 words and preserves your display name.

### Release / CI

- **CI-green gate before release.** `release-prep` runs lint, test,
  build, check-tokens, check-strings, and `cargo fmt --check` before any
  version bump, tag, or push lands on `main`; `check-strings` also runs
  in `ci.yml`.
- **macOS ad-hoc signing** (signing identity `-`, hardened runtime off)
  softens first-run Gatekeeper friction to the milder "unverified
  developer" prompt. The dormant `tauri-plugin-updater` dependency was
  removed (re-add checklist in PLAN §8).

## 1.2.0 — 2026-06-07 — post-1.0 fixes and feature improvements

A maintenance and feature pass on top of the 1.0 line: audit-verified
bug fixes across the session, AI, and Rust layers, plus four feature
improvements.

### Added

- **Share log (Settings → Advanced).** The manual share `PLAN.md` §3
  promised, previously only a folder opener. "Open log" reveals
  `llama-server.log` in your file manager; "Copy diagnostics" copies
  your version, OS, and log path. Local-only — nothing is uploaded.
- **Bounded diagnostic log.** `llama-server.log` now rolls to
  `llama-server.log.1` at ~5 MB at the start of an AI session, so it
  stays small and shareable. Resolves the deferred D7 rotation.
- **Copy session report.** The post-session report has a "Copy report"
  button that puts a plain-text summary on the clipboard to paste to
  the friends you studied with. Local-only, no peer broadcast.
- **Breaks in the report.** The report now summarises approved breaks
  per person — count and total time.

### Fixed

- **TURN preference applies to sessions.** Settings → Network's relay
  setting now affects study sessions, not just friend pairing.
- **Audit log keeps departed friends' names.** In 3+ person sessions a
  friend who leaves no longer has their earlier rows relabelled to a
  key fragment.
- **Push-to-talk reliability.** PTT no longer goes silently dead after
  a mid-hold camera/mic reacquire, and a friend who joins while you're
  talking now sees your talk indicator.
- **Pomodoro Stop is broadcaster-only.** Receivers no longer see a
  no-op Stop button the next broadcast tick would undo.
- **AI cadence respects slow models.** The sample interval can no
  longer be capped below a model's measured floor.
- **Backend hardening.** SQLite busy-timeout so a concurrent
  first-launch serialises instead of failing; duplicate push-to-talk
  accelerators no longer abort boot; the llama-server sidecar is
  reliably killed on quit instead of orphaned; failed model downloads
  clean up their partial temp file; disabling AI closes an open
  Ctrl/Cmd+] dialog.
- **UI and accessibility.** A re-opened session report no longer nests
  a second `main` landmark; the titlebar resize listener no longer
  leaks; the audit log pins to the newest row without a one-frame jump.

## 1.1.0 — 2026-06-06 — Pairing QR redesign

### Changed

- **Pairing QR redesign (#42).** Reworked the add-a-friend pairing
  surface and its QR-code presentation for a calmer, clearer exchange
  of the one-time 12-word code.

## 1.0.5 — 2026-05-31 — V3 polish, the polished 1.0

The release that lands the V3 phase (shipped under the v1.0.5 tag;
v1.0.4 was drafted but never tagged). Carries V1 + V2 + V3 in one
installer. See
"Friends-only unsigned" install notes in `INSTALL.md` and the
user-facing tour in `README.md`.

### Release hardening (cut into v1.0.5)

- **Session UX recovery.** Camera/mic errors recover with clear copy
  and a retry; a persistent AI status indicator and labelled footer
  timers; leaving a session now requires confirmation on Esc; the
  self-warning and break badges no longer fight for one slot.
- **Onboarding critique resolved** — control, privacy, a11y, layout,
  and polish fixes across the onboarding flow.
- **Accessibility.** Focus states differentiated beyond color;
  `PttIndicator` note corrected; `aria-describedby` on audit rows.
- **Release pipeline.** Dropped the macOS Intel build target; releases
  are marked prerelease until reviewed.

### V3 — polish and breadth

- **V3-P1 — Stats dashboard.** Settings → Stats. Daily focused
  minutes (last 30 days), current streak, average AI score across
  scored sessions, top study partners. Computed on-device from the
  local sessions + friends tables; nothing transmitted. Empty / no
  scored sessions / no partners states all read in voice.
- **V3-P2 — Identity recovery from a 24-word backup.** Onboarding's
  Identity step forks into "Create a new identity" or "I have a
  24-word backup". Type the words; the same Ed25519 + X25519 keypairs
  derive deterministically on the new machine. Your friends list does
  not come with the identity — you re-pair, by design (the friends
  list lives in the lost device's SQLite).
- **V3-P3 — Custom keybindings UI.** Settings → Shortcuts lets you
  rebind both global shortcuts (push-to-talk for friends; Talk to
  AI). The capture surface validates against reserved combos per
  platform, refuses bare keys, and emits a calm conflict line if you
  try to bind the same combo to both actions. Defaults match
  `DESIGN-SYSTEM` §17 (Cmd+[ / Ctrl+[ and Cmd+] / Ctrl+]).
- **V3-P4 — Multi-monitor capture toggle.** Settings → AI → Capture
  displays. "Primary only" (V2 default) or "All displays" — the
  latter composites every monitor into one image at session start.
  The OS share picker runs once per monitor at session start;
  changes between primary and all apply on the next session (no
  mid-session prompt regression).
- **V3-P5 — Light + auto theme polish.** Three modes: Dark, Light,
  Auto (follow system). Same hues, every text/background pairing
  re-tuned until it clears WCAG AA on both canvases. Verified by
  `scripts/check-contrast.ts` over 42 pairings × 2 themes.
- **V3-P6 — Custom frameless window chrome (opt-in).** Settings →
  Appearance → Window style → Custom. Adds a 38-px chrome band with
  the studyvis wordmark and platform-correct controls (macOS reserves
  the left inset for the system traffic lights; Windows paints its
  own min/restore/close cluster). Native chrome is the default; the
  toggle is honest about needing a relaunch.
- **V3-P7 — Accessibility pass + app-wide reduced motion.** Full
  keyboard navigation walk, screen-reader labels on every interactive
  surface, axe-core a11y gate over every Storybook story
  (`npm run check-a11y`). Reduce motion (Settings → Appearance) is a CSS
  `[data-reduce-motion='true']` kill switch in `@layer base` — every
  transition and animation collapses to ~1ms automatically, so new
  motion sites are gated by default. Pre-paint via inline script in
  `index.html` + `ai-dialog.html` so the first paint has no flash.
- **V3-P8 — Design cohesion & copy pass.** Every user-facing string
  centralised into `src/strings.ts` (single locale; not i18n);
  `scripts/check-strings.ts` guards toast + notification surfaces
  against drift. Voice rewritten to `DESIGN-SYSTEM` §14 throughout —
  contractions ("Couldn't" not "Could not"), periods on full
  sentences, none on labels. shadcn Dialog / Sheet / Popover /
  Tooltip / DropdownMenu motion finally real (installed
  `tw-animate-css`; durations point at the §6 named tokens). Vendored
  a `Skeleton` primitive and migrated five hand-rolled
  `animate-pulse` blocks. Report's full-screen error sink became an
  inline calm banner + Retry per §10. Recharts auto-animation off.

### Mid-release polish (within V3, before V3-P9)

- "Cozy honey" warm palette retheme — replaced the V1-baseline cool
  greys + amber with the warm-honey canvas that `DESIGN-SYSTEM` §1
  now describes as "Calm Dark — Linear × Things 3, warm not
  corporate".
- Per-arch macOS DMGs — the release workflow built `aarch64` and
  `x86_64` separately rather than producing a universal binary,
  because the llama-server sidecar is per-arch. (Superseded later in
  v1.0.5 by the "Dropped the macOS Intel build target" note above:
  the shipped matrix is now Apple Silicon `aarch64` only.)
- Audit pass (`audit/sev1-sev2-fixes` then `audit/sev3-sev4-fixes`)
  closed Sev1 → Sev3 findings. See `ISSUES.md` for the full ledger;
  I9 (Pomodoro broadcaster takeover) and I18 (sidecar model-path
  sandbox) were surfaced and accepted as deliberate deviations.
- Settings panel macOS scaling fix, AI model-download reachability
  fix on macOS, layout unification through design tokens, human-voice
  pass on shipped copy ahead of V3-P8.
- A localisation-style "no user-facing em dashes" sweep — the long
  dash is a writer's tic; copy reads more like a friend wrote it
  without one.

### V2 — AI accountability

- **V2-P1 — llama-server sidecar.** Tauri spawns `llama-server`
  (llama.cpp build) bundled per platform, listening on a random
  localhost port. Lifecycle (start, health-poll, restart-budget,
  stop) lives in `useSidecarStore`; the binary is launched only when
  AI features are on and a model is picked.
- **V2-P2 — Model picker + benchmark.** First-run shows 3 model
  tiers (Moondream2 / Qwen2.5-VL-3B / Gemma 3 4B as defaults). The
  picker downloads model + projector files together, verifies
  SHA-256, runs a 30-second benchmark, and pins
  `sample_interval = max(5s, p95 + 1s)`. The Gemma tier is gated by
  Hugging Face terms; paste an HF token (stored in the OS keychain)
  once.
- **V2-P3 — Capture pipeline.** `getUserMedia` (face frame) + a
  separate `getDisplayMedia` (screen frame) running in parallel only
  for the AI loop. Each frame downscaled — 384×384 JPEG for the
  face, 1024-wide JPEG for the screen — and posted to llama-server's
  OpenAI-compatible endpoint with the declared topic. Frames are
  never sent to peers. The macOS screen-recording permission
  overlay routes the user to System Settings → Privacy & Security →
  Screen Recording with platform-correct steps.
- **V2-P4 — System prompt + eval harness.** The focus-detection
  system prompt (`features/ai/systemPrompt.ts`) is locked behind
  `FOCUS_SYSTEM_PROMPT_VERSION` so we can hand-iterate without
  drifting silently. A 20-case labelled eval set lives in
  `tests/ai-eval/dataset/` — 8 on-task screenshots, 3 mild, 3
  moderate, 3 blatant, 3 prompt-injection attempts. The runner
  (`tests/ai-eval/run.ts`) writes per-prompt-version scores into
  `RESULTS.md`.
- **V2-P5 — Sample loop + score machine.** The pure sample loop
  ticks at the benchmark-derived interval, skipping if the previous
  inference is still in flight (never queues). The score machine
  maps `on_task | mild | moderate | blatant` to deductions (0 / -2 /
  -5 / -15), with the "two consecutive samples before warning, two
  more before peer alert" thresholds.
- **V2-P6 — Self-warning + peer alerts.** First 2 consecutive
  off-task samples surface a private self-warning badge (the user
  only). Next 2 broadcast a signed `ai_alert` event to peers via the
  WebRTC data channel; peers see the alert tone + the model's
  one-line reasoning, never the raw frames. Scores stay private
  until the post-session report.
- **V2-P7 — AI dialog + break handling.** Ctrl/Cmd + ] opens a
  floating, always-on-top, transparent Tauri window. Type "5 min
  water break" — the AI agent classifies the intent (topic-change /
  break-request / question / unknown) and the deterministic rule
  layer in `features/session/break.ts` is the final arbiter
  (cool-down ≥25 min between breaks, ≤10 min per break clamp,
  ≤4 breaks per session). Approved breaks pause sampling, score
  deduction, and emit a `break_approved` audit event.
- **V2-P8 — Audit events + post-session report.** Every join,
  leave, topic change, warning, alert, break request / approval /
  denial is signed and persisted to local SQLite. The Report screen
  reads from SQLite (so re-opening from Settings → Sessions is
  byte-identical to the fresh-session-end view): score gauge with
  spring-easing reveal, topic timeline, per-peer event timeline,
  top distractions.
- **V2-P9 — AI gate + migration + topic declaration.** Settings →
  AI master toggle. When AI is on, a session must declare a topic
  before it goes live (`TopicGateModal` runs once before
  `hostSession` / `joinSession`). Migration 002 ships the schema
  forward without losing V1 data. The mid-session Ctrl+] topic-
  change path mutates `declaredStudyTopic` and emits a
  `topic_change` audit event.

### V1 — Study with friends, no AI

- **V1-P1 — Project scaffold.** Tauri 2 + React 19 + Vite 8 +
  Tailwind v4 + TypeScript strict + shadcn/ui + rusqlite. Single-
  instance check; `path::data_dir()` for the keypair file; system
  tray scaffolding.
- **V1-P2 — Design system foundation.** `src/design/tokens.ts` as
  the single source of truth (color, font, spacing, radius, shadow,
  motion, z-index, sizes). `scripts/check-tokens.ts` enforces it on
  pre-commit (no raw hex, no raw cubic-bezier, no arbitrary
  bracket-px). Storybook + the axe-core a11y gate set up here.
- **V1-P3 — Identity creation.** 24-word BIP39 mnemonic shown once.
  Ed25519 + X25519 keypairs derived from one master seed via
  HKDF-SHA256. Private keys in the OS keychain; public keys + display
  name + creation timestamp in `identity.json`. The "I've saved them"
  confirmation gates the Continue button.
- **V1-P4 — SQLite + friends store.** `rusqlite` behind Tauri
  commands (frontend never opens DB handles). The friends table
  carries `ed_pubkey_hex`, `x_pubkey_hex`, `display_name`,
  `paired_at`, `last_studied_with`.
- **V1-P5 — Trystero pairing.** The 12-word one-time pairing flow:
  generate words → both peers derive `pair_topic` +
  `pair_password` → trystero finds the rendezvous on Nostr →
  signed `hello` exchange proves both pubkeys came from the same
  party who knew the secret → save to SQLite → discard the words.
- **V1-P6 — Friends list + inbox + invite.** The always-on inbox
  topic subscription. Encrypted invite envelopes via NaCl box.
  Toast + OS notification on incoming invite. Online / offline
  presence per friend (derived from per-friend presence channels).
- **V1-P7 — Tray + autostart + shortcuts.** System tray "Open
  StudyVis" / "Quit". `tauri-plugin-autostart` for opt-in launch at
  login. `tauri-plugin-global-shortcut` registers `Ctrl/Cmd + [`
  (PTT for friends) and `Ctrl/Cmd + ]` (Talk to AI) at the OS
  layer.
- **V1-P8 — Session room + WebRTC mesh + PTT.** Trystero's
  signaling builds the full-mesh WebRTC topology (≤4 peers).
  Default-muted; holding the PTT shortcut unmutes the local audio
  track while held. Per-tile presence dot + name overlay.
- **V1-P9 — Audit log + Pomodoro.** Signed audit events over the
  WebRTC data channel (`joined`, `left`, `paused_break`,
  `resumed`, `pomodoro_start`, `pomodoro_end`). Pomodoro
  broadcaster sync — one peer drives the timer, all peers receive
  phase ticks every 5s; broadcaster disconnect triggers a 10s
  hand-over to the next-oldest peer.
- **V1-P10 — Onboarding.** Welcome → permissions → identity →
  display name → add first friend (skippable) → tutorial. Each step
  honours the `OnboardingStep` progress dots + primary/secondary
  action shell.
- **V1-P11 — Settings panel.** The left-rail / right-pane shell
  with categories: Identity, Friends, Sessions, Stats (added in
  V3-P1), Appearance, Notifications, Shortcuts, AI (added in V2),
  Network, Advanced, About.
- **V1-P12 — Friends-only unsigned installers.** macOS `.dmg`
  (ad-hoc signing only — friends right-click → Open the first time),
  Windows `.msi` (unsigned — SmartScreen → Run anyway). Release
  workflow triggers on `v*.*.*` tags; no auto-update plugin.

### V0 — Pre-flight

A 30-minute throwaway Tauri test app verified that the webview
could do `getUserMedia` and `getDisplayMedia` on macOS and Windows,
and that two instances could rendezvous on a trystero room. Linux
WebKitGTK was the open question; Linux deferred to V3.

## What's intentionally not in 1.0

See the matching section in `README.md`. Briefly: Linux installers,
signed installers + auto-update, additional theme variants (sepia /
high-contrast), AI-weighted focused-minutes, a tile-alert-duration
control, a rolling 2-hour break window, the `sessions.breaks_taken`
column, dropping the unused V2 `models` table, `llama-server.log`
rotation, expanding the `/style` dev route to the composed component
layer (Storybook covers it instead), the
`LEGACY_THEME_LOCALSTORAGE_KEY` cosmetic rename, and the boot-paint
script extraction. Each is recorded with the reason it didn't make
1.0.

Audit-ledger items `I9` (Pomodoro broadcaster takeover) and `I18`
(sidecar model-path sandbox) are accepted deviations under the
friends-only threat model and the "advanced users can point at any
local GGUF" promise. Not reopened.
