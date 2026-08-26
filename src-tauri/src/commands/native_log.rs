//! Rust-side producer for the app's structured log (#226).
//!
//! Why this exists at all: `<data_dir>/logs/studyvis.log` was written only by
//! the JS sink batching NDJSON through `app_log_append`. So every record about
//! the native PTT path was written by the renderer — which makes the one
//! question that actually mattered unanswerable by construction. "Did Rust emit
//! an event the webview never received?" cannot be answered by a record the
//! webview writes, because the dropped event is precisely the one that never
//! arrives. Rust therefore appends its own records, through the same lock and
//! the same rotation, tagged `"win":"native"`. Comparing a native count against
//! the renderer's count for the same stream is what turns "the user says it got
//! stuck" into "N physical-state events left the process and never arrived".
//!
//! Two rules keep this safe, and both are load-bearing:
//!
//! 1. **Never on a hot path.** `record` takes a process-global mutex and writes
//!    to disk. It is called at session, registration and thread-lifecycle
//!    boundaries only — never from the global-shortcut handler, never from the
//!    20 ms watcher poll, never while holding `ShortcutBindings`' mutex. Hot
//!    paths increment atomics and this flushes them as cumulative fields.
//! 2. **No free-form strings.** A line written here bypasses the JS redactor
//!    entirely, and Settings → Copy diagnostics applies no scrubbing at all. So
//!    `NativeValue` has no `String` variant, and must never gain one: it is the
//!    redaction boundary, enforced by the compiler on all three CI legs.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Runtime};

use super::applog::{app_log_path, append_rendered_lines};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static RUN_ID: OnceLock<String> = OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(0);
static PRE_INIT_DROPPED: AtomicU64 = AtomicU64::new(0);

pub(crate) const NATIVE_WINDOW: &str = "native";

/// A closed value domain. There is deliberately NO `String` variant: see the
/// module docs. Anything that would want one — a path, a peer id, an
/// accelerator, an OS error message — must be mapped to a `&'static str` from a
/// fixed set by its own classifier first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeValue {
    Bool(bool),
    U64(u64),
    Word(&'static str),
    Null,
}

