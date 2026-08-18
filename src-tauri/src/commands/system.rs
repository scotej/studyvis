//! System commands and the app's managed runtime flags.
//!
//! Defines the atomic flag types (`QuitFlag`, `MinimizeToTrayFlag`,
//! `AiFeaturesFlag`, `WindowStyleAppliedFlag`, `SessionActiveFlag`,
//! `ShortcutBindings`) that `lib.rs`
//! `manage()`s at setup and consults in the window/run-event handlers, plus
//! assorted commands: autostart, global-shortcut rebinding, quit/relaunch,
//! text-file export, opening OS settings panes, and
//! the battery probe. (X6 retired the hand-rolled GitHub tag check that used
//! to live here — tauri-plugin-updater owns update discovery now.) All flags
//! use `Ordering::Relaxed` deliberately — last-write-wins between the JS setters
//! and the event handlers is fine, and no flag guards memory another thread
//! publishes.
//!
//! Gotcha: `system_relaunch_app` must kill the sidecar itself before calling
//! `app.restart()` — restart skips `RunEvent::Exit`, so the normal sidecar
//! teardown in `lib.rs` never runs on that path.

use std::str::FromStr;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::time::Duration;

use serde::Serialize;
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;
#[cfg(target_os = "macos")]
use tauri_plugin_global_shortcut::{Code, Modifiers};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use super::native_log;
use tauri_plugin_opener::OpenerExt;

use crate::db::data_dir;

/// Armed by `app_quit` after the in-app confirm; `lib.rs`'s close-requested
/// handler lets the window close once armed.
pub struct QuitFlag(pub AtomicBool);

impl QuitFlag {
    pub fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    pub fn arm<R: Runtime>(app: &AppHandle<R>) {
        app.state::<Self>().0.store(true, Ordering::Relaxed);
    }

    pub fn is_armed<R: Runtime>(app: &AppHandle<R>) -> bool {
        app.state::<Self>().0.load(Ordering::Relaxed)
    }
}

// Initial value comes from `settings.json` at app boot (see
// `read_minimize_to_tray_from_settings` in lib.rs); the JS settings store
// pushes subsequent updates via `system_minimize_to_tray_set_enabled`. Reading
// from disk during `setup` closes a Cmd+W race window where the previous
// implementation defaulted to `true` until JS hydrated, so a user with the
// flag persisted as `false` could see one stray hide-to-tray on the first
// close before settings hydration. Relaxed ordering is safe because the only
// consumer (`on_window_event`) does not need to race with the JS command —
// last-write-wins is fine and the cost of a stale read is one duplicate
// close attempt.
pub struct MinimizeToTrayFlag(pub AtomicBool);

impl MinimizeToTrayFlag {
    pub fn new(initial: bool) -> Self {
        Self(AtomicBool::new(initial))
    }

    pub fn set<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
        app.state::<Self>().0.store(enabled, Ordering::Relaxed);
    }

    pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
        app.state::<Self>().0.load(Ordering::Relaxed)
    }
}

// V2-P9 AI-features gate. Initial value comes from `settings.json` at app
// boot (see `read_ai_features_from_settings` in lib.rs); the JS settings store
// pushes subsequent updates via `system_ai_features_set_enabled`. The only
// consumer is the global Ctrl+] shortcut handler, which no-ops when the flag
// is off so the floating AI dialog never opens while AI is disabled. Relaxed
// ordering matches `MinimizeToTrayFlag`: last-write-wins is fine and a stale
// read costs at most one extra (or skipped) dialog toggle.
pub struct AiFeaturesFlag(pub AtomicBool);

impl AiFeaturesFlag {
    pub fn new(initial: bool) -> Self {
        Self(AtomicBool::new(initial))
    }

    pub fn set<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
        app.state::<Self>().0.store(enabled, Ordering::Relaxed);
    }

    pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
        app.state::<Self>().0.load(Ordering::Relaxed)
    }
}

// The browser-side window-style cache is only a pre-paint hint; it can be
// cleared or fail independently of settings.json. `apply_window_style` marks
// this flag only after the native API succeeds, and the main webview queries
// it before rendering its TitleBar. That keeps the React chrome coupled to the
// frame the OS actually applied instead of to a second persistence mechanism.
pub struct WindowStyleAppliedFlag(pub AtomicBool);

impl WindowStyleAppliedFlag {
    pub fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    pub fn set<R: Runtime>(app: &AppHandle<R>, custom: bool) {
        app.state::<Self>().0.store(custom, Ordering::Relaxed);
    }

    pub fn is_custom<R: Runtime>(app: &AppHandle<R>) -> bool {
        app.state::<Self>().0.load(Ordering::Relaxed)
    }
}

#[tauri::command]
pub fn system_window_style_is_custom_applied<R: Runtime>(app: AppHandle<R>) -> bool {
    WindowStyleAppliedFlag::is_custom(&app)
}

// N4 quit-confirm gate. The JS session store pushes the live-session state
// via `session_set_active` so every real-quit path in lib.rs (window close
// with minimize-to-tray off, tray Quit, macOS Cmd+Q) can intercept with a
// "quit-requested" event instead of dropping peers mid-session. Relaxed
// ordering matches the flags above: last-write-wins, and a stale read costs
// at most one unnecessary (or skipped) confirm.
pub struct SessionActiveFlag(pub AtomicBool);

impl SessionActiveFlag {
    pub fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    pub fn set<R: Runtime>(app: &AppHandle<R>, active: bool) {
        app.state::<Self>().0.store(active, Ordering::Relaxed);
    }

    pub fn is_active<R: Runtime>(app: &AppHandle<R>) -> bool {
        app.state::<Self>().0.load(Ordering::Relaxed)
    }
}

// V3-P3 — runtime-mutable global shortcut bindings. The two `Mutex<Shortcut>`
// fields are the V1-P7 interior-mutability pattern: the handler locks the
// same Mutex per keystroke to compare against the *current* shortcut, and
// `system_set_global_shortcut` swaps the held value after unregister +
// register both succeed. `std::sync::Mutex` is enough — the lock is held
// for a single field copy.
pub struct ShortcutBindings {
    ptt_friends: Mutex<Shortcut>,
    ptt_ai: Mutex<Shortcut>,
}

