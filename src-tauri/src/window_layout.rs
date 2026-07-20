//! Boot-time restore of the remembered window geometry (Settings →
//! Appearance → Window).
//!
//! The JS side (`WindowLayoutListener`) tracks moves/resizes of the main
//! window debounced into `settings.json` (`window_layout`: physical pixels
//! plus the scale factor they were captured under, gated by
//! `remember_window_layout`). This module reads that file during
//! `setup_desktop` — after `apply_window_style`, before `window.show()` —
//! so the restore is flicker-free by construction, riding the same
//! `visible: false` choreography V3-P7 built for the chrome swap.
//!
//! Coordinate spaces are the hard part. Raw physical pixels only mean
//! something relative to a monitor scale, and the hidden window still sits
//! on the default-spawn monitor when we restore — so applying captured
//! physical values through a differently-scaled monitor would rescale the
//! size or strand the window (retina laptop + 1x external is the textbook
//! Mac setup). The strategy per platform:
//!
//! * **Windows / Linux**: physical coordinates form one uniform global
//!   space, so the saved physical rect is unambiguous. Restore the
//!   *position first* (lands the window on the monitor it was captured
//!   on, letting the DPI-change rescale of the default size happen), then
//!   set the exact captured physical size.
//! * **macOS**: there is no uniform physical space — tao derives each
//!   monitor's "physical" coordinates from its own backing scale, and
//!   set_position/set_size convert through the scale of whatever screen
//!   the window currently occupies. The only stable space is the logical
//!   (CoreGraphics) one, so convert the saved rect through its captured
//!   scale and restore with Logical types — size first (see the apply
//!   block for why the order flips per platform).
//!
//! The geometry policy is pure (space-agnostic `f64` rects) so `cargo
//! test` drives it without a windowing system. A saved position is honored
//! only when enough of the window's title strip still intersects a
//! connected monitor — a rect remembered on an unplugged display falls
//! back to centering instead of opening off-screen.

/// Mirrors `app.windows[0].minWidth/minHeight` in tauri.conf.json
/// (logical units). The OS min-size constraint re-clamps anything smaller
/// anyway; doing it here too keeps the applied geometry honest and the
/// policy unit-testable.
const MIN_LOGICAL_WIDTH: f64 = 1024.0;
const MIN_LOGICAL_HEIGHT: f64 = 640.0;

/// How much of the window's top strip must remain on some monitor for the
/// saved position to count as reachable: a band the height of a title bar,
/// and at least this many units of width to grab with the pointer.
const REACHABLE_STRIP_HEIGHT: f64 = 38.0;
const REACHABLE_MIN_WIDTH: f64 = 64.0;

/// The persisted layout: physical pixels + the scale factor they were
/// captured under (see `WindowLayout` in src/stores/settingsStore.ts).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SavedLayout {
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub maximized: bool,
}

/// A monitor's rect in the same physical convention tao reports, plus its
/// scale so macOS can convert into logical space.
#[derive(Debug, Clone, Copy)]
pub struct MonitorRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// Space-agnostic rectangle used by the pure policy functions.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl SavedLayout {
    pub fn physical_rect(&self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }

    pub fn logical_rect(&self) -> Rect {
        Rect {
            x: self.x / self.scale,
            y: self.y / self.scale,
            width: self.width / self.scale,
            height: self.height / self.scale,
        }
    }
}

impl MonitorRect {
    pub fn physical_rect(&self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }

    pub fn logical_rect(&self) -> Rect {
        Rect {
            x: self.x / self.scale,
            y: self.y / self.scale,
            width: self.width / self.scale,
            height: self.height / self.scale,
        }
    }
}

/// Forgiving read of the `remember_window_layout` flag from the parsed
/// settings.json. Absent or malformed means the shipped default: on.
pub fn remember_enabled(settings: &serde_json::Value) -> bool {
    settings
        .get("remember_window_layout")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true)
}