impl NativeValue {
    // pub(crate): `linux_diagnostics` mirrors boot records to stderr through
    // this renderer so both sinks show byte-identical values.
    pub(crate) fn render_into(self, out: &mut String) {
        match self {
            NativeValue::Bool(v) => out.push_str(if v { "true" } else { "false" }),
            NativeValue::U64(v) => out.push_str(&v.to_string()),
            // `Word` is always a compile-time literal from this crate, so it
            // cannot contain a quote or a control character.
            NativeValue::Word(v) => {
                out.push('"');
                out.push_str(v);
                out.push('"');
            }
            NativeValue::Null => out.push_str("null"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeLevel {
    Info,
    Error,
}

impl NativeLevel {
    fn as_str(self) -> &'static str {
        match self {
            NativeLevel::Info => "info",
            NativeLevel::Error => "error",
        }
    }
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`, always UTC, always exactly 24 ASCII characters —
/// the same shape `Date.prototype.toISOString` produces, so a reader cannot
/// tell a native record's timestamp from a renderer one.
///
/// Hand-rolled on purpose. A `chrono`/`time` dependency would mean editing
/// `Cargo.toml` and `Cargo.lock`, regenerating `THIRD-PARTY-NOTICES`, re-syncing
/// the bundled resource copies and re-running `cargo deny` — a large supply
/// chain change to format one string.
pub(crate) fn iso8601_millis(epoch_ms: u64) -> String {
    let total_secs = epoch_ms / 1_000;
    let millis = epoch_ms % 1_000;
    let days = (total_secs / 86_400) as i64;
    let secs_of_day = total_secs % 86_400;

    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        secs_of_day / 3_600,
        (secs_of_day % 3_600) / 60,
        secs_of_day % 60,
    )
}

// Howard Hinnant's days-from-civil inverse. Unix time has no leap seconds, so
// a day is exactly 86,400 seconds and this is exact.
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// A splitmix64 round over the clock and the pid. This only needs to be
// distinct from the two renderer realms' ids, never unpredictable, so it does
// not justify a `rand`/`uuid` dependency.
pub(crate) fn run_id_from(nanos: u128, pid: u32) -> String {
    let mut x = (nanos as u64) ^ ((pid as u64) << 32) ^ 0x9E37_79B9_7F4A_7C15;
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^= x >> 31;
    format!("{:08x}", (x & 0xFFFF_FFFF) as u32)
}

// The app version is the one runtime string allowed onto a line, so it is
// filtered rather than trusted: anything outside this set is dropped.
fn safe_version(version: &str) -> String {
    version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'))
        .take(32)
        .collect()
}

/// Key order is `v, ts, seq, run, win, lvl, scope, msg[, data]`, rendered by
/// hand rather than through `serde_json::json!`. `serde_json::Map` is a
/// `BTreeMap`, which would alphabetise the keys and put `msg` before `scope` —
/// and `ci.yml` / `release.yml` both grep the packaged log for the literal
/// `"scope":"runtime.webrtc","msg":"ready"`. That adjacency is release
/// infrastructure, so a test pins it.
pub(crate) fn render_record(
    ts: &str,
    seq: u64,
    run: &str,
    level: NativeLevel,
    scope: &str,
    msg: &str,
    fields: &[(&'static str, NativeValue)],
) -> String {
    let mut out = String::with_capacity(160);
    out.push_str("{\"v\":1,\"ts\":\"");
    out.push_str(ts);
    out.push_str("\",\"seq\":");
    out.push_str(&seq.to_string());
    out.push_str(",\"run\":\"");
    out.push_str(run);
    out.push_str("\",\"win\":\"");
    out.push_str(NATIVE_WINDOW);
    out.push_str("\",\"lvl\":\"");
    out.push_str(level.as_str());
    out.push_str("\",\"scope\":\"");
    out.push_str(scope);
    out.push_str("\",\"msg\":\"");
    out.push_str(msg);
    out.push('"');
    if !fields.is_empty() {
        out.push_str(",\"data\":{");
        for (index, (key, value)) in fields.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push('"');
            out.push_str(key);
            out.push_str("\":");
            value.render_into(&mut out);
        }
        out.push('}');
    }
    out.push('}');
    out
}

/// Resolve the log path and run id once, at desktop setup. Records emitted
/// before this lands are counted rather than written — `run.start` reports the
/// count so a reader is never left guessing whether the gap was a drop.
pub(crate) fn init<R: Runtime>(app: &AppHandle<R>, version: &str) {
    if LOG_PATH.get().is_some() {
        return;
    }
    let Ok(path) = app_log_path(app) else {
        return;
    };
    let _ = LOG_PATH.set(path);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let _ = RUN_ID.set(run_id_from(nanos, std::process::id()));

    record(
        NativeLevel::Info,
        "native",
        "run.start",
        &[
            ("schema", NativeValue::U64(1)),
            ("os", NativeValue::Word(std::env::consts::OS)),
            ("arch", NativeValue::Word(std::env::consts::ARCH)),
            ("pid", NativeValue::U64(std::process::id() as u64)),
            (
                "preInitDropped",
                NativeValue::U64(PRE_INIT_DROPPED.load(Ordering::Relaxed)),
            ),
        ],
    );
    // The version is the one filtered runtime string; kept on its own line so
    // the closed-enum rule above stays absolute.
    let safe = safe_version(version);
    if !safe.is_empty() {
        record_version(&safe);
    }
}

fn record_version(safe: &str) {
    let (Some(path), Some(run)) = (LOG_PATH.get(), RUN_ID.get()) else {
        return;
    };
    let seq = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let line = format!(
        "{{\"v\":1,\"ts\":\"{}\",\"seq\":{seq},\"run\":\"{run}\",\"win\":\"{NATIVE_WINDOW}\",\"lvl\":\"info\",\"scope\":\"native\",\"msg\":\"run.version\",\"data\":{{\"ver\":\"{safe}\"}}}}",
        iso8601_millis(epoch_millis())
    );
    let _ = append_rendered_lines(path, &[line]);
}

/// Append one record. Never panics, never blocks a caller on failure, and
/// silently no-ops before `init`. Must not be called from a hot path.
pub(crate) fn record(
    level: NativeLevel,
    scope: &str,
    msg: &str,
    fields: &[(&'static str, NativeValue)],
) {
    let (Some(path), Some(run)) = (LOG_PATH.get(), RUN_ID.get()) else {
        PRE_INIT_DROPPED.fetch_add(1, Ordering::Relaxed);
        return;
    };
    // `seq` is monotonic per producer and is the ordering authority for native
    // records, exactly as `log.ts` documents for a renderer realm. It is
    // allocated before the shared file lock, so with two native producers (the
    // watcher thread and the main thread) file order can differ from seq order
    // under contention. Order by `seq`, not by position in the file.
    let seq = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let line = render_record(
        &iso8601_millis(epoch_millis()),
        seq,
        run,
        level,
        scope,
        msg,
        fields,
    );
    let _ = append_rendered_lines(path, &[line]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_matches_the_javascript_shape() {
        assert_eq!(iso8601_millis(0), "1970-01-01T00:00:00.000Z");
        // 2024-02-29T12:34:56.007Z — a leap day, and a fraction that must keep
        // its leading zeros.
        assert_eq!(
            iso8601_millis(1_709_210_096_007),
            "2024-02-29T12:34:56.007Z"
        );
        // A year boundary, one millisecond either side.
        assert_eq!(
            iso8601_millis(1_735_689_599_999),
            "2024-12-31T23:59:59.999Z"
        );
        assert_eq!(
            iso8601_millis(1_735_689_600_000),
            "2025-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn iso8601_is_always_24_ascii_characters_ending_in_z() {
        let mut value: u64 = 12_345;
        for _ in 0..10_000 {
            // A cheap deterministic walk across a wide range of instants.
            value = value
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let ms = value % 4_102_444_800_000;
            let rendered = iso8601_millis(ms);
            assert_eq!(rendered.len(), 24, "{rendered}");
            assert!(rendered.ends_with('Z'), "{rendered}");
            assert!(rendered.is_ascii(), "{rendered}");
        }
    }

    #[test]
    fn record_key_order_keeps_scope_immediately_before_msg() {
        let line = render_record(
            "2026-08-17T00:00:00.000Z",
            7,
            "abcd1234",
            NativeLevel::Info,
            "runtime.webrtc",
            "ready",
            &[],
        );
        // CI and the release verifier both grep for this exact adjacency.
        assert!(
            line.contains("\"scope\":\"runtime.webrtc\",\"msg\":\"ready\""),
            "{line}"
        );
        assert!(line.starts_with("{\"v\":1,\"ts\":\"2026-08-17T00:00:00.000Z\",\"seq\":7,"));
        assert!(line.contains("\"win\":\"native\""));
    }

    #[test]
    fn a_rendered_record_is_one_valid_json_line() {
        let line = render_record(
            "2026-08-17T00:00:00.000Z",
            1,
            "abcd1234",
            NativeLevel::Error,
            "ptt.native",
            "emit.failed",
            &[
                ("source", NativeValue::Word("physical")),
                ("gen", NativeValue::U64(3)),
                ("level", NativeValue::Null),
                ("consecutive", NativeValue::U64(4)),
                ("ok", NativeValue::Bool(true)),
            ],
        );
        assert!(!line.contains('\n') && !line.contains('\r'), "{line}");
        let parsed: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(parsed["lvl"], "error");
        assert_eq!(parsed["data"]["source"], "physical");
        assert_eq!(parsed["data"]["gen"], 3);
        assert!(parsed["data"]["level"].is_null());
        assert_eq!(parsed["data"]["consecutive"], 4);
        assert_eq!(parsed["data"]["ok"], true);
    }

    #[test]
    fn run_ids_are_eight_lowercase_hex_and_vary() {
        let a = run_id_from(1, 2);
        let b = run_id_from(2, 2);
        assert_eq!(a.len(), 8);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
        assert_ne!(a, b);
    }

    // The version is the only runtime string that reaches a line, so anything
    // that could carry a home directory or a username must not survive it.
    #[test]
    fn version_filtering_drops_anything_path_shaped() {
        assert_eq!(safe_version("1.11.2"), "1.11.2");
        assert_eq!(safe_version("1.12.0-rc.1+build"), "1.12.0-rc.1+build");
        assert_eq!(safe_version("/Users/someone/app"), "Userssomeoneapp");
        assert_eq!(safe_version("\"}injected"), "injected");
        assert_eq!(safe_version(&"9".repeat(64)).len(), 32);
    }
}