impl ShortcutBindings {
    // Always returns a valid binding pair: a malformed `initial_*` (empty
    // string, unparseable accelerator from a manually-edited settings.json,
    // etc.) silently falls back to the shipped default so boot registration
    // is as forgiving as the JS hydrator. On macOS friends-PTT also requires
    // a key the CoreGraphics physical-state watcher can observe; a legacy or
    // hand-edited unsupported key falls back to the safe shipped default.
    pub fn new(initial_ptt_friends: &str, initial_ptt_ai: &str) -> Self {
        let ptt_friends =
            Self::parse_or_default(initial_ptt_friends, DEFAULT_PTT_FRIENDS_ACCELERATOR);
        #[cfg(target_os = "macos")]
        let ptt_friends = if macos_key_code(ptt_friends.key).is_some() {
            ptt_friends
        } else {
            Self::parse_or_default(
                DEFAULT_PTT_FRIENDS_ACCELERATOR,
                DEFAULT_PTT_FRIENDS_ACCELERATOR,
            )
        };

        Self {
            ptt_friends: Mutex::new(ptt_friends),
            ptt_ai: Mutex::new(Self::parse_or_default(
                initial_ptt_ai,
                DEFAULT_PTT_AI_ACCELERATOR,
            )),
        }
    }

    fn parse_or_default(pref: &str, default_accelerator: &str) -> Shortcut {
        if let Ok(s) = Shortcut::from_str(pref) {
            return s;
        }
        Shortcut::from_str(default_accelerator).expect("default accelerator must parse")
    }

    pub fn ptt_friends(&self) -> Shortcut {
        // Recover from a poisoned mutex (an unrelated panic while a previous
        // handler held the lock) so the global shortcut handler never
        // crashes the process on a hot path.
        *self.ptt_friends.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn ptt_ai(&self) -> Shortcut {
        *self.ptt_ai.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn store_ptt_friends(&self, shortcut: Shortcut) {
        *self.ptt_friends.lock().unwrap_or_else(|e| e.into_inner()) = shortcut;
    }

    fn store_ptt_ai(&self, shortcut: Shortcut) {
        *self.ptt_ai.lock().unwrap_or_else(|e| e.into_inner()) = shortcut;
    }
}

const DEFAULT_PTT_FRIENDS_ACCELERATOR: &str = "CmdOrCtrl+[";
const DEFAULT_PTT_AI_ACCELERATOR: &str = "CmdOrCtrl+]";

#[cfg(target_os = "macos")]
static PTT_PHYSICAL_MONITOR_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "macos")]
const PTT_PHYSICAL_POLL_INTERVAL: Duration = Duration::from_millis(20);
#[cfg(target_os = "macos")]
const PTT_PHYSICAL_CONFIRMATION_SENDS: u8 = 11;
#[cfg(target_os = "macos")]
const PTT_PHYSICAL_CONFIRMATION_EVERY_POLLS: u8 = 5;
#[cfg(target_os = "macos")]
const PTT_PHYSICAL_STATE_EVENT: &str = "ptt-friends-physical-state";

// Swap one of the two global shortcuts at runtime. Unregister-then-register
// (per the tauri-plugin-global-shortcut guidance; double-registering the
// same combo silently fails on some macOS versions). The Mutex update only
// runs after both side-effects succeed so a partial failure can't leave
// the handler stale.
#[tauri::command]
pub fn system_set_global_shortcut<R: Runtime>(
    app: AppHandle<R>,
    action: String,
    accelerator: String,
) -> Result<(), String> {
    let new_shortcut = Shortcut::from_str(&accelerator)
        .map_err(|e| format!("Couldn't read {accelerator}: {e}"))?;

    // Hold-to-talk recovery on macOS is only safe when CoreGraphics can query
    // the same virtual key Carbon registered. Reject an unsupported custom
    // friends-PTT key BEFORE unregistering the working binding, so settings
    // never silently downgrade to a two-minute-only stuck-key fallback.
    #[cfg(target_os = "macos")]
    if action == "ptt-friends" && macos_key_code(new_shortcut.key).is_none() {
        return Err(
            "That Push to Talk key cannot be monitored safely on macOS. Choose a standard keyboard key."
                .to_string(),
        );
    }

    let bindings = app.state::<ShortcutBindings>();
    let (old_shortcut, other_shortcut) = match action.as_str() {
        "ptt-friends" => (bindings.ptt_friends(), bindings.ptt_ai()),
        "ptt-ai" => (bindings.ptt_ai(), bindings.ptt_friends()),
        _ => return Err(format!("unknown shortcut action: {action}")),
    };
    if old_shortcut == new_shortcut {
        return Ok(());
    }
    let manager = app.global_shortcut();
    // Only unregister the old combo if it's ACTUALLY registered at the OS level
    // AND the other action isn't still bound to it. Two ways the stored binding
    // can point at a combo that was never OS-registered: (1) both actions shared
    // one combo (hand-edited settings.json — the UI rejects equal accelerators),
    // so it has a single registration the other action still needs; (2) the
    // boot-time registration failed (OS conflict; PR-8 registers best-effort),
    // leaving ShortcutBindings holding an unregistered combo. Calling unregister
    // on an unregistered shortcut errors and would wedge the rebind, so gate it.
    let old_is_shared = other_shortcut == old_shortcut;
    let should_unregister_old = !old_is_shared && manager.is_registered(old_shortcut);
    if should_unregister_old {
        manager
            .unregister(old_shortcut)
            .map_err(|e| format!("Couldn't unregister the old shortcut: {e}"))?;
    }
    if let Err(err) = manager.register(new_shortcut) {
        // Best-effort: put the old one back (only if we actually removed it) so
        // the user isn't left with no PTT binding while their UI shows the
        // rejected new one.
        if should_unregister_old {
            let _ = manager.register(old_shortcut);
        }
        return Err(format!("Couldn't register {accelerator}: {err}"));
    }
    match action.as_str() {
        "ptt-friends" => {
            bindings.store_ptt_friends(new_shortcut);
            // #47 B5 — the register above validated the OS accepts the combo,
            // but friends-PTT only lives while a session is active. Outside
            // one, release it right away (never when the AI action shares the
            // combo — that registration must survive).
            if !SessionActiveFlag::is_active(&app) && new_shortcut != other_shortcut {
                let _ = manager.unregister(new_shortcut);
            }
        }
        "ptt-ai" => bindings.store_ptt_ai(new_shortcut),
        _ => unreachable!("action validated above"),
    }
    Ok(())
}

#[tauri::command]
pub fn autostart_set_enabled<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn autostart_is_enabled<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

// #226 — per-keystroke emit outcomes. Incremented from the global-shortcut
// handler, which must stay allocation- and lock-free, and flushed to the log at
// session end. Renderer-side counts of RECEIVED edges are logged separately;
// the difference between the two is the only proof of a lost delivery.
static PTT_PRESSED_EMIT_OK: AtomicU64 = AtomicU64::new(0);
static PTT_PRESSED_EMIT_ERR: AtomicU64 = AtomicU64::new(0);
static PTT_RELEASED_EMIT_OK: AtomicU64 = AtomicU64::new(0);
static PTT_RELEASED_EMIT_ERR: AtomicU64 = AtomicU64::new(0);

