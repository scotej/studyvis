#!/usr/bin/env python3
"""Guard release-cache boundaries, required jobs, and desktop IPC grants."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shlex
import sys
import tomllib

import yaml


ROOT = Path(__file__).resolve().parent.parent
ADVISORY_JOBS = {"linux-appimage"}
MANIFEST_INPUTS = {"scripts/linux-webkit-runtime.env", "scripts/patches/*.patch"}
BUILD_INPUTS = {
    "scripts/build-linux-webkit-runtime.sh",
    "scripts/generate-librice-third-party-notices.mjs",
}
TOOL_INPUTS = {
    "scripts/linuxdeploy-tools.env",
    "scripts/linux-appimage-runtime.env",
    "scripts/linux-appimage-runtime-sources.tsv",
    "scripts/prepare-linuxdeploy-tools.sh",
    "scripts/linuxdeploy-plugin-appimage.sh",
    "scripts/build-linux-appimage-runtime.sh",
    "scripts/verify-linux-appimage-runtime.sh",
}
MAIN_PERMISSIONS = {
    "core:default", "main-commands", "core:webview:allow-create-webview-window",
    "notification:default", "store:default", "dialog:default", "deep-link:default",
    "updater:default", "core:window:allow-start-dragging", "core:window:allow-minimize",
    "core:window:allow-toggle-maximize", "core:window:allow-close",
    "core:window:allow-hide", "core:window:allow-show", "core:window:allow-is-fullscreen",
    "core:window:allow-set-fullscreen", "core:window:allow-set-size",
    "core:window:allow-set-position", "core:window:allow-center",
    "core:window:allow-unmaximize",
}


def workflow(root: Path, name: str) -> dict:
    document = yaml.safe_load((root / ".github/workflows" / name).read_text())
    if not isinstance(document, dict) or not isinstance(document.get("jobs"), dict):
        raise ValueError(f"{name}: expected a workflow with jobs")
    return document


def env_values(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", line)
        if not match:
            raise ValueError(f"{path.name}: unexpected environment assignment: {line}")
        parts = shlex.split(match[2], comments=True)
        if len(parts) != 1 or match[1] in values:
            raise ValueError(f"{path.name}: invalid or duplicate assignment {match[1]}")
        values[match[1]] = parts[0]
    return values


def expression(value: object) -> str:
    return str(value).strip().removeprefix("${{").removesuffix("}}").strip()


def hashes(key: str) -> list[set[str]]:
    return [set(re.findall(r"['\"]([^'\"]+)['\"]", group))
            for group in re.findall(r"\$\{\{\s*hashFiles\((.*?)\)\s*\}\}", key)]


def check_aggregator(ci: dict, errors: list[str]) -> None:
    jobs = ci["jobs"]
    gate = jobs.get("all-green", {})
    needs = gate.get("needs", [])
    if isinstance(needs, str):
        needs = [needs]
    required = set(jobs) - {"all-green"} - ADVISORY_JOBS
    if set(needs) != required or len(needs) != len(set(needs)):
        errors.append(f"CI aggregate needs must include every required job: "
                      f"missing={sorted(required - set(needs))}, "
                      f"unexpected={sorted(set(needs) - required)}")
    if not ADVISORY_JOBS <= set(jobs):
        errors.append("CI advisory exception must name the existing Linux AppImage job")
    if expression(gate.get("if", "")) != "!cancelled()":
        errors.append("CI aggregate must run after failed/skipped jobs with !cancelled()")
    assertions = [step for step in gate.get("steps", [])
                  if expression(step.get("env", {}).get("NEEDS", "")) == "toJSON(needs)"]
    if not any('.value.result != "success"' in step.get("run", "")
               and re.search(r"\bexit\s+1\b", step.get("run", "")) for step in assertions):
        errors.append("CI aggregate must reject every non-success dependency, including skipped")


def cache_steps(job: dict, filename: str, errors: list[str]) -> dict:
    families = {}
    for step in job.get("steps", []):
        action = step.get("uses", "")
        if not action.startswith("actions/cache"):
            continue
        match = re.match(r"actions/cache/(restore|save)@", action)
        if not match:
            errors.append(f"{filename}: Linux caches must use separate restore/save steps")
            continue
        options = step.get("with", {})
        key = options.get("key", "")
        family = next((name for name in ("webkitgtk", "cargo-c", "sccache-webkit", "linuxdeploy")
                       if key.startswith(f"studyvis-{name}-")), None)
        if family is None:
            errors.append(f"{filename}: unreviewed Linux build cache: {key}")
            continue
        family_steps = families.setdefault(family, {})
        if match[1] in family_steps:
            errors.append(f"{filename}: duplicate {family} {match[1]} cache")
        family_steps[match[1]] = step
    for family in ("webkitgtk", "cargo-c", "sccache-webkit", "linuxdeploy"):
        pair = families.get(family, {})
        if set(pair) != {"restore", "save"}:
            errors.append(f"{filename}: {family} needs exactly one restore/save pair")
            continue
        restore, save = pair["restore"], pair["save"]
        steps = job.get("steps", [])
        start, end = steps.index(restore), steps.index(save)
        validator = {
            "webkitgtk": "bash scripts/build-linux-webkit-runtime.sh",
            "sccache-webkit": "bash scripts/build-linux-webkit-runtime.sh",
            "linuxdeploy": "bash scripts/prepare-linuxdeploy-tools.sh",
            "cargo-c": "scripts/install-cargo-c.sh",
        }[family]
        between = [step.get("run", "") for step in steps[start + 1:end]]
        if start >= end or not any(validator in script or (family == "cargo-c" and "cargo cinstall --version" in script) for script in between):
            errors.append(f"{filename}: {family} cache must be validated between restore and save")
        for field in ("key", "path"):
            if restore.get("with", {}).get(field) != save.get("with", {}).get(field):
                errors.append(f"{filename}: {family} restore/save {field} differs")
        condition = expression(save.get("if", ""))
        expected = "!cancelled()" if family == "sccache-webkit" else "success()"
        if expected not in condition or (family != "sccache-webkit" and "!cancelled()" in condition):
            errors.append(f"{filename}: {family} save must require {expected}")
        if family != "sccache-webkit" and "cache-hit" not in condition:
            errors.append(f"{filename}: {family} save must exclude exact cache hits")
        key = restore["with"]["key"]
        fallbacks = restore["with"].get("restore-keys", "")
        if family in {"cargo-c", "linuxdeploy"} and fallbacks:
            errors.append(f"{filename}: {family} must not use prefix restore fallbacks")
        if family == "webkitgtk":
            if hashes(key) != [MANIFEST_INPUTS, BUILD_INPUTS]:
                errors.append(f"{filename}: WebKit cache must split manifest inputs from build logic")
            expected_fallback = re.sub(r"\$\{\{\s*hashFiles\([^)]*\)\s*\}\}$", "", key)
            if str(fallbacks).strip().splitlines() != [expected_fallback]:
                errors.append(f"{filename}: WebKit fallback crosses the manifest boundary")
        elif family == "sccache-webkit":
            if hashes(key) != [MANIFEST_INPUTS] or not key.endswith("${{ github.sha }}"):
                errors.append(f"{filename}: compiler cache must include the exact manifest tuple and SHA")
            # sccache addresses objects by compiler/input content; its broader
            # fallback is safe. Installed-runtime prefix caches cannot do this.
            compiler_prefix = key.split("${{", 1)[0]
            if str(fallbacks).strip().splitlines() != [key.removesuffix("${{ github.sha }}"), compiler_prefix]:
                errors.append(f"{filename}: compiler cache fallback differs from the reviewed content-addressed policy")
        elif family == "linuxdeploy" and hashes(key) != [TOOL_INPUTS]:
            errors.append(f"{filename}: linuxdeploy key omits a verifier/build/source input")
    return families


def check_caches(root: Path, ci: dict, deploy: dict, release: dict, errors: list[str]) -> None:
    ci_cache = cache_steps(ci["jobs"].get("linux-appimage", {}), "ci.yml", errors)
    deploy_cache = cache_steps(deploy["jobs"].get("installer", {}), "deploy.yml", errors)
    rust_version = tomllib.loads((root / "src-tauri/Cargo.toml").read_text())["package"]["rust-version"]
    for family in ("webkitgtk", "cargo-c", "sccache-webkit", "linuxdeploy"):
        pairs = [cache.get(family, {}).get("restore", {}).get("with", {})
                 for cache in (ci_cache, deploy_cache)]
        if not all(pairs):
            continue
        if family == "linuxdeploy":
            if pairs[0].get("key", "").replace("studyvis-linuxdeploy-ci-", "studyvis-linuxdeploy-", 1) != pairs[1].get("key"):
                errors.append("linuxdeploy cache inputs must match, retaining the intentional -ci path boundary")
            if pairs[0].get("path") == pairs[1].get("path"):
                errors.append("linuxdeploy staging paths must remain distinct between CI and previews")
        else:
            for field in ("key", "restore-keys", "path"):
                if pairs[0].get(field) != pairs[1].get(field):
                    errors.append(f"shared {family} cache {field} differs between CI and previews")
        if family in {"webkitgtk", "cargo-c"}:
            if any(f"rust-{rust_version}-" not in pair["key"] for pair in pairs):
                errors.append(f"{family} cache Rust version differs from Cargo.toml")
    for name, document in (("ci.yml", ci), ("deploy.yml", deploy), ("release.yml", release)):
        for job in document["jobs"].values():
            for step in job.get("steps", []):
                if step.get("uses", "").startswith("dtolnay/rust-toolchain@"):
                    if str(step.get("with", {}).get("toolchain")) != rust_version:
                        errors.append(f"{name}: Rust toolchain differs from Cargo.toml")
    tagged = release["jobs"].get("publish", {})
    builds = []
    for step in tagged.get("steps", []):
        action, script = step.get("uses", ""), step.get("run", "")
        if re.search(r"(?:^|/)(?:cache|rust-cache)(?:/|@)|sccache|ccache", action):
            errors.append("tagged release must not restore build caches")
        build_environment = {**tagged.get("env", {}), **step.get("env", {})}
        if re.search(r"\b(?:sccache|ccache)\b|RUSTC_WRAPPER|SCCACHE_|CCACHE_", script + json.dumps(build_environment)):
            errors.append("tagged release must reconstruct native binaries without compiler caches")
        if re.search(r"^\s*bash scripts/build-linux-webkit-runtime.sh\s*$", script, re.M):
            builds.append(step)
    if len(builds) != 1 or "cache-hit" in str(builds[0].get("if", "")):
        errors.append("tagged release must build its pinned native runtime independently of cache hits")


def check_native_manifest(root: Path, errors: list[str]) -> None:
    native = env_values(root / "scripts/linux-webkit-runtime.env")
    for name, filename in (
        ("STUDYVIS_WEBKIT_PATCH_SHA256", f"webkitgtk-{native['STUDYVIS_WEBKIT_VERSION']}-appimage-sandbox.patch"),
        ("STUDYVIS_GSTREAMER_BAD_PATCH_SHA256", f"gst-plugins-bad-{native['STUDYVIS_GSTREAMER_VERSION']}-webrtc-rollback.patch"),
    ):
        path = root / "scripts/patches" / filename
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != native[name]:
            errors.append(f"native manifest patch hash differs: {filename}")
    runtime = env_values(root / "scripts/linux-appimage-runtime.env")
    import csv
    with (root / "scripts/linux-appimage-runtime-sources.tsv").open() as source:
        rows = list(csv.DictReader(source, delimiter="\t"))
    components = {row["component"]: row for row in rows}
    if len(rows) != len(components):
        errors.append("AppImage source manifest has duplicate components")
    if components.get("type2-runtime", {}).get("version") != runtime["STUDYVIS_APPIMAGE_RUNTIME_COMMIT"]:
        errors.append("AppImage runtime source commit differs from its build tuple")
    meson = components.get("meson", {})
    if meson.get("version") != native["STUDYVIS_GSTREAMER_MESON_VERSION"] or meson.get("sha256") != native["STUDYVIS_GSTREAMER_MESON_SHA256"]:
        errors.append("WebKit and AppImage runtime must use the same pinned Meson source")
    for row in rows:
        if not re.fullmatch(r"[0-9a-f]{64}", row["sha256"]) or not row["url"].startswith("https://"):
            errors.append(f"invalid AppImage source tuple: {row['component']}")
    monitor = json.loads((root / "scripts/native-component-policy.json").read_text())
    monitored = monitor.get("components", [])
    runtime_coverage = {item.get("pin", {}).get("component") for item in monitored if item.get("pin", {}).get("tsv") == "scripts/linux-appimage-runtime-sources.tsv"}
    native_coverage = {item.get("pin", {}).get("key") for item in monitored if item.get("pin", {}).get("env") == "scripts/linux-webkit-runtime.env"}
    required_native = {"STUDYVIS_WEBKIT_VERSION", "STUDYVIS_GSTREAMER_VERSION", "STUDYVIS_LIBRICE_VERSION", "STUDYVIS_LIBNICE_VERSION"}
    if runtime_coverage != set(components) or native_coverage != required_native or len({item.get("id") for item in monitored}) != len(monitored):
        errors.append("native monitoring must cover every pinned runtime source and private media component exactly once")
    if not any(item.get("pin") == {"env": "scripts/fetch-llama-server.sh", "key": "LLAMA_RELEASE_TAG"} for item in monitored):
        errors.append("native monitoring must include the bundled llama.cpp archive")


def check_ipc(root: Path, errors: list[str]) -> None:
    build = (root / "src-tauri/build.rs").read_text()
    manifest = re.search(r"const APP_COMMANDS:.*?=\s*&\[(.*?)\];", build, re.S)
    handler = re.search(r"generate_handler!\[(.*?)\]\);", (root / "src-tauri/src/lib.rs").read_text(), re.S)
    if manifest is None or handler is None or ".commands(APP_COMMANDS)" not in build:
        errors.append("application IPC must retain an explicit command manifest and handler")
        return
    commands = re.findall(r'"([a-z_]+)"', manifest[1])
    dispatch = re.sub(r"#\[.*?\]", "", handler[1], flags=re.S)
    registered = re.findall(r"\b([a-z_]+)\s*,", dispatch)
    policy = tomllib.loads((root / "src-tauri/permissions/window-commands.toml").read_text())
    permission_sets = policy.get("set", [])
    sets = {item["identifier"]: item["permissions"] for item in permission_sets}
    if set(sets) != {"main-commands", "ai-dialog-commands"} or len(sets) != len(permission_sets):
        errors.append("custom IPC policy must retain exactly the two reviewed window permission sets")
    grants = sets.get("main-commands", [])
    expected_grants = {f"allow-{command.replace('_', '-')}" for command in commands}
    if set(commands) != set(registered) or len(commands) != len(set(commands)) or len(registered) != len(set(registered)):
        errors.append("AppManifest and invoke_handler command lists differ or contain duplicates")
    if set(grants) != expected_grants or len(grants) != len(set(grants)):
        errors.append("main command grants differ from the registered application commands")
    if set(sets.get("ai-dialog-commands", [])) != {"allow-app-log-append", "allow-sidecar-status"}:
        errors.append("AI dialog must retain only its two reviewed application commands")
    expected = {
        "default.json": ("main", MAIN_PERMISSIONS),
        "ai-dialog.json": ("ai-dialog", {"core:default", "core:window:allow-close", "ai-dialog-commands"}),
        "session-overlay.json": ("session-overlay", {"core:default", "core:window:allow-close"}),
    }
    directory = root / "src-tauri/capabilities"
    actual_files = {path.name for path in directory.iterdir() if path.suffix in {".json", ".json5", ".toml"}}
    if actual_files != set(expected):
        errors.append("desktop capability files differ from the three reviewed window roles")
    for filename, (window, permissions) in expected.items():
        if not (directory / filename).is_file():
            continue
        capability = json.loads((directory / filename).read_text())
        if capability.get("identifier") != Path(filename).stem:
            errors.append(f"{filename}: capability identifier differs from the reviewed role")
        if capability.get("windows") != [window] or capability.get("webviews") or "remote" in capability or capability.get("local", True) is not True:
            errors.append(f"{filename}: capability must be local and scoped to exactly {window}")
        actual_permissions = capability.get("permissions", [])
        if any(not isinstance(item, str) for item in actual_permissions) or set(actual_permissions) != permissions or len(actual_permissions) != len(permissions):
            errors.append(f"{filename}: permissions differ from the reviewed window policy")
    for config_path in (root / "src-tauri").glob("tauri*.json"):
        security = json.loads(config_path.read_text()).get("app", {}).get("security", {})
        if "capabilities" in security:
            errors.append(f"{config_path.name}: inline/override capability selection requires explicit policy review")


def check_companion_suites(root: Path, ci: dict, errors: list[str]) -> None:
    suites = {"mirror-browser.mjs", "mirror-app-browser.mjs"}
    native = {name for name in suites if (root / "tests/production" / name).is_file()}
    if not native:
        return
    frontend = ci["jobs"].get("frontend", {}).get("steps", [])
    discovery = [step.get("run", "") for step in frontend
                 if step.get("name") == "Production browser regressions"]
    if len(discovery) != 1 or "find tests/production" not in discovery[0] or '"${production_tests[@]}"' not in discovery[0]:
        errors.append("production browser suites must be discovered automatically")
    elif set(re.findall(r"!\s+-name\s+([a-z.-]+)", discovery[0])) != native:
        errors.append("production discovery may exclude only the separately required native companion suites")
    steps = ci["jobs"].get("rust", {}).get("steps", [])
    acceptance = [step for step in steps if step.get("name") == "Browser companion acceptance (Chromium, Firefox, WebKit)"]
    if len(acceptance) != 1:
        errors.append("native companion acceptance must remain in the required Rust job")
        return
    step = acceptance[0]
    script = step.get("run", "")
    if step.get("continue-on-error") or expression(step.get("if", "")) != "runner.os == 'Linux'":
        errors.append("native companion acceptance must run without an error waiver on the Linux Rust leg")
    if "node --import tsx --test --test-concurrency=1" not in script or any(f"tests/production/{name}" not in script for name in native):
        errors.append("every native companion suite must execute with the TypeScript loader and compiled fixture")
    earlier = steps[:steps.index(step)]
    if not any("cargo build --locked --manifest-path src-tauri/Cargo.toml --example mirror_fixture" in item.get("run", "") for item in earlier):
        errors.append("native companion acceptance requires its fixture build first")
    artifacts = [item for item in steps if item.get("name") == "Upload browser companion evidence"]
    private_directories = {"mirror-certificate", "app-certificate", "legacy-to-app-certificate"}
    if len(artifacts) != 1 or any(f"!lab/.work/**/{name}/**" not in artifacts[0].get("with", {}).get("path", "") for name in private_directories):
        errors.append("native companion artifacts must exclude every private fixture certificate directory")


def check_contracts(root: Path = ROOT) -> list[str]:
    errors: list[str] = []
    try:
        ci, deploy, release = [workflow(root, filename) for filename in ("ci.yml", "deploy.yml", "release.yml")]
        check_aggregator(ci, errors)
        check_caches(root, ci, deploy, release, errors)
        check_native_manifest(root, errors)
        check_ipc(root, errors)
        check_companion_suites(root, ci, errors)
    except (OSError, ValueError, KeyError, TypeError, yaml.YAMLError) as error:
        errors.append(f"could not verify repository contracts: {error}")
    return errors


if __name__ == "__main__":
    failures = check_contracts()
    for failure in failures:
        print(f"error: {failure}", file=sys.stderr)
    if failures:
        sys.exit(1)
    print("CI/cache/native-manifest and window IPC contracts verified.")