/// Forgiving read of the `window_layout` object. Any missing, mistyped, or
/// non-finite field drops the whole layout — half a geometry is worse than
/// none.
pub fn parse_window_layout(settings: &serde_json::Value) -> Option<SavedLayout> {
    let layout = settings.get("window_layout")?;
    let field = |name: &str| -> Option<f64> {
        let v = layout.get(name)?.as_f64()?;
        if v.is_finite() {
            Some(v)
        } else {
            None
        }
    };
    let width = field("width")?;
    let height = field("height")?;
    let x = field("x")?;
    let y = field("y")?;
    let scale = field("scaleFactor")?;
    let maximized = layout.get("maximized")?.as_bool()?;
    if width <= 0.0 || height <= 0.0 || scale <= 0.0 {
        return None;
    }
    Some(SavedLayout {
        width,
        height,
        x,
        y,
        scale,
        maximized,
    })
}

/// Clamp a rect's size to the conf minimums expressed in the rect's own
/// space (`min_scale` = 1.0 for logical rects, the captured scale for
/// physical ones).
pub fn clamp_size(width: f64, height: f64, min_scale: f64) -> (f64, f64) {
    (
        width.max(MIN_LOGICAL_WIDTH * min_scale),
        height.max(MIN_LOGICAL_HEIGHT * min_scale),
    )
}

/// True when the window's title strip — the part you need to see and grab
/// to recover a mispositioned window — still intersects some monitor by at
/// least `REACHABLE_MIN_WIDTH` × its full height. Both rects must be in
/// the same coordinate space.
pub fn position_is_reachable(window: &Rect, monitors: &[Rect]) -> bool {
    let strip_left = window.x;
    let strip_right = window.x + window.width;
    let strip_top = window.y;
    let strip_bottom = window.y + REACHABLE_STRIP_HEIGHT;
    monitors.iter().any(|m| {
        let overlap_w = strip_right.min(m.x + m.width) - strip_left.max(m.x);
        let overlap_h = strip_bottom.min(m.y + m.height) - strip_top.max(m.y);
        overlap_w >= REACHABLE_MIN_WIDTH && overlap_h >= REACHABLE_STRIP_HEIGHT
    })
}

/// The applied geometry in one space: a clamped size, an optional position
/// (None = center instead), and the maximized flag.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AppliedLayout {
    pub width: f64,
    pub height: f64,
    pub position: Option<(f64, f64)>,
    pub maximized: bool,
}

/// `window` and `monitors` must share a coordinate space; `min_scale`
/// expresses the conf minimums in that space (see `clamp_size`).
pub fn sanitize_layout(
    layout: &SavedLayout,
    window: &Rect,
    monitors: &[Rect],
    min_scale: f64,
) -> AppliedLayout {
    let (width, height) = clamp_size(window.width, window.height, min_scale);
    let position = if position_is_reachable(window, monitors) {
        Some((window.x, window.y))
    } else {
        None
    };
    AppliedLayout {
        width,
        height,
        position,
        maximized: layout.maximized,
    }
}