pub fn count_ptt_pressed_emit(ok: bool) {
    let counter = if ok {
        &PTT_PRESSED_EMIT_OK
    } else {
        &PTT_PRESSED_EMIT_ERR
    };
    counter.fetch_add(1, Ordering::Relaxed);
}

pub fn count_ptt_released_emit(ok: bool) {
    let counter = if ok {
        &PTT_RELEASED_EMIT_OK
    } else {
        &PTT_RELEASED_EMIT_ERR
    };
    counter.fetch_add(1, Ordering::Relaxed);
}

#[tauri::command]
pub fn session_set_active<R: Runtime>(app: AppHandle<R>, active: bool) -> Result<(), String> {
    SessionActiveFlag::set(&app, active);
    // #47 B5 — the friends-PTT global shortcut only exists while a session is
    // live; boot registers just the AI shortcut (see lib.rs).
    apply_ptt_friends_registration(&app, active);
    update_ptt_physical_monitor(&app, active);

    // #226 — the renderer logs `ptt/session.armed` for the same transition.
    // Both records present means PTT really was armed; a renderer record with
    // no native counterpart means the invoke never landed.
    let (friends_registered, ai_registered) = {
        let bindings = app.state::<ShortcutBindings>();
        let manager = app.global_shortcut();
        (
            manager.is_registered(bindings.ptt_friends()),
            manager.is_registered(bindings.ptt_ai()),
        )
    };
    native_log::record(
        native_log::NativeLevel::Info,
        "ptt.native",
        "session.state",
        &[
            ("active", native_log::NativeValue::Bool(active)),
            (
                "friendsRegistered",
                native_log::NativeValue::Bool(friends_registered),
            ),
            ("aiRegistered", native_log::NativeValue::Bool(ai_registered)),
            (
                "pressedEmitOk",
                native_log::NativeValue::U64(PTT_PRESSED_EMIT_OK.load(Ordering::Relaxed)),
            ),
            (
                "pressedEmitErr",
                native_log::NativeValue::U64(PTT_PRESSED_EMIT_ERR.load(Ordering::Relaxed)),
            ),
            (
                "releasedEmitOk",
                native_log::NativeValue::U64(PTT_RELEASED_EMIT_OK.load(Ordering::Relaxed)),
            ),
            (
                "releasedEmitErr",
                native_log::NativeValue::U64(PTT_RELEASED_EMIT_ERR.load(Ordering::Relaxed)),
            ),
        ],
    );
    Ok(())
}

// #47 B5 — register the friends-PTT combo on session start, release it on
// session end. Best-effort on both edges: a failed register leaves PTT inert
// for this session (rebind in Settings → Shortcuts fixes it); a failed
// unregister costs one more idle session of a swallowed combo. Guards:
//   - is_registered: a shared friends/ai combo (hand-edited settings.json)
//     is already held by the boot-time AI registration — skip; and never
//     unregister a combo the AI shortcut still needs.
fn apply_ptt_friends_registration<R: Runtime>(app: &AppHandle<R>, active: bool) {
    let bindings = app.state::<ShortcutBindings>();
    let friends = bindings.ptt_friends();
    let ai = bindings.ptt_ai();
    let manager = app.global_shortcut();
    // #226 — these eprintln!s went to a stderr no packaged .app or .exe has, so
    // a session where PTT was never registered looked identical to one where it
    // worked. Every branch now leaves a record, including the two skips.
    let (op, ok, skipped) = if active {
        if manager.is_registered(friends) {
            ("register", true, Some("already-registered"))
        } else if let Err(err) = manager.register(friends) {
            eprintln!("[global-shortcut] couldn't register PTT for the session: {err}");
            ("register", false, None)
        } else {
            ("register", true, None)
        }
    } else if friends == ai {
        ("unregister", true, Some("shared-combo"))
    } else if !manager.is_registered(friends) {
        ("unregister", true, Some("not-registered"))
    } else if let Err(err) = manager.unregister(friends) {
        eprintln!("[global-shortcut] couldn't release PTT after the session: {err}");
        ("unregister", false, None)
    } else {
        ("unregister", true, None)
    };

    native_log::record(
        if ok {
            native_log::NativeLevel::Info
        } else {
            native_log::NativeLevel::Error
        },
        "ptt.native",
        "shortcut.state",
        &[
            ("op", native_log::NativeValue::Word(op)),
            ("target", native_log::NativeValue::Word("ptt-friends")),
            ("ok", native_log::NativeValue::Bool(ok)),
            (
                "skipped",
                match skipped {
                    Some(reason) => native_log::NativeValue::Word(reason),
                    None => native_log::NativeValue::Null,
                },
            ),
            ("sessionActive", native_log::NativeValue::Bool(active)),
        ],
    );
}

// #226 — Windows and Linux have no physical-state watcher at all. Saying so
// once per session turns "no physical records in this archive" from an
// ambiguous silence into a statement about the platform.
#[cfg(not(target_os = "macos"))]
fn update_ptt_physical_monitor<R: Runtime>(_app: &AppHandle<R>, active: bool) {
    native_log::record(
        native_log::NativeLevel::Info,
        "ptt.native",
        "monitor.unsupported",
        &[
            ("active", native_log::NativeValue::Bool(active)),
            ("os", native_log::NativeValue::Word(std::env::consts::OS)),
        ],
    );
}

