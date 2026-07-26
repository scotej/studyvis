use std::fs;
use std::path::PathBuf;

fn main() {
    ensure_debug_sidecar_placeholder();
    tauri_build::build()
}

// I73 — tauri-build hard-fails when the `externalBin` file is missing, which
// made scripts/fetch-llama-server.sh a manual prerequisite for every fresh
// checkout (cargo check/test/clippy included). For DEBUG-profile builds only,
// drop a tiny placeholder so the toolchain runs with zero setup; at runtime
// the engine auto-installer treats anything under its size gate as absent and
// downloads the real binary. Release-profile builds still fail loudly —
// CI/release fetch real binaries before cargo runs, and a placeholder must
// never ship inside an installer.
//
// Writing into src-tauri/binaries/ trips `tauri dev`'s file watcher once on a
// fresh checkout (observed: two extra rebuilds, then it settles because the
// file is never rewritten). A one-time cost, only where the fetch script was
// never run.
fn ensure_debug_sidecar_placeholder() {
    if std::env::var("PROFILE").as_deref() != Ok("debug") {
        return;
    }
    let Ok(target) = std::env::var("TARGET") else {
        return;
    };
    let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let ext = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let path = PathBuf::from(manifest_dir)
        .join("binaries")
        .join(format!("llama-server-{target}{ext}"));
    if path.exists() {
        return;
    }
    let _ = fs::create_dir_all(path.parent().expect("binaries dir has a parent"));
    let _ = fs::write(
        &path,
        b"studyvis placeholder: the real llama-server comes from scripts/fetch-llama-server.sh or the in-app engine auto-install (I73)\n",
    );
}
