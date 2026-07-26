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
// Anything smaller cannot be a real llama-server (smallest prebuilt ~9 MB);
// mirrors MIN_REAL_ENGINE_BYTES in commands/engine.rs.
const PLACEHOLDER_CEILING_BYTES: u64 = 4 * 1024 * 1024;

fn ensure_debug_sidecar_placeholder() {
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
    if std::env::var("PROFILE").as_deref() != Ok("debug") {
        // Release-profile arm: tauri-build only checks the file EXISTS, so a
        // placeholder left behind by an earlier debug build (gitignored —
        // invisible in `git status`) would bundle silently into a local
        // installer. Fail the build instead (PR-88 review).
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() < PLACEHOLDER_CEILING_BYTES {
                panic!(
                    "{} is a dev placeholder, not a real llama-server; run scripts/fetch-llama-server.sh before a release-profile build",
                    path.display()
                );
            }
        }
        return;
    }
    // The resources glob `binaries/llama-runtime-*/*` ALSO hard-fails when
    // nothing matches (a truly fresh checkout has neither the binary nor the
    // runtime dir — both gitignored), so the placeholder must cover both.
    // The marker file inside is inert: resolve_runtime_dir only prepends the
    // dir to the library search path, and the fetch script overwrites the
    // whole dir when it runs.
    let runtime_dir = path
        .parent()
        .expect("binaries dir has a parent")
        .join(format!("llama-runtime-{target}"));
    if !runtime_dir.exists() {
        let _ = fs::create_dir_all(&runtime_dir);
        let _ = fs::write(
            runtime_dir.join("PLACEHOLDER-README.txt"),
            b"studyvis placeholder: real companion libraries come from scripts/fetch-llama-server.sh or the in-app engine auto-install (I73)\n",
        );
    }
    if path.exists() {
        return;
    }
    let _ = fs::create_dir_all(path.parent().expect("binaries dir has a parent"));
    let _ = fs::write(
        &path,
        b"studyvis placeholder: the real llama-server comes from scripts/fetch-llama-server.sh or the in-app engine auto-install (I73)\n",
    );
}