// #209 / #226 — Carbon's global-hotkey edges are useful but are not
// authoritative enough for a privacy-sensitive hold-to-talk latch. While a
// session is live, macOS also exposes the CURRENT physical keyboard state
// through CoreGraphics. One generation-scoped watcher observes the current
// persisted PTT binding and publishes every new level immediately:
// `true` = physically held, `false` = physically up, `null` = unobservable.
// It then confirms that same level every 100 ms for one second. Only a
// successful Tauri emit consumes a confirmation; an emitter failure is due
// again on the next 20 ms poll.
//
// The bounded confirmation window is deliberate anti-entropy. The previous
// watcher remembered a level before knowing the renderer received it and then
// suppressed the unchanged value forever, accidentally turning an
// authoritative level back into another one-shot edge. A dropped `false`
// could therefore recreate the exact stuck indicator the watcher was meant to
// eliminate. Repeated current-state copies are idempotent in the frontend and
// let any delivered `false` heal a dropped Carbon Released or an unavailable
// renderer listener without producing steady-state session traffic.
// Runtime rebinding is picked up on the next 20 ms poll.
#[cfg(target_os = "macos")]
fn update_ptt_physical_monitor<R: Runtime>(app: &AppHandle<R>, active: bool) {
    let generation = PTT_PHYSICAL_MONITOR_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    if !active {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        // #226 — the loop body below runs every 20 ms and must stay free of
        // allocation, locks and I/O. It accumulates counters; the records are
        // written once on entry and once on exit.
        native_log::record(
            native_log::NativeLevel::Info,
            "ptt.native",
            "watcher.armed",
            &[
                ("gen", native_log::NativeValue::U64(generation)),
                ("pollMs", native_log::NativeValue::U64(20)),
                (
                    "sends",
                    native_log::NativeValue::U64(PTT_PHYSICAL_CONFIRMATION_SENDS as u64),
                ),
                (
                    "everyPolls",
                    native_log::NativeValue::U64(PTT_PHYSICAL_CONFIRMATION_EVERY_POLLS as u64),
                ),
            ],
        );

        let started = std::time::Instant::now();
        let mut polls: u64 = 0;
        let mut levels: u64 = 0;
        let mut emit_ok: u64 = 0;
        let mut emit_err: u64 = 0;
        let mut unobservable_polls: u64 = 0;
        let mut last_state: Option<Option<bool>> = None;
        let mut emit_failure_logged = false;

        let mut confirmation = super::level_confirmation::LevelConfirmation::new(
            PTT_PHYSICAL_CONFIRMATION_SENDS,
            PTT_PHYSICAL_CONFIRMATION_EVERY_POLLS,
        );
        while PTT_PHYSICAL_MONITOR_GENERATION.load(Ordering::Acquire) == generation
            && SessionActiveFlag::is_active(&app)
        {
            polls += 1;
            let shortcut = app.state::<ShortcutBindings>().ptt_friends();
            let current_state = macos_shortcut_is_held(shortcut);
            if current_state.is_none() {
                unobservable_polls += 1;
            }
            if last_state != Some(current_state) {
                last_state = Some(current_state);
                levels += 1;
            }
            if confirmation.should_publish(current_state) {
                if app.emit(PTT_PHYSICAL_STATE_EVENT, current_state).is_ok() {
                    emit_ok += 1;
                    confirmation.mark_published();
                } else {
                    emit_err += 1;
                    // Proven undelivered, from the only side that can see it.
                    // Written once per watcher generation: by the time this
                    // fires the channel is already broken, and a record per
                    // 20 ms poll would bury the history that explains it.
                    if !emit_failure_logged {
                        emit_failure_logged = true;
                        native_log::record(
                            native_log::NativeLevel::Error,
                            "ptt.native",
                            "emit.failed",
                            &[
                                ("source", native_log::NativeValue::Word("physical")),
                                ("gen", native_log::NativeValue::U64(generation)),
                                (
                                    "level",
                                    match current_state {
                                        Some(true) => native_log::NativeValue::Word("true"),
                                        Some(false) => native_log::NativeValue::Word("false"),
                                        None => native_log::NativeValue::Null,
                                    },
                                ),
                                ("polls", native_log::NativeValue::U64(polls)),
                            ],
                        );
                    }
                }
            }
            std::thread::sleep(PTT_PHYSICAL_POLL_INTERVAL);
        }

        // `emitOk` against the renderer's received `physicalEvents` count is
        // the arithmetic that proves a delivery loss, and the exit reason
        // distinguishes a superseded generation from a closed session — two
        // completely different explanations for a hold that never released.
        // Check the session flag FIRST. `update_ptt_physical_monitor` bumps the
        // generation on EVERY call, including the session-end one, so testing
        // the generation first labelled every ordinary session end
        // "superseded" and the field could never make the distinction it
        // exists for.
        let session_ended = !SessionActiveFlag::is_active(&app);
        let superseded =
            !session_ended && PTT_PHYSICAL_MONITOR_GENERATION.load(Ordering::Acquire) != generation;
        native_log::record(
            native_log::NativeLevel::Info,
            "ptt.native",
            "watcher.exited",
            &[
                ("gen", native_log::NativeValue::U64(generation)),
                (
                    "reason",
                    native_log::NativeValue::Word(if superseded {
                        "superseded"
                    } else {
                        "session-inactive"
                    }),
                ),
                (
                    "uptimeMs",
                    native_log::NativeValue::U64(started.elapsed().as_millis() as u64),
                ),
                ("polls", native_log::NativeValue::U64(polls)),
                ("levels", native_log::NativeValue::U64(levels)),
                ("emitOk", native_log::NativeValue::U64(emit_ok)),
                ("emitErr", native_log::NativeValue::U64(emit_err)),
                (
                    "unobservablePolls",
                    native_log::NativeValue::U64(unobservable_polls),
                ),
            ],
        );
    });
}

#[cfg(target_os = "macos")]
fn macos_shortcut_is_held(shortcut: Shortcut) -> Option<bool> {
    let key_code = macos_key_code(shortcut.key)?;
    let key_down = unsafe { CGEventSourceKeyState(CG_EVENT_SOURCE_COMBINED_SESSION, key_code) };
    if !key_down {
        return Some(false);
    }
    let flags = unsafe { CGEventSourceFlagsState(CG_EVENT_SOURCE_COMBINED_SESSION) };
    Some(required_modifiers_held(shortcut.mods, flags))
}

#[cfg(target_os = "macos")]
fn required_modifiers_held(modifiers: Modifiers, flags: u64) -> bool {
    (!modifiers.contains(Modifiers::SHIFT) || flags & CG_EVENT_FLAG_SHIFT != 0)
        && (!modifiers.contains(Modifiers::CONTROL) || flags & CG_EVENT_FLAG_CONTROL != 0)
        && (!modifiers.contains(Modifiers::ALT) || flags & CG_EVENT_FLAG_ALTERNATE != 0)
        && (!modifiers.contains(Modifiers::SUPER) || flags & CG_EVENT_FLAG_COMMAND != 0)
}

#[cfg(target_os = "macos")]
const CG_EVENT_SOURCE_COMBINED_SESSION: i32 = 0;
#[cfg(target_os = "macos")]
const CG_EVENT_FLAG_SHIFT: u64 = 1 << 17;
#[cfg(target_os = "macos")]
const CG_EVENT_FLAG_CONTROL: u64 = 1 << 18;
#[cfg(target_os = "macos")]
const CG_EVENT_FLAG_ALTERNATE: u64 = 1 << 19;
#[cfg(target_os = "macos")]
const CG_EVENT_FLAG_COMMAND: u64 = 1 << 20;

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceKeyState(state_id: i32, key: u16) -> bool;
    fn CGEventSourceFlagsState(state_id: i32) -> u64;
}

