#!/usr/bin/env bash
set -euo pipefail

# Native launches use the disposable hosted account's real data directory:
# dirs/Tauri does not promise that changing HOME redirects macOS known folders.
exec python3 -I - "$@" <<'PY'
import argparse
import ctypes
import datetime
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time


def startup_ready(contents, pid, version, started_ms):
    records = []
    for line in contents.splitlines():
        try:
            record = json.loads(line)
            stamp = datetime.datetime.fromisoformat(record["ts"].replace("Z", "+00:00"))
            if stamp.timestamp() * 1000 >= started_ms and record.get("run"):
                records.append(record)
        except (ValueError, KeyError, TypeError, AttributeError):
            continue
    for record in records:
        if record.get("win") == "main" and record.get("msg") in ("window.error", "unhandled.rejection"):
            raise RuntimeError("packaged main renderer reported " + record["msg"])
    native_runs = {
        r["run"] for r in records
        if r.get("win") == "native" and r.get("msg") == "run.start"
        and r.get("data", {}).get("pid") == pid
    }
    native_version = any(
        r.get("win") == "native" and r.get("msg") == "run.version"
        and r["run"] in native_runs and r.get("data", {}).get("ver") == version
        for r in records
    )
    renderer = any(
        r.get("win") == "main" and r.get("msg") == "run.start"
        and r.get("data", {}).get("app") == version for r in records
    )
    return native_version and renderer


def engine_ready(option, output):
    if option == "--version":
        return re.search(r"version:\s+\d+", output) is not None
    if option == "--list-devices":
        # b9095 intentionally excludes CPU devices from this list. The macOS
        # backend registration also emits no Windows/Linux-style dynamic
        # loader message such as "loaded CPU backend".
        return "Available devices:" in output
    raise ValueError("unsupported engine smoke option: " + option)


def visible_app_window(pid):
    # Read WindowServer metadata only; no screen pixels or Accessibility/TCC
    # grants are needed to correlate an on-screen application window by PID.
    core = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    graphics = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
    graphics.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    graphics.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
    core.CFPropertyListCreateData.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long, ctypes.c_ulong, ctypes.c_void_p]
    core.CFPropertyListCreateData.restype = ctypes.c_void_p
    core.CFDataGetLength.argtypes = [ctypes.c_void_p]
    core.CFDataGetLength.restype = ctypes.c_long
    core.CFDataGetBytePtr.argtypes = [ctypes.c_void_p]
    core.CFDataGetBytePtr.restype = ctypes.c_void_p
    core.CFRelease.argtypes = [ctypes.c_void_p]
    core.CFRelease.restype = None
    windows = graphics.CGWindowListCopyWindowInfo(1, 0)
    assert windows, "no GUI WindowServer session is available"
    data = None
    try:
        data = core.CFPropertyListCreateData(None, windows, 100, 0, None)
        assert data, "could not serialize WindowServer metadata"
        rows = plistlib.loads(ctypes.string_at(core.CFDataGetBytePtr(data), core.CFDataGetLength(data)))
        return any(row.get("kCGWindowOwnerPID") == pid and row.get("kCGWindowLayer") == 0
                   and row.get("kCGWindowBounds", {}).get("Width", 0) > 100
                   and row.get("kCGWindowBounds", {}).get("Height", 0) > 100 for row in rows)
    finally:
        if data:
            core.CFRelease(data)
        core.CFRelease(windows)