#[cfg(desktop)]
pub fn apply_saved_window_layout<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;

    // Same forgiving one-shot read as the sibling boot reads in lib.rs:
    // any failure keeps the conf-defined 1280×800 centered default.
    let read = || -> Option<serde_json::Value> {
        let dir = app.path().app_data_dir().ok()?;
        let bytes = std::fs::read(dir.join("settings.json")).ok()?;
        serde_json::from_slice(&bytes).ok()
    };
    let Some(settings) = read() else { return };
    if !remember_enabled(&settings) {
        return;
    }
    let Some(layout) = parse_window_layout(&settings) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let monitors: Vec<MonitorRect> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| MonitorRect {
            x: f64::from(m.position().x),
            y: f64::from(m.position().y),
            width: f64::from(m.size().width),
            height: f64::from(m.size().height),
            scale: m.scale_factor(),
        })
        .collect();

    // macOS: restore in logical (CoreGraphics) space — the only uniform
    // one there. Everything else: physical space is uniform, use it raw.
    #[cfg(target_os = "macos")]
    let applied = {
        let monitor_rects: Vec<Rect> = monitors.iter().map(MonitorRect::logical_rect).collect();
        sanitize_layout(&layout, &layout.logical_rect(), &monitor_rects, 1.0)
    };
    #[cfg(not(target_os = "macos"))]
    let applied = {
        let monitor_rects: Vec<Rect> = monitors.iter().map(MonitorRect::physical_rect).collect();
        sanitize_layout(
            &layout,
            &layout.physical_rect(),
            &monitor_rects,
            layout.scale,
        )
    };

    // Apply order differs by platform and matters on both:
    //
    // * macOS: size FIRST. NSWindow.setContentSize anchors the frame's
    //   bottom-left corner (macOS is y-up), so sizing after positioning
    //   would shift the top-left up by the height delta — a window
    //   restored taller than the 800 spawn height would climb off the top
    //   of the screen. Logical values need no monitor context, so sizing
    //   on the spawn screen is safe; center() also computes from the
    //   current size, so it too must follow set_size.
    // * Windows/Linux: position FIRST when there is one. Landing on the
    //   captured monitor lets the DPI-change rescale of the default size
    //   happen before the exact captured physical size is applied under
    //   that monitor's DPI (set_inner_size keeps the top-left, so the
    //   position survives). The centered fallback stays on the spawn
    //   monitor — no DPI move — so there size-then-center keeps the
    //   centering true.
    #[cfg(target_os = "macos")]
    {
        let _ = window.set_size(tauri::LogicalSize::new(applied.width, applied.height));
        match applied.position {
            Some((x, y)) => {
                let _ = window.set_position(tauri::LogicalPosition::new(x, y));
            }
            None => {
                let _ = window.center();
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let size =
            tauri::PhysicalSize::new(applied.width.round() as u32, applied.height.round() as u32);
        match applied.position {
            Some((x, y)) => {
                let _ = window.set_position(tauri::PhysicalPosition::new(
                    x.round() as i32,
                    y.round() as i32,
                ));
                let _ = window.set_size(size);
            }
            None => {
                let _ = window.set_size(size);
                let _ = window.center();
            }
        }
    }
    if applied.maximized {
        let _ = window.maximize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn primary() -> MonitorRect {
        MonitorRect {
            x: 0.0,
            y: 0.0,
            width: 2560.0,
            height: 1440.0,
            scale: 1.0,
        }
    }

    fn saved(x: f64, y: f64) -> SavedLayout {
        SavedLayout {
            width: 1280.0,
            height: 800.0,
            x,
            y,
            scale: 1.0,
            maximized: false,
        }
    }

    fn rects(monitors: &[MonitorRect]) -> Vec<Rect> {
        monitors.iter().map(MonitorRect::physical_rect).collect()
    }

    #[test]
    fn remember_defaults_on_when_absent_or_malformed() {
        assert!(remember_enabled(&serde_json::json!({})));
        assert!(remember_enabled(
            &serde_json::json!({ "remember_window_layout": "yes" })
        ));
        assert!(!remember_enabled(
            &serde_json::json!({ "remember_window_layout": false })
        ));
    }

    #[test]
    fn parses_a_complete_layout() {
        let settings = serde_json::json!({
            "window_layout": {
                "width": 1600, "height": 900, "x": -1920, "y": 40,
                "scaleFactor": 1.25, "maximized": true
            }
        });
        assert_eq!(
            parse_window_layout(&settings),
            Some(SavedLayout {
                width: 1600.0,
                height: 900.0,
                x: -1920.0,
                y: 40.0,
                scale: 1.25,
                maximized: true,
            })
        );
    }

    #[test]
    fn rejects_missing_mistyped_or_degenerate_layouts() {
        for settings in [
            serde_json::json!({}),
            serde_json::json!({ "window_layout": null }),
            // scaleFactor missing (a pre-scale-aware or hand-edited file).
            serde_json::json!({ "window_layout": { "width": 1600, "height": 900, "x": 0, "y": 0, "maximized": false } }),
            serde_json::json!({ "window_layout": { "width": "1600", "height": 900, "x": 0, "y": 0, "scaleFactor": 1, "maximized": false } }),
            serde_json::json!({ "window_layout": { "width": 0, "height": 900, "x": 0, "y": 0, "scaleFactor": 1, "maximized": false } }),
            serde_json::json!({ "window_layout": { "width": 1600, "height": 900, "x": 0, "y": 0, "scaleFactor": 0, "maximized": false } }),
        ] {
            assert_eq!(parse_window_layout(&settings), None);
        }
    }

    #[test]
    fn clamps_below_conf_minimums_in_the_rect_space() {
        assert_eq!(clamp_size(100.0, 100.0, 1.0), (1024.0, 640.0));
        assert_eq!(clamp_size(1920.0, 1080.0, 1.0), (1920.0, 1080.0));
        // Physical space on a 2x monitor: the minimums scale with it.
        assert_eq!(clamp_size(1500.0, 900.0, 2.0), (2048.0, 1280.0));
    }

    #[test]
    fn on_screen_position_is_reachable() {
        let layout = saved(200.0, 100.0);
        assert!(position_is_reachable(
            &layout.physical_rect(),
            &rects(&[primary()])
        ));
    }

    #[test]
    fn position_on_a_negative_coordinate_monitor_is_reachable() {
        let left_monitor = MonitorRect {
            x: -1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
            scale: 1.0,
        };
        let layout = saved(-1800.0, 50.0);
        assert!(position_is_reachable(
            &layout.physical_rect(),
            &rects(&[left_monitor, primary()])
        ));
    }

    #[test]
    fn off_screen_and_sliver_positions_are_not_reachable() {
        let monitors = rects(&[primary()]);
        // Fully past the right edge of the only monitor.
        assert!(!position_is_reachable(
            &saved(3000.0, 100.0).physical_rect(),
            &monitors
        ));
        // Title strip above the monitor top.
        assert!(!position_is_reachable(
            &saved(200.0, -400.0).physical_rect(),
            &monitors
        ));
        // Only a sliver narrower than the grab minimum remains visible.
        assert!(!position_is_reachable(
            &saved(2560.0 - REACHABLE_MIN_WIDTH + 1.0, 100.0).physical_rect(),
            &monitors
        ));
        // No monitors at all (headless read failure) → center.
        assert!(!position_is_reachable(
            &saved(200.0, 100.0).physical_rect(),
            &[]
        ));
    }

    #[test]
    fn macos_mixed_dpi_restore_lands_in_logical_space() {
        // The textbook Mac setup: 1x external primary spanning logical
        // 0..1920, 2x retina to its right at logical origin 1920 (tao
        // physical origin = 1920 × 2 = 3840, spanning logical 1920..3712).
        // A window saved on the retina at logical (2000, 100), 1280×800
        // logical, was captured as physical (4000, 200), 2560×1600, scale 2.
        let external = MonitorRect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
            scale: 1.0,
        };
        let retina = MonitorRect {
            x: 3840.0,
            y: 0.0,
            width: 3584.0,
            height: 2240.0,
            scale: 2.0,
        };
        let layout = SavedLayout {
            width: 2560.0,
            height: 1600.0,
            x: 4000.0,
            y: 200.0,
            scale: 2.0,
            maximized: false,
        };
        let monitors: Vec<Rect> = [external, retina]
            .iter()
            .map(MonitorRect::logical_rect)
            .collect();
        let applied = sanitize_layout(&layout, &layout.logical_rect(), &monitors, 1.0);
        assert_eq!(applied.position, Some((2000.0, 100.0)));
        assert_eq!((applied.width, applied.height), (1280.0, 800.0));
    }

    #[test]
    fn sanitize_keeps_reachable_position_and_clamps_size() {
        let layout = SavedLayout {
            width: 640.0,
            height: 480.0,
            x: 100.0,
            y: 100.0,
            scale: 1.0,
            maximized: false,
        };
        assert_eq!(
            sanitize_layout(
                &layout,
                &layout.physical_rect(),
                &rects(&[primary()]),
                layout.scale
            ),
            AppliedLayout {
                width: 1024.0,
                height: 640.0,
                position: Some((100.0, 100.0)),
                maximized: false,
            }
        );
    }

    #[test]
    fn sanitize_drops_unreachable_position() {
        let layout = saved(9999.0, 9999.0);
        let applied = sanitize_layout(
            &layout,
            &layout.physical_rect(),
            &rects(&[primary()]),
            layout.scale,
        );
        assert_eq!(applied.position, None);
    }
}