// Keep this map byte-for-byte aligned with global-hotkey 0.8's macOS
// `key_to_scancode`: the physical-state watcher must interpret a custom binding
// using the same virtual key code Carbon registered for it. Friends-PTT rebinds
// are rejected when they fall through to None, so this map is a safety boundary
// rather than a best-effort diagnostic convenience.
#[cfg(target_os = "macos")]
fn macos_key_code(code: Code) -> Option<u16> {
    match code {
        Code::KeyA => Some(0x00),
        Code::KeyS => Some(0x01),
        Code::KeyD => Some(0x02),
        Code::KeyF => Some(0x03),
        Code::KeyH => Some(0x04),
        Code::KeyG => Some(0x05),
        Code::KeyZ => Some(0x06),
        Code::KeyX => Some(0x07),
        Code::KeyC => Some(0x08),
        Code::KeyV => Some(0x09),
        Code::KeyB => Some(0x0b),
        Code::KeyQ => Some(0x0c),
        Code::KeyW => Some(0x0d),
        Code::KeyE => Some(0x0e),
        Code::KeyR => Some(0x0f),
        Code::KeyY => Some(0x10),
        Code::KeyT => Some(0x11),
        Code::Digit1 => Some(0x12),
        Code::Digit2 => Some(0x13),
        Code::Digit3 => Some(0x14),
        Code::Digit4 => Some(0x15),
        Code::Digit6 => Some(0x16),
        Code::Digit5 => Some(0x17),
        Code::Equal => Some(0x18),
        Code::Digit9 => Some(0x19),
        Code::Digit7 => Some(0x1a),
        Code::Minus => Some(0x1b),
        Code::Digit8 => Some(0x1c),
        Code::Digit0 => Some(0x1d),
        Code::BracketRight => Some(0x1e),
        Code::KeyO => Some(0x1f),
        Code::KeyU => Some(0x20),
        Code::BracketLeft => Some(0x21),
        Code::KeyI => Some(0x22),
        Code::KeyP => Some(0x23),
        Code::Enter => Some(0x24),
        Code::KeyL => Some(0x25),
        Code::KeyJ => Some(0x26),
        Code::Quote => Some(0x27),
        Code::KeyK => Some(0x28),
        Code::Semicolon => Some(0x29),
        Code::Backslash => Some(0x2a),
        Code::Comma => Some(0x2b),
        Code::Slash => Some(0x2c),
        Code::KeyN => Some(0x2d),
        Code::KeyM => Some(0x2e),
        Code::Period => Some(0x2f),
        Code::Tab => Some(0x30),
        Code::Space => Some(0x31),
        Code::Backquote => Some(0x32),
        Code::Backspace => Some(0x33),
        Code::Escape => Some(0x35),
        Code::CapsLock => Some(0x39),
        Code::F17 => Some(0x40),
        Code::NumpadDecimal => Some(0x41),
        Code::NumpadMultiply => Some(0x43),
        Code::NumpadAdd => Some(0x45),
        Code::PrintScreen => Some(0x46),
        Code::NumLock => Some(0x47),
        Code::AudioVolumeUp => Some(0x48),
        Code::AudioVolumeDown => Some(0x49),
        Code::AudioVolumeMute => Some(0x4a),
        Code::NumpadDivide => Some(0x4b),
        Code::NumpadEnter => Some(0x4c),
        Code::NumpadSubtract => Some(0x4e),
        Code::F18 => Some(0x4f),
        Code::F19 => Some(0x50),
        Code::NumpadEqual => Some(0x51),
        Code::Numpad0 => Some(0x52),
        Code::Numpad1 => Some(0x53),
        Code::Numpad2 => Some(0x54),
        Code::Numpad3 => Some(0x55),
        Code::Numpad4 => Some(0x56),
        Code::Numpad5 => Some(0x57),
        Code::Numpad6 => Some(0x58),
        Code::Numpad7 => Some(0x59),
        Code::F20 => Some(0x5a),
        Code::Numpad8 => Some(0x5b),
        Code::Numpad9 => Some(0x5c),
        Code::F5 => Some(0x60),
        Code::F6 => Some(0x61),
        Code::F7 => Some(0x62),
        Code::F3 => Some(0x63),
        Code::F8 => Some(0x64),
        Code::F9 => Some(0x65),
        Code::F11 => Some(0x67),
        Code::F13 => Some(0x69),
        Code::F16 => Some(0x6a),
        Code::F14 => Some(0x6b),
        Code::F10 => Some(0x6d),
        Code::F12 => Some(0x6f),
        Code::F15 => Some(0x71),
        Code::Insert => Some(0x72),
        Code::Home => Some(0x73),
        Code::PageUp => Some(0x74),
        Code::Delete => Some(0x75),
        Code::F4 => Some(0x76),
        Code::End => Some(0x77),
        Code::F2 => Some(0x78),
        Code::PageDown => Some(0x79),
        Code::F1 => Some(0x7a),
        Code::ArrowLeft => Some(0x7b),
        Code::ArrowRight => Some(0x7c),
        Code::ArrowDown => Some(0x7d),
        Code::ArrowUp => Some(0x7e),
        _ => None,
    }
}

// Unconditional quit, called by the frontend after the user confirms the
// "quit-requested" prompt. Arming QuitFlag first keeps the CloseRequested
// handler from re-intercepting the teardown, exactly like tray-quit.
#[tauri::command]
pub fn app_quit<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    QuitFlag::arm(&app);
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn system_minimize_to_tray_set_enabled<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    MinimizeToTrayFlag::set(&app, enabled);
    Ok(())
}

#[tauri::command]
pub fn system_ai_features_set_enabled<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    AiFeaturesFlag::set(&app, enabled);
    // "AI off → zero AI surface": tear down an already-open floating Ctrl+]
    // dialog. The shortcut to close it is itself gated on the flag, so without
    // this the window would be orphaned (only Esc/blur could dismiss it).
    if !enabled {
        if let Some(dialog) = app.get_webview_window(crate::commands::ai_dialog::AI_DIALOG_LABEL) {
            let _ = dialog.destroy();
        }
    }
    Ok(())
}

// R3 — write a user-chosen file for the report/stats export. The
// destination path comes from the dialog plugin's `save()` picker (the user
// explicitly selected it), so this only performs the write the dialog plugin
// itself cannot do. We add this small command instead of pulling in
// `@tauri-apps/plugin-fs`: the only file write the app needs is "the path the
// user just picked," and a single targeted command keeps the JS-callable
// surface narrower than a general filesystem plugin (least-new-surface, same
// rationale as the single-destination `system_open_releases`). The contents
// are UTF-8 text (markdown / CSV / JSON), so a plain write_string suffices.
#[tauri::command]
pub fn system_write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents.as_bytes()).map_err(|e| format!("Couldn't write {path}: {e}"))
}

const IMAGE_SAVE_MAX_BYTES: usize = 5 * 1024 * 1024;