def macho_contract(data, floor):
    assert len(data) >= 32 and struct.unpack_from("<I", data)[0] == 0xfeedfacf, "expected a 64-bit Mach-O"
    commands, command_bytes = struct.unpack_from("<II", data, 16)
    command_end = 32 + command_bytes
    assert command_end <= len(data), "truncated Mach-O load commands"
    offset, minimum, symbols = 32, None, None
    for _ in range(commands):
        assert offset + 8 <= command_end, "truncated Mach-O command"
        command, size = struct.unpack_from("<II", data, offset)
        assert size >= 8 and offset + size <= command_end, "invalid Mach-O command size"
        if command == 0x32:
            assert size >= 24 and struct.unpack_from("<I", data, offset + 8)[0] == 1, "expected macOS build metadata"
            minimum = struct.unpack_from("<I", data, offset + 12)[0]
        elif command == 0x24:
            assert size >= 16, "truncated macOS version metadata"
            minimum = struct.unpack_from("<I", data, offset + 8)[0]
        elif command == 0x2:
            assert size >= 24, "truncated Mach-O symbol metadata"
            symbols = struct.unpack_from("<IIII", data, offset + 8)
        offset += size
    assert offset == command_end and minimum is not None and symbols is not None, "missing Mach-O version/symbol metadata"
    version = (minimum >> 16, (minimum >> 8) & 255, minimum & 255)
    assert version <= floor, f"Mach-O minimum {version} exceeds supported floor {floor}"
    symbol_offset, count, string_offset, string_size = symbols
    assert symbol_offset + count * 16 <= len(data) and string_offset + string_size <= len(data), "truncated Mach-O symbol table"
    strings = data[string_offset:string_offset + string_size]
    strong = []
    for index in range(count):
        name_offset, kind, _, description, _ = struct.unpack_from("<IBBHQ", data, symbol_offset + index * 16)
        if kind & 0xe or not kind & 1 or description & 0x40:
            continue
        assert name_offset < len(strings), "invalid Mach-O symbol name"
        end = strings.find(b"\0", name_offset)
        assert end >= 0, "unterminated Mach-O symbol name"
        name = strings[name_offset:end].decode("utf-8")
        strong.append(name)
        # Apple's Accelerate NEWLAPACK/ILP64 entry points require macOS 13.3.
        # A strong import is a loader dependency even when inference selects CPU.
        if "$NEWLAPACK" in name or "$ILP64" in name:
            assert floor >= (13, 3, 0), f"mandatory Accelerate import exceeds supported floor: {name}"
    return version, strong


def macho_fixture(minimum, symbol, weak=False):
    strings = b"\0" + symbol.encode() + b"\0"
    header = struct.pack("<8I", 0xfeedfacf, 0x100000c, 0, 2, 2, 48, 0, 0)
    commands = struct.pack("<6I", 0x32, 24, 1, minimum, 0, 0) + struct.pack("<6I", 0x2, 24, 80, 1, 96, len(strings))
    return header + commands + struct.pack("<IBBHQ", 1, 1, 0, 0x40 if weak else 0x200, 0) + strings


def self_test():
    symbol = "_cblas_sgemm$NEWLAPACK$ILP64"
    assert macho_contract(macho_fixture(14 << 16, symbol), (14, 0, 0))[1] == [symbol]
    assert macho_contract(macho_fixture(11 << 16, symbol, weak=True), (11, 0, 0))[1] == []
    for data, floor in [(macho_fixture(15 << 16, symbol), (14, 0, 0)),
                        (macho_fixture(14 << 16, "_malloc"), (11, 0, 0)),
                        (macho_fixture(11 << 16, symbol), (11, 0, 0))]:
        try:
            macho_contract(data, floor)
        except AssertionError:
            pass
        else:
            raise RuntimeError("macOS deployment/import floor violation passed")
    assert engine_ready("--version", "version: 9095 (f3c3e0e9a)\nbuilt with AppleClang for Darwin arm64")
    assert not engine_ready("--version", "built with AppleClang for Darwin arm64")
    mac_devices = "Available devices:\n  MTL0: Apple Paravirtual device (4778 MiB, 4778 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)"
    assert engine_ready("--list-devices", mac_devices)
    assert not engine_ready("--list-devices", "ggml_backend_load: loaded CPU backend")
    base = {"ts": "2026-01-01T00:00:01.000Z", "run": "native-run"}
    records = [
        {**base, "win": "native", "msg": "run.start", "data": {"pid": 123}},
        {**base, "win": "native", "msg": "run.version", "data": {"ver": "2.0.0"}},
        {**base, "run": "renderer-run", "win": "main", "msg": "run.start", "data": {"app": "2.0.0"}},
    ]
    serialize = lambda rows: "\n".join(json.dumps(r) for r in rows)
    assert startup_ready(serialize(records) + '\n{"partial":', 123, "2.0.0", 1767225600000)
    assert not startup_ready(serialize(records), 124, "2.0.0", 1767225600000)
    assert not startup_ready(serialize(records), 123, "2.0.1", 1767225600000)
    assert not startup_ready(serialize(records), 123, "2.0.0", 1767225602000)
    assert not startup_ready(serialize(records[1:]), 123, "2.0.0", 1767225600000)
    assert not startup_ready(serialize(records[:-1]), 123, "2.0.0", 1767225600000)
    records[1]["run"] = "a-different-native-process"
    assert not startup_ready(serialize(records), 123, "2.0.0", 1767225600000)
    records.append({**base, "win": "main", "msg": "unhandled.rejection", "data": {}})
    try:
        startup_ready(serialize(records), 123, "2.0.0", 1767225600000)
    except RuntimeError:
        pass
    else:
        raise RuntimeError("unhandled renderer rejection passed the startup fixture")
    print("macOS startup evidence fixtures passed (engine enumeration, freshness, PID, versions, producer, partial log)")