fn image_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn safe_image_filename(filename: &str, extension: &str) -> String {
    let basename = filename.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = basename
        .chars()
        .filter(|character| !character.is_control() && !r#"<>:"/\|?*"#.contains(*character))
        .take(120)
        .collect();
    let expected_suffix = format!(".{extension}");
    if cleaned.to_ascii_lowercase().ends_with(&expected_suffix) {
        cleaned
    } else {
        format!("studyvis-image.{extension}")
    }
}

// Image downloads are deliberately a single native operation: renderer code
// can suggest a safe filename and bytes, but only the path returned by this
// command's native save dialog is writable. Never accept a renderer-supplied
// destination here.
#[tauri::command]
pub async fn system_save_image<R: Runtime>(
    app: AppHandle<R>,
    filename: String,
    mime_type: String,
    bytes: Vec<u8>,
) -> Result<bool, String> {
    let extension = image_extension(&mime_type).ok_or("Unsupported image type")?;
    if bytes.is_empty() || bytes.len() > IMAGE_SAVE_MAX_BYTES {
        return Err("Invalid image size".to_string());
    }
    let default_filename = safe_image_filename(&filename, extension);
    let Some(destination) = app
        .dialog()
        .file()
        .set_file_name(default_filename)
        .add_filter("Image", &[extension])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let destination = destination
        .into_path()
        .map_err(|e| format!("Invalid image destination: {e}"))?;
    std::fs::write(destination, bytes)
        .map_err(|e| format!("Couldn't write the selected image: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub fn system_open_data_folder<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let dir = data_dir(&app)?;
    let dir_str = dir.to_string_lossy().into_owned();
    app.opener()
        .reveal_item_in_dir(&dir_str)
        .map_err(|e| e.to_string())?;
    Ok(dir_str)
}

// The About card needs exactly one outbound URL — the GitHub Releases page —
// so the command takes no parameters. This keeps the JS-callable IPC surface
// to a single hardcoded destination rather than a generic open-any-URL.
const RELEASES_URL: &str = "https://github.com/scotej/studyvis/releases";

#[tauri::command]
pub fn system_open_releases<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.opener()
        .open_url(RELEASES_URL, None::<&str>)
        .map_err(|e| e.to_string())
}

// V2-P5 battery awareness for the AI sample loop. ARCHITECTURE.md §8: "if
// user_on_battery and battery_pct < 20: pause AI". Returned shape matches
// the `RawBattery` interface in `src/features/ai/battery.ts`.
//
// Desktops / VMs without a battery, and platforms whose battery source cannot
// be read, return a graceful "on AC, 100%" so the sample loop keeps ticking;
// that's safer than refusing inference on hardware the crate can't introspect.
#[derive(Serialize)]
pub struct BatteryInfo {
    pub on_battery: bool,
    pub percent: u8,
}

#[tauri::command]
pub fn system_battery() -> Result<BatteryInfo, String> {
    let manager = match battery::Manager::new() {
        Ok(m) => m,
        Err(_) => return Ok(no_battery_fallback()),
    };
    let mut iter = match manager.batteries() {
        Ok(it) => it,
        Err(_) => return Ok(no_battery_fallback()),
    };
    let primary = match iter.next() {
        Some(Ok(b)) => b,
        Some(Err(_)) | None => return Ok(no_battery_fallback()),
    };
    let raw_pct = primary.state_of_charge().value * 100.0;
    let pct_clamped = if raw_pct.is_finite() {
        raw_pct.clamp(0.0, 100.0)
    } else {
        100.0
    };
    let on_battery = matches!(primary.state(), battery::State::Discharging);
    Ok(BatteryInfo {
        on_battery,
        percent: pct_clamped.round() as u8,
    })
}

fn no_battery_fallback() -> BatteryInfo {
    BatteryInfo {
        on_battery: false,
        percent: 100,
    }
}

// V3-P6 — Relaunches the StudyVis process. Used by Settings → Appearance
// after the user toggles the custom window-chrome preference: the
// decoration / title-bar-style swap takes effect at the *next* Rust
// `setup()` boot (see `apply_window_style` in lib.rs), so a clean restart
// is the honest path. `AppHandle::restart` is divergent — it replaces the
// current process and never returns — so the `Result` return type is
// kept for `#[tauri::command]` ergonomics and the value never resolves.
#[tauri::command]
pub fn system_relaunch_app<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    // `app.restart()` on the main thread goes straight to
    // `cleanup_before_exit()` + `process::restart()` and SKIPS RunEvent::Exit,
    // where the sidecar's only kill lives — so a live llama-server would be
    // orphaned (holding its port and, on Windows, its model.gguf). Kill it
    // first; kill_blocking is synchronous and idempotent.
    crate::commands::sidecar::SidecarState::kill_blocking(&app);
    app.restart()
}

// macOS Sequoia surfaces Screen Recording grants as a per-app entry in
// System Settings → Privacy & Security → Screen Recording. The
// `x-apple.systempreferences` URL scheme jumps the user straight to that
// pane. On non-macOS targets the command no-ops with an error so callers
// fall back to a textual instruction.
#[tauri::command]
pub fn system_open_screen_capture_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        const URL: &str =
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
        app.opener()
            .open_url(URL, None::<&str>)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("not supported on this platform".to_string())
    }
}

// Same per-app Privacy pane jump for Camera. A hard-denied camera grant won't
// re-prompt from getUserMedia, so the onboarding "Open settings" button routes
// the user straight to System Settings → Privacy & Security → Camera.
#[tauri::command]
pub fn system_open_camera_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        const URL: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera";
        app.opener()
            .open_url(URL, None::<&str>)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("not supported on this platform".to_string())
    }
}

// #47 B7 — jump to the OS notification settings so a user whose system-level
// permission is denied (macOS never re-prompts after a hard denial) can fix
// the state the Settings → Notifications status row diagnoses. macOS opens
// the Notifications pane; Windows opens ms-settings:notifications; Linux
// starts the native KDE or GNOME settings panel for the active desktop.
#[cfg(target_os = "linux")]
const KDE_NOTIFICATION_SETTINGS: (&str, &str) = ("systemsettings", "kcm_notifications");
#[cfg(target_os = "linux")]
const GNOME_NOTIFICATION_SETTINGS: (&str, &str) = ("gnome-control-center", "notifications");

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LinuxDesktop {
    Kde,
    Gnome,
}

#[cfg(target_os = "linux")]
fn linux_desktop(value: Option<&str>) -> Option<LinuxDesktop> {
    value?.split([':', ';', ',']).find_map(|token| {
        let token = token.trim().to_ascii_lowercase();
        if token == "kde" || token.starts_with("plasma") {
            Some(LinuxDesktop::Kde)
        } else if token.starts_with("gnome") {
            Some(LinuxDesktop::Gnome)
        } else {
            None
        }
    })
}

#[cfg(target_os = "linux")]
fn linux_notification_settings_candidates(
    current_desktop: Option<&str>,
    desktop_session: Option<&str>,
) -> [(&'static str, &'static str); 2] {
    // XDG_CURRENT_DESKTOP describes the current session more precisely than
    // DESKTOP_SESSION, which is retained as a fallback for older desktops.
    match linux_desktop(current_desktop).or_else(|| linux_desktop(desktop_session)) {
        Some(LinuxDesktop::Gnome) => [GNOME_NOTIFICATION_SETTINGS, KDE_NOTIFICATION_SETTINGS],
        Some(LinuxDesktop::Kde) | None => [KDE_NOTIFICATION_SETTINGS, GNOME_NOTIFICATION_SETTINGS],
    }
}

#[cfg(target_os = "linux")]
fn open_linux_notification_settings() -> Result<(), String> {
    let current_desktop = std::env::var("XDG_CURRENT_DESKTOP").ok();
    let desktop_session = std::env::var("DESKTOP_SESSION").ok();
    let candidates = linux_notification_settings_candidates(
        current_desktop.as_deref(),
        desktop_session.as_deref(),
    );
    let mut failures = Vec::with_capacity(candidates.len());

    for (program, argument) in candidates {
        match std::process::Command::new(program).arg(argument).spawn() {
            Ok(mut child) => {
                // Dropping `Child` does not reap it on Unix. The settings app
                // is independent of StudyVis, so wait on a detached helper
                // thread without blocking the Tauri command handler.
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(());
            }
            Err(err) => failures.push(format!("{program}: {err}")),
        }
    }

    Err(format!(
        "couldn't open notification settings ({})",
        failures.join("; ")
    ))
}

#[tauri::command]
pub fn system_open_notification_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        const URL: &str = "x-apple.systempreferences:com.apple.preference.notifications";
        app.opener()
            .open_url(URL, None::<&str>)
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        app.opener()
            .open_url("ms-settings:notifications", None::<&str>)
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        open_linux_notification_settings()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = app;
        Err("not supported on this platform".to_string())
    }
}

// Same per-app Privacy pane jump for Microphone.
#[tauri::command]
pub fn system_open_microphone_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        const URL: &str =
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
        app.opener()
            .open_url(URL, None::<&str>)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("not supported on this platform".to_string())
    }
}

// X6 / issue #77 — whether tauri-plugin-updater can swap this bundle in
// place. On macOS, reject translocated or read-only bundles. On Linux, only a
// real AppImage named by APPIMAGE is eligible, and both it and its containing
// directory/filesystem must be writable. The JS updater store asks this
// command before downloading so it never offers a restart that cannot install.
#[derive(Serialize)]
pub struct InstallContext {
    pub updatable: bool,
    // "translocated" | "notAppImage" | "readOnlyVolume"; `None` when
    // updatable. Logged by the JS store for diagnosis — the user-facing copy
    // doesn't branch on it.
    pub reason: Option<&'static str>,
}

#[cfg(target_os = "macos")]
fn is_translocated_path(exe: &std::path::Path) -> bool {
    exe.components()
        .any(|c| c.as_os_str() == "AppTranslocation")
}

// statfs on the executable's own path — the bundle lives on the same
// filesystem. Any failure reads as writable: fail open, the worst case is
// the pre-#77 behavior (install errors with the generic toast).
#[cfg(target_os = "macos")]
fn is_on_read_only_volume(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut fs_stat: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c_path.as_ptr(), &mut fs_stat) } != 0 {
        return false;
    }
    fs_stat.f_flags & libc::MNT_RDONLY as u32 != 0
}

#[cfg(target_os = "linux")]
fn linux_path_has_access(path: &std::path::Path, mode: libc::c_int) -> bool {
    use std::os::unix::ffi::OsStrExt;

    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    unsafe { libc::access(c_path.as_ptr(), mode) == 0 }
}

#[cfg(target_os = "linux")]
fn linux_filesystem_is_writable(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;

    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut fs_stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut fs_stat) } != 0 {
        return false;
    }
    fs_stat.f_flag & libc::ST_RDONLY == 0
}

#[cfg(target_os = "linux")]
fn linux_is_appimage(path: &std::path::Path) -> bool {
    use std::io::Read;

    // AppImage embeds its format marker in the ELF identification padding:
    // bytes 0..4 are ELF, bytes 8..10 are "AI", and byte 10 is the AppImage
    // format version. Accept both published AppImage formats; Tauri currently
    // emits type 2. Read only the fixed header so a 200 MB image is not loaded.
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut header = [0_u8; 11];
    file.read_exact(&mut header).is_ok()
        && &header[..4] == b"\x7fELF"
        && &header[8..10] == b"AI"
        && matches!(header[10], 1 | 2)
}

#[cfg(target_os = "linux")]
fn linux_install_context(appimage: Option<&std::ffi::OsStr>) -> InstallContext {
    let Some(appimage) = appimage.filter(|value| !value.is_empty()) else {
        return InstallContext {
            updatable: false,
            reason: Some("notAppImage"),
        };
    };
    let path = std::path::Path::new(appimage);
    let Ok(metadata) = std::fs::metadata(path) else {
        return InstallContext {
            updatable: false,
            reason: Some("notAppImage"),
        };
    };
    let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    else {
        return InstallContext {
            updatable: false,
            reason: Some("notAppImage"),
        };
    };
    let Ok(parent_metadata) = std::fs::metadata(parent) else {
        return InstallContext {
            updatable: false,
            reason: Some("notAppImage"),
        };
    };
    if !path.is_absolute()
        || !metadata.is_file()
        || !parent_metadata.is_dir()
        || !linux_is_appimage(path)
    {
        return InstallContext {
            updatable: false,
            reason: Some("notAppImage"),
        };
    }

    // The updater replaces the AppImage in place. Both the current file and
    // its containing directory must be writable by this process, and neither
    // may be hosted on a read-only filesystem. Permission-bit checks make the
    // result deterministic even when tests run as root; access(2) additionally
    // accounts for the effective user's ownership, groups, and ACLs.
    let appimage_writable = !metadata.permissions().readonly()
        && linux_path_has_access(path, libc::W_OK)
        && linux_filesystem_is_writable(path);
    let parent_writable = !parent_metadata.permissions().readonly()
        && linux_path_has_access(parent, libc::W_OK | libc::X_OK)
        && linux_filesystem_is_writable(parent);
    if !appimage_writable || !parent_writable {
        return InstallContext {
            updatable: false,
            reason: Some("readOnlyVolume"),
        };
    }

    InstallContext {
        updatable: true,
        reason: None,
    }
}