def run(args, **kwargs):
    result = subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=60, **kwargs)
    return result.stdout + result.stderr


def inside(path, root):
    return path.resolve().is_relative_to(root.resolve())


def verify_bundle(app, expected):
    with (app / "Contents/Info.plist").open("rb") as handle:
        info = plistlib.load(handle)
    assert info.get("LSMinimumSystemVersion") == "11.0", "app plist must declare macOS 11.0"
    assert info["CFBundleIdentifier"] == "com.studyvis.app", "wrong bundle identifier"
    assert info["CFBundleShortVersionString"] == expected, "wrong packaged app version"
    for key in ("NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSScreenCaptureUsageDescription"):
        assert isinstance(info.get(key), str) and info[key].strip(), f"missing {key}"
    schemes = [scheme for entry in info.get("CFBundleURLTypes", []) for scheme in entry.get("CFBundleURLSchemes", [])]
    assert "studyvis" in schemes, "packaged app does not register studyvis://"
    executable = app / "Contents/MacOS" / info["CFBundleExecutable"]
    assert executable.is_file() and os.access(executable, os.X_OK), "missing main executable"
    runtime = app / "Contents/Resources/binaries/llama-runtime-aarch64-apple-darwin"
    engine = app / "Contents/MacOS/llama-server"
    assert runtime.is_dir() and engine.is_file(), "missing packaged llama runtime"
    run(["codesign", "--verify", "--deep", "--strict", str(app)])
    signature = run(["codesign", "--display", "--verbose=4", str(app)])
    assert "Signature=adhoc" in signature, "expected the configured ad-hoc app signature"
    machos = []
    for path in app.rglob("*"):
        if not path.is_file():
            continue
        assert inside(path, app), f"bundle symlink escapes the app: {path}"
        if "Mach-O" not in run(["file", "--brief", str(path)]):
            continue
        assert run(["lipo", "-archs", str(path)]).strip() == "arm64", f"unexpected Mach-O architecture: {path}"
        machos.append(path)
    assert executable in machos and engine in machos, "main app and sidecar must both be arm64 Mach-O"
    for binary in machos:
        ai_binary = inside(binary, runtime) or binary == engine
        minimum, strong_imports = macho_contract(binary.read_bytes(), (14, 0, 0) if ai_binary else (11, 0, 0))
        print(f"Mach-O floor/import check: {binary.relative_to(app)} minimum={minimum} strong_imports={len(strong_imports)} Accelerate={[name for name in strong_imports if '$NEWLAPACK' in name or '$ILP64' in name]}")
        loader = binary.parent
        executable_dir = engine.parent if inside(binary, runtime) or binary == engine else executable.parent
        rpaths = re.findall(r"cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (.*?) \(offset", run(["otool", "-l", str(binary)]))
        expanded = []
        for rpath in rpaths:
            value = rpath.replace("@loader_path", str(loader)).replace("@executable_path", str(executable_dir))
            assert "@" not in value and inside(Path(value), app), f"unsafe/nonpackaged rpath in {binary}: {rpath}"
            expanded.append(Path(value))
        dependencies = re.findall(r"^\s+(.*?) \(compatibility version", run(["otool", "-L", str(binary)]), re.MULTILINE)
        for dependency in dependencies:
            if dependency.startswith(("/usr/lib/", "/System/Library/")):
                continue
            candidates = []
            if dependency.startswith("@rpath/"):
                suffix = dependency[len("@rpath/"):]
                candidates = [directory / suffix for directory in expanded]
                # The app deliberately gives its sidecar this fallback path.
                if inside(binary, runtime) or binary == engine:
                    candidates.append(runtime / suffix)
            elif dependency.startswith(("@loader_path/", "@executable_path/")):
                candidates = [Path(dependency.replace("@loader_path", str(loader)).replace("@executable_path", str(executable_dir)))]
            assert any(p.is_file() and inside(p, app) for p in candidates), f"unresolved/nonpackaged dylib in {binary}: {dependency}"
    print(f"Verified {len(machos)} arm64 Mach-O files, packaged dylib paths, signature, version, privacy and URL-scheme plist")
    return executable, engine, runtime