#[tauri::command]
pub fn system_install_context() -> InstallContext {
    #[cfg(target_os = "macos")]
    {
        let Ok(exe) = std::env::current_exe() else {
            return InstallContext {
                updatable: true,
                reason: None,
            };
        };
        if is_translocated_path(&exe) {
            return InstallContext {
                updatable: false,
                reason: Some("translocated"),
            };
        }
        if is_on_read_only_volume(&exe) {
            return InstallContext {
                updatable: false,
                reason: Some("readOnlyVolume"),
            };
        }
        InstallContext {
            updatable: true,
            reason: None,
        }
    }
    #[cfg(target_os = "linux")]
    {
        let appimage = std::env::var_os("APPIMAGE");
        linux_install_context(appimage.as_deref())
    }
    // Windows: the NSIS installer elevates and replaces the install dir
    // itself — there is no translocation equivalent to detect.
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        InstallContext {
            updatable: true,
            reason: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{image_extension, safe_image_filename, RELEASES_URL};

    #[test]
    fn image_save_metadata_is_constrained() {
        assert_eq!(image_extension("image/jpeg"), Some("jpg"));
        assert_eq!(image_extension("image/png"), Some("png"));
        assert_eq!(image_extension("text/plain"), None);
        assert_eq!(safe_image_filename("../notes.PNG", "png"), "notes.PNG");
        assert_eq!(
            safe_image_filename("notes.png.exe", "png"),
            "studyvis-image.png"
        );
    }

    // X6 replaced the X4 tag check with tauri-plugin-updater, whose endpoint
    // is derived from this same repo in tauri.conf.json. Pin the constant so
    // an edit here can't silently point the About card's "Releases" button at
    // a different repo than the one the updater pulls from.
    #[test]
    fn releases_url_points_at_the_studyvis_repo() {
        assert_eq!(RELEASES_URL, "https://github.com/scotej/studyvis/releases");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_notification_settings_follow_the_active_desktop() {
        assert_eq!(
            super::linux_notification_settings_candidates(Some("KDE"), None),
            [
                super::KDE_NOTIFICATION_SETTINGS,
                super::GNOME_NOTIFICATION_SETTINGS
            ]
        );
        assert_eq!(
            super::linux_notification_settings_candidates(
                Some("ubuntu:GNOME"),
                Some("plasmawayland")
            ),
            [
                super::GNOME_NOTIFICATION_SETTINGS,
                super::KDE_NOTIFICATION_SETTINGS
            ]
        );
        assert_eq!(
            super::linux_notification_settings_candidates(None, Some("gnome-classic")),
            [
                super::GNOME_NOTIFICATION_SETTINGS,
                super::KDE_NOTIFICATION_SETTINGS
            ]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_notification_settings_use_a_stable_fallback_order() {
        assert_eq!(
            super::linux_notification_settings_candidates(None, None),
            [
                super::KDE_NOTIFICATION_SETTINGS,
                super::GNOME_NOTIFICATION_SETTINGS
            ]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_updater_requires_an_appimage_path() {
        let missing = super::linux_install_context(None);
        assert!(!missing.updatable);
        assert_eq!(missing.reason, Some("notAppImage"));

        let relative =
            super::linux_install_context(Some(std::ffi::OsStr::new("StudyVis.AppImage")));
        assert!(!relative.updatable);
        assert_eq!(relative.reason, Some("notAppImage"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_updater_requires_a_writable_appimage_and_parent() {
        use std::os::unix::fs::PermissionsExt;

        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "studyvis-install-context-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&dir).unwrap();
        let appimage = dir.join("StudyVis.AppImage");

        std::fs::write(&appimage, b"not an AppImage").unwrap();
        let fake = super::linux_install_context(Some(appimage.as_os_str()));
        assert!(!fake.updatable);
        assert_eq!(fake.reason, Some("notAppImage"));

        // Minimal type-2 AppImage identification header. The install-context
        // probe intentionally validates the fixed magic without parsing or
        // loading the image's full SquashFS payload.
        std::fs::write(&appimage, b"\x7fELF\x02\x01\x01\x00AI\x02").unwrap();
        std::fs::set_permissions(&appimage, std::fs::Permissions::from_mode(0o700)).unwrap();

        let writable = super::linux_install_context(Some(appimage.as_os_str()));
        assert!(writable.updatable);
        assert_eq!(writable.reason, None);

        std::fs::set_permissions(&appimage, std::fs::Permissions::from_mode(0o500)).unwrap();
        let read_only_file = super::linux_install_context(Some(appimage.as_os_str()));
        assert!(!read_only_file.updatable);
        assert_eq!(read_only_file.reason, Some("readOnlyVolume"));

        std::fs::set_permissions(&appimage, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let read_only_parent = super::linux_install_context(Some(appimage.as_os_str()));
        assert!(!read_only_parent.updatable);
        assert_eq!(read_only_parent.reason, Some("readOnlyVolume"));

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // Issue #77 — the exact path shape Gatekeeper produced for the .dmg-run
    // app that could never install its update.
    #[cfg(target_os = "macos")]
    #[test]
    fn translocated_exe_paths_are_flagged() {
        use std::path::Path;
        assert!(super::is_translocated_path(Path::new(
            "/private/var/folders/sw/bgtd8b_97_n/T/AppTranslocation/372166F1-C35B/d/StudyVis.app/Contents/MacOS/studyvis"
        )));
        assert!(!super::is_translocated_path(Path::new(
            "/Applications/StudyVis.app/Contents/MacOS/studyvis"
        )));
        // Component match, not substring — a folder merely *containing* the
        // word must not read as translocated.
        assert!(!super::is_translocated_path(Path::new(
            "/Users/x/AppTranslocationNotes/StudyVis.app/Contents/MacOS/studyvis"
        )));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn writable_and_missing_paths_read_as_writable() {
        use std::path::Path;
        assert!(!super::is_on_read_only_volume(&std::env::temp_dir()));
        // statfs failure fails open.
        assert!(!super::is_on_read_only_volume(Path::new(
            "/no/such/volume/anywhere"
        )));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn ptt_physical_key_map_covers_default_binding() {
        assert_eq!(super::macos_key_code(super::Code::BracketLeft), Some(0x21));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn ptt_physical_key_map_marks_unobservable_keys_unsupported() {
        assert_eq!(super::macos_key_code(super::Code::F24), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unsupported_persisted_ptt_binding_falls_back_to_safe_default() {
        let bindings = super::ShortcutBindings::new("CmdOrCtrl+F24", "CmdOrCtrl+]");
        assert_eq!(bindings.ptt_friends().key, super::Code::BracketLeft);
    }
}