def main():
    if sys.flags.optimize:
        raise RuntimeError("Python optimization must not disable artifact assertions")
    parser = argparse.ArgumentParser(description="Check and launch the exact packaged macOS app on a fresh hosted runner")
    parser.add_argument("artifact_root", nargs="?")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.artifact_root:
        parser.error("artifact_root is required")
    assert platform.system() == "Darwin" and platform.machine() == "arm64", "requires native Apple Silicon macOS"
    assert os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "refusing to launch outside a disposable GitHub-hosted account"
    expected = json.loads(Path("package.json").read_text())["version"]
    artifact = Path(args.artifact_root).resolve(strict=True)
    apps = [artifact] if artifact.suffix == ".app" else list(artifact.rglob("*.app"))
    assert len(apps) == 1, f"expected exactly one packaged app, found {len(apps)}"
    app = apps[0]
    executable, engine, runtime = verify_bundle(app, expected)
    support = Path.home() / "Library/Application Support"
    data_roots = [support / "studyvis", support / "com.studyvis.app"]
    for path in data_roots:
        assert not path.exists(), f"refusing existing app data: {path}"
    assert subprocess.run(["pgrep", "-x", executable.name], stdout=subprocess.DEVNULL, check=False).returncode == 1, "refusing an existing StudyVis process"
    environment = {k: v for k, v in os.environ.items() if not k.startswith(("DYLD_", "LD_"))}
    environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
    engine_environment = {**environment, "DYLD_FALLBACK_LIBRARY_PATH": str(runtime)}
    for option in ("--version", "--list-devices"):
        output = run([str(engine), option], cwd=runtime, env=engine_environment)
        print(output)
        assert engine_ready(option, output), f"packaged llama did not report {option} output"
    process = None
    with tempfile.TemporaryDirectory(prefix="studyvis-macos-startup-") as temporary:
        log = data_roots[0] / "logs/studyvis.log"
        capture = Path(temporary) / "startup.log"
        try:
            data_roots[1].mkdir(parents=True)
            (data_roots[1] / "settings.json").write_text(json.dumps({"auto_update_enabled": False, "minimize_to_tray_on_close": False}))
            started_ms = time.time_ns() // 1_000_000
            with capture.open("w") as handle:
                process = subprocess.Popen([str(executable)], cwd=app.parent, env=environment, stdout=handle, stderr=subprocess.STDOUT)
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    assert process.poll() is None, f"app exited before startup: {process.returncode}"
                    if log.exists() and startup_ready(log.read_text(errors="replace"), process.pid, expected, started_ms) and visible_app_window(process.pid):
                        break
                    time.sleep(0.5)
                else:
                    raise AssertionError("no visible main window with fresh native PID/version and renderer startup within 60 seconds")
                time.sleep(3)
                assert process.poll() is None, "app crashed immediately after startup"
                assert startup_ready(log.read_text(errors="replace"), process.pid, expected, started_ms), "startup evidence disappeared"
                assert visible_app_window(process.pid), "main window disappeared immediately after startup"
                print(f"Packaged macOS app showed a main window and stayed alive with fresh native PID {process.pid} and renderer version {expected}")
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            print(capture.read_text(errors="replace") if capture.exists() else "")
            if log.exists():
                print(log.read_text(errors="replace"))
            for path in data_roots:
                if path.exists():
                    shutil.rmtree(path)


main()
PY
