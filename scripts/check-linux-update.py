#!/usr/bin/env python3
"""Apply a public signed N-1 AppImage update through the real native UI.

Requires Node, python3-gi/gir1.2-atspi-2.0, at-spi2-core, dbus-x11,
gnome-keyring, Xvfb, and a built src-tauri/target/debug/examples/update_fixture.
The AppImages supply their own production WebKit runtime. No endpoint, public
key, updater implementation, or release bytes are patched for this check.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import select
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
TABLES = ("friends", "sessions", "audit_events", "session_timelines")
TOPIC = "11" * 32
NATIVE_ENV_DROP = {
    "GNOME_KEYRING_CONTROL", "SSH_AUTH_SOCK", "AT_SPI_BUS_ADDRESS", "NO_AT_BRIDGE",
    "LD_LIBRARY_PATH", "APPIMAGE", "APPDIR", "DBUS_SESSION_BUS_ADDRESS",
    "GH_TOKEN", "GITHUB_TOKEN", "RELEASE_PAT", "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
}


def native_environment():
    return {key: value for key, value in os.environ.items() if key not in NATIVE_ENV_DROP}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def version(tag):
    match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", tag)
    require(match is not None, f"not a full release tag: {tag}")
    return tuple(int(part) for part in match.groups())


def previous_release(releases, target):
    candidates = [r for r in releases if not r["draft"] and not r["prerelease"]
                  and r.get("immutable") is True
                  and re.fullmatch(r"v\d+\.\d+\.\d+", r["tag_name"])
                  and version(r["tag_name"]) < version(target["tag_name"])]
    require(candidates, "no immutable previous full release is available")
    return max(candidates, key=lambda release: version(release["tag_name"]))


class NoMetadataRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("authenticated metadata must not redirect to another URL")


def request(url, limit=None, metadata=False):
    headers = {"User-Agent": "StudyVis-native-update-qualification", "Accept": "application/vnd.github+json"}
    token = (os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")) if metadata else None
    opener = urllib.request.build_opener()
    if token:
        require(url.startswith("https://api.github.com/repos/"), "metadata token cannot leave the GitHub repository API")
        headers["Authorization"] = "Bearer " + token
        opener = urllib.request.build_opener(NoMetadataRedirect())
    for attempt in range(3):
        try:
            with opener.open(urllib.request.Request(url, headers=headers), timeout=90) as response:
                body = response.read() if limit is None else response.read(limit + 1)
            break
        except urllib.error.HTTPError as error:
            if error.code == 403 and error.headers.get("X-RateLimit-Remaining") == "0":
                raise RuntimeError("GitHub metadata rate limit exhausted; supply a read-only GH_TOKEN for metadata (never artifact downloads)") from error
            if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
        except urllib.error.URLError:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
    require(limit is None or len(body) <= limit, f"oversized response from {url}")
    return body


def api(repository, path):
    return json.loads(request(f"https://api.github.com/repos/{repository}/{path}", 8 * 1024 * 1024, metadata=True))


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_asset(repository, release, asset, directory, asset_cache=None):
    name = asset["name"]
    require(re.fullmatch(r"[A-Za-z0-9_.+-]+", name) is not None, "unsafe asset filename")
    expected_url = f"https://github.com/{repository}/releases/download/{release['tag_name']}/{name}"
    require(asset["browser_download_url"] == expected_url, "asset URL is outside the exact release")
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", asset.get("digest", "")) is not None, "asset lacks GitHub's SHA-256 digest")
    destination = directory / name
    cached = asset_cache / name if asset_cache is not None else None
    if cached is not None and cached.is_file():
        shutil.copyfile(cached, destination)
    else:
        req = urllib.request.Request(expected_url, headers={"User-Agent": "StudyVis-native-update-qualification"})
        with urllib.request.urlopen(req, timeout=90) as response, destination.open("xb") as output:
            shutil.copyfileobj(response, output, 1024 * 1024)
    require(destination.stat().st_size == asset["size"], "downloaded asset size mismatch")
    require("sha256:" + sha256(destination) == asset["digest"], "downloaded asset digest mismatch")
    return destination


def verify_signed_file(image, signature, public_key):
    javascript = """
import {pathToFileURL} from 'node:url';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const {filename, signature, publicKey, verifier} = JSON.parse(input);
const {verifySignedFile} = await import(pathToFileURL(verifier));
console.log(JSON.stringify(await verifySignedFile(filename, signature, publicKey)));
"""
    # Pass the module name through JSON stdin, not argv[1]: the shared module
    # uses argv[1] to distinguish CLI execution from imports.
    proof = subprocess.run(["node", "--input-type=module", "-e", javascript],
                           input=json.dumps({"filename": str(image), "signature": signature, "publicKey": public_key,
                                             "verifier": str(ROOT / "scripts/check-public-updater.mjs")}),
                           env=native_environment(), text=True, capture_output=True, check=True, timeout=120)
    return json.loads(proof.stdout)


def release_inputs(repository, release, directory, asset_cache=None):
    require(release.get("immutable") is True and not release["draft"] and not release["prerelease"], "qualification requires an immutable published full release")
    tag = release["tag_name"]
    version(tag)
    commit = api(repository, "commits/" + urllib.parse.quote(tag, safe=""))["sha"]
    require(re.fullmatch(r"[a-f0-9]{40}", commit) is not None, "release commit is invalid")
    source = directory / "source"
    source.mkdir(parents=True)

    def source_file(path):
        body = request(f"https://raw.githubusercontent.com/{repository}/{commit}/{path}", 4 * 1024 * 1024)
        destination = source / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(body)
        return body

    config = json.loads(source_file("src-tauri/tauri.conf.json"))
    require(config["version"] == tag[1:], "tag/config version mismatch")
    require(config["plugins"]["updater"]["endpoints"] == [f"https://github.com/{repository}/releases/latest/download/latest.json"], "previous artifact does not use the public stable update endpoint")
    source_file("src-tauri/Cargo.lock")
    source_file("src-tauri/src/db/migrations.rs")
    manifest = source_file("src-tauri/src/db/migrations/MANIFEST.sha256").decode()
    migrations = []
    for line in manifest.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(r"([a-f0-9]{64})\s+(\d{3}_[a-z0-9_]+\.sql)", line)
        require(match is not None, "invalid historical migration manifest")
        expected, name = match.groups()
        sql = source_file("src-tauri/src/db/migrations/" + name).decode().replace("\r\n", "\n")
        require(hashlib.sha256(sql.encode()).hexdigest() == expected, "historical migration checksum mismatch")
        migrations.append((int(name[:3]), sql))
    require([n for n, _ in migrations] == list(range(1, len(migrations) + 1)), "historical migrations have gaps")
    images = [asset for asset in release["assets"] if asset["name"].endswith("_amd64.AppImage")]
    require(len(images) == 1, "release must contain exactly one x86_64 AppImage")
    signatures = [asset for asset in release["assets"] if asset["name"] == images[0]["name"] + ".sig"]
    require(len(signatures) == 1, "release is missing its unique AppImage signature")
    image = download_asset(repository, release, images[0], directory, asset_cache)
    signature = download_asset(repository, release, signatures[0], directory, asset_cache)
    proof = verify_signed_file(image, signature.read_text().strip(), config["plugins"]["updater"]["pubkey"])
    require(api(repository, "commits/" + urllib.parse.quote(tag, safe=""))["sha"] == commit, "release tag moved during validation")
    image.chmod(0o755)
    return {"tag": tag, "commit": commit, "image": image, "sha256": sha256(image),
            "signatureProof": proof, "migrations": migrations,
            "sourceHashes": {str(path.relative_to(source)): sha256(path) for path in source.rglob("*") if path.is_file()},
            "pubkey": config["plugins"]["updater"]["pubkey"]}


def snapshot(path):
    with sqlite3.connect(path) as connection:
        require(connection.execute("PRAGMA integrity_check").fetchone() == ("ok",), "database integrity check failed")
        present = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        return {table: {"columns": [row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')],
                        "rows": connection.execute(f'SELECT * FROM "{table}" ORDER BY 1').fetchall()}
                for table in TABLES if table in present}


def assert_preserved(before, after):
    for table, original in before.items():
        require(table in after, f"update removed {table}")
        current = after[table]
        require(all(column in current["columns"] for column in original["columns"]), f"update removed {table} columns")
        indices = [current["columns"].index(column) for column in original["columns"]]
        projected = [tuple(row[i] for i in indices) for row in current["rows"]]
        require(projected == original["rows"], f"update changed persisted {table} rows")


def seed_database(path, migrations, fixture):
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE schema_version(version INTEGER PRIMARY KEY)")
        for number, sql in migrations:
            connection.executescript(sql)
            connection.execute("INSERT INTO schema_version VALUES(?)", (number,))
        own, friend = fixture["identity"], fixture["friend"]
        core = fixture["audit"]["core"]

        def insert(table, values):
            columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
            names = [key for key in values if key in columns]
            require(names, f"baseline release lacks required table {table}")
            quoted = ",".join('"' + name + '"' for name in names)
            placeholders = ",".join("?" for _ in names)
            connection.execute(f'INSERT INTO "{table}" ({quoted}) VALUES ({placeholders})', [values[name] for name in names])

        insert("friends", {"ed_pubkey_hex": friend["ed"], "x_pubkey_hex": friend["x"], "display_name": friend["name"], "paired_at": core["ts"], "last_studied_with": core["ts"]})
        insert("sessions", {"id": TOPIC, "started_at": core["ts"], "ended_at": core["ts"] + 180000, "peer_pubkeys": json.dumps([friend["ed"]]), "total_minutes": 3, "total_duration_ms": 180000, "declared_topic": core["detail"]["topic"], "score": 9, "focused_pct": 0.97, "generated_at": core["ts"] + 180100, "confident_samples": 2, "skipped_samples": 1, "ai_enabled": 1, "local_ed_pubkey": own["ed_pubkey_hex"], "local_display_name": own["display_name"], "peer_presence_ms": json.dumps({friend["ed"]: 120000})})
        insert("audit_events", {"session_id": TOPIC, "ts": core["ts"], "who": core["who"], "kind": core["kind"], "detail": json.dumps(core["detail"], separators=(",", ":")), "sig": fixture["audit"]["sig"]})
        if connection.execute("SELECT 1 FROM sqlite_master WHERE name='session_timelines'").fetchone():
            insert("session_timelines", {"session_id": TOPIC, "generated_at": core["ts"] + 180200, "model_id": None, "source": "observations", "entries": json.dumps([{"start_min": 0, "end_min": 3, "summary": "Synthetic update-preservation observation."}]), "truncated": 0})
    return snapshot(path)


def records(path):
    output = []
    if path.exists():
        for line in path.read_text(errors="replace").splitlines():
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    output.append(value)
            except ValueError:
                pass
    return output


def version_started(log, expected):
    rows = records(log)
    starts = {row["run"]: row["data"]["pid"] for row in rows
              if row.get("win") == "native" and row.get("msg") == "run.start"}
    native = [starts[row["run"]] for row in rows if row.get("win") == "native"
              and row.get("msg") == "run.version" and row.get("data", {}).get("ver") == expected
              and row["run"] in starts]
    renderer = any(row.get("win") == "main" and row.get("msg") == "run.start"
                   and row.get("data", {}).get("app") == expected for row in rows)
    return native[-1] if native and renderer else None


def assert_updater_healthy(log):
    failures = {"check.failed", "download.failed", "install.failed", "relaunch.failed"}
    for row in records(log):
        if row.get("scope") == "updater" and row.get("msg") in failures:
            raise RuntimeError(f"native updater {row['msg']}: {row.get('data', {}).get('err', 'no detail')}")


def terminate(process):
    if process is not None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        # The AppImage relaunch and D-Bus activation can outlive their parent.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def owned_processes(token):
    result = []
    marker = ("STUDYVIS_UPDATE_SMOKE_TOKEN=" + token).encode()
    for path in Path("/proc").glob("[0-9]*"):
        try:
            if marker in (path / "environ").read_bytes().split(b"\0"):
                state = (path / "stat").read_text().rsplit(")", 1)[1].split()[0]
                if state != "Z":
                    result.append(int(path.name))
        except (OSError, IndexError):
            continue
    return result


def owned_mounts(root, mountinfo=None):
    text = Path("/proc/self/mountinfo").read_text() if mountinfo is None else mountinfo
    result = []
    for line in text.splitlines():
        before, separator, after = line.partition(" - ")
        if not separator:
            continue
        fields = before.split()
        if len(fields) < 5:
            continue
        target = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), fields[4])
        if target.startswith(str(root) + "/"):
            result.append((target, after.split()[0]))
    return sorted(result, key=lambda pair: len(pair[0]), reverse=True)


def unmount_owned(root, environment):
    # A private org.a11y.Bus/GTK session can activate document-portal and its
    # FUSE mount. A dead portal leaves ENOTCONN on rmtree unless it is unmounted.
    for target, filesystem in owned_mounts(root):
        require(filesystem.startswith("fuse"), f"refusing an unexpected mount in the owned test directory: {filesystem}")
        tool = shutil.which("fusermount3") or shutil.which("fusermount")
        require(tool is not None, "fusermount is required to remove the owned portal mount")
        result = subprocess.run([tool, "-u", "-z", target], env=environment, text=True, capture_output=True, timeout=10)
        require(result.returncode == 0, f"could not unmount owned {filesystem}: {result.stderr.strip()}")
    require(not owned_mounts(root), "an owned mount remains after cleanup")


def wait_until(predicate, timeout, description):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.25)
    raise RuntimeError("timed out waiting for " + description)


def qualify(args, evidence):
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi

    target = api(args.repository, "releases/latest")
    if args.expected_tag:
        require(target["tag_name"] == args.expected_tag, "requested target is not the public latest full release")
    earlier = previous_release(api(args.repository, "releases?per_page=100"), target)
    outcome = {"pass": False, "scope": "real signed public N-1 extraction-mode update; isolated synthetic data/provider; no FUSE/physical-desktop claim",
               "metadataAuthentication": "read-token" if os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") else "none",
               "artifactAuthentication": "none", "applicationUpdateAuthentication": "none"}
    # Explicit removal after mount cleanup prevents rmtree from descending into
    # a live/disconnected portal mount if service teardown fails.
    with tempfile.TemporaryDirectory(prefix="svupdate-", dir="/tmp", delete=False) as temporary:
        state = Path(temporary)
        state.chmod(0o700)
        outcome["privateStateRoot"] = str(state)
        token = secrets.token_hex(24)
        (state / ".owned-update-smoke").write_text(token)
        environment = native_environment()
        environment.update({"STUDYVIS_UPDATE_SMOKE_ROOT": str(state), "STUDYVIS_UPDATE_SMOKE_TOKEN": token, "DBUS_SESSION_BUS_ADDRESS": f"unix:path={state}/bus", "GTK_A11Y": "always", "GDK_BACKEND": "x11", "WEBKIT_DISABLE_COMPOSITING_MODE": "1"})
        for key, name in (("XDG_DATA_HOME", "data"), ("XDG_CONFIG_HOME", "config"), ("XDG_CACHE_HOME", "cache"), ("XDG_RUNTIME_DIR", "runtime"), ("TMPDIR", "tmp")):
            (state / name).mkdir(mode=0o700)
            environment[key] = str(state / name)
        processes, handles = [], []

        def start(command, filename, **kwargs):
            handle = (state / filename).open("wb")
            handles.append(handle)
            process = subprocess.Popen(command, env=environment, stdout=handle, stderr=subprocess.STDOUT, start_new_session=True, **kwargs)
            processes.append(process)
            return process

        def fixture(mode):
            result = subprocess.run([str(args.fixture.resolve()), mode], env=environment, capture_output=True, text=True, check=True, timeout=30)
            return json.loads(result.stdout)

        try:
            old_directory, new_directory = state / "old", state / "new"
            old_directory.mkdir()
            new_directory.mkdir()
            old = release_inputs(args.repository, earlier, old_directory, args.asset_cache)
            new = release_inputs(args.repository, target, new_directory, args.asset_cache)
            require(old["pubkey"] == new["pubkey"], "old artifact cannot accept target signing key without a supported rotation path")
            print(f"Verified signed {old['tag']} ({old['commit']}) -> {new['tag']} ({new['commit']}); native children receive no GitHub tokens", flush=True)
            outcome["releases"] = [{key: value for key, value in entry.items() if key in ("tag", "commit", "sha256", "signatureProof", "sourceHashes")} for entry in (old, new)]
            read_fd, write_fd = os.pipe()
            start(["Xvfb", "-displayfd", str(write_fd), "-screen", "0", "1280x800x24", "-nolisten", "tcp"], "xvfb.log", pass_fds=(write_fd,))
            os.close(write_fd)
            with os.fdopen(read_fd) as pipe:
                require(select.select([pipe], [], [], 15)[0], "Xvfb did not allocate a display within 15 seconds")
                number = pipe.readline().strip()
            require(number.isdigit(), "Xvfb did not allocate a display")
            environment["DISPLAY"] = ":" + number
            bus = start(["dbus-daemon", "--session", "--nofork", "--address=" + environment["DBUS_SESSION_BUS_ADDRESS"]], "dbus.log")
            wait_until(lambda: (state / "bus").exists() and bus.poll() is None, 10, "private D-Bus")
            (state / "keyring-control").mkdir(mode=0o700)
            provider = start([args.secret_service, "--foreground", "--components=secrets", "--unlock", "--control-directory=" + str(state / "keyring-control")], "provider.log", stdin=subprocess.PIPE)
            provider.stdin.write(b"disposable-studyvis-update-test\n")
            provider.stdin.close()

            def provider_ready():
                require(provider.poll() is None, "private Secret Service exited")
                result = subprocess.run(["dbus-send", "--session", "--type=method_call", "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", "string:org.freedesktop.secrets"], env=environment, capture_output=True, timeout=2)
                return b"boolean true" in result.stdout

            wait_until(provider_ready, 15, "private Secret Service")
            seeded = fixture("seed")
            print("Private provider and native signing/encryption fixture ready", flush=True)
            database = state / "data/studyvis/app.db"
            baseline = seed_database(database, old["migrations"], seeded)
            identity = state / "data/studyvis/identity.json"
            journal = state / "data/studyvis/session-journals" / (TOPIC + ".ndjson")
            journal.parent.mkdir(parents=True)
            journal.write_text(json.dumps({"ts": 1700000000000, "v": "on_task", "r": "Synthetic update preservation", "c": 0.99, "t": "Algebra updater preservation"}) + "\n")
            before_hashes = {"identity": sha256(identity), "journal": sha256(journal)}
            settings = state / "data/com.studyvis.app/settings.json"
            settings.parent.mkdir(parents=True)
            settings.write_text(json.dumps({"auto_update_enabled": True, "debug_log_enabled": True, "ai_features_enabled": False, "minimize_to_tray_on_close": False, "window_style": "system", "theme": "light"}))
            onboarding = settings.parent / "app-state.json"
            onboarding.write_text(json.dumps({"onboarding_completed_at": 1700000000000}))
            image = state / "StudyVis-update-smoke.AppImage"
            shutil.copyfile(old["image"], image)
            image.chmod(0o755)
            log = state / "data/studyvis/logs/studyvis.log"
            # AT-SPI is initialized only after replacing all inherited bus and
            # display variables. The coordinator itself receives no ownership
            # token, so descendant cleanup cannot target this Python process.
            for key in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "GTK_A11Y", "GDK_BACKEND"):
                os.environ[key] = environment[key]
            for key in ("AT_SPI_BUS_ADDRESS", "NO_AT_BRIDGE"):
                os.environ.pop(key, None)
            Atspi.init()
            app = start([str(image), "--appimage-extract-and-run"], "app.log")
            def old_started():
                require(app.poll() is None, "N-1 exited before native/renderer startup")
                return version_started(log, old["tag"][1:])
            old_pid = wait_until(old_started, 60, "N-1 native and renderer startup")
            require(app.poll() is None, "N-1 wrapper exited before the update")
            print(f"N-1 native PID {old_pid} and renderer started; waiting for real signed update", flush=True)

            def find_named(wanted, action=False):
                def visit(node, depth=0):
                    try:
                        name = node.get_name() or ""
                        if not action and wanted in name:
                            return node
                        if not action:
                            text = node.get_text_iface()
                            if text is not None and wanted in text.get_text(0, -1):
                                return node
                        if name == wanted:
                            if not action:
                                return node
                            interface = node.get_action_iface()
                            if interface is not None and interface.get_n_actions() > 0:
                                return node
                        if depth < 24:
                            for index in range(node.get_child_count()):
                                found = visit(node.get_child_at_index(index), depth + 1)
                                if found is not None:
                                    return found
                    except Exception:
                        return None
                    return None
                return visit(Atspi.get_desktop(0))

            def ready_to_restart():
                require(app.poll() is None, "N-1 exited before the native updater restart action")
                assert_updater_healthy(log)
                return find_named("Restart now", action=True)
            restart = wait_until(ready_to_restart, 180, "the real updater's Restart now action")
            require(sha256(image) == old["sha256"], "original AppImage changed before the restart action")
            require(restart.get_action_iface().do_action(0), "native restart action was rejected")
            print("Real native Restart now action delivered", flush=True)
            def updated_started():
                assert_updater_healthy(log)
                return version_started(log, new["tag"][1:])
            new_pid = wait_until(updated_started, 90, "updated native and renderer startup")
            require(new_pid != old_pid, "updater did not relaunch a fresh native process")
            wait_until(lambda: old_pid not in owned_processes(token), 15, "the N-1 native process to exit")
            require(sha256(image) == new["sha256"], "updated original AppImage differs from the verified target release")
            wait_until(lambda: find_named(seeded["friend"]["name"]) is not None, 30, "preserved friend in the updated native UI")
            settings_button = find_named("Open settings", action=True)
            require(settings_button is not None and settings_button.get_action_iface().do_action(0), "updated UI could not open Settings")
            wait_until(lambda: find_named("Close settings", action=True), 10, "responsive post-update Settings")
            after_keys = fixture("verify")
            require(after_keys["signingKeyPreserved"] and after_keys["encryptionKeyPreserved"], "native credentials changed across update")
            assert_preserved(baseline, snapshot(database))
            with sqlite3.connect(database) as connection:
                schema_version = connection.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
            require(schema_version == len(new["migrations"]), "updated app did not apply its complete production migration chain")
            require(before_hashes == {"identity": sha256(identity), "journal": sha256(journal)}, "identity or journal bytes changed")
            current_settings = json.loads(settings.read_text())
            for key, expected in (("auto_update_enabled", True), ("ai_features_enabled", False), ("theme", "light")):
                require(current_settings.get(key) == expected, f"update lost setting {key}")
            require(json.loads(onboarding.read_text())["onboarding_completed_at"] == 1700000000000, "update lost onboarding state")
            require(api(args.repository, "releases/latest")["id"] == target["id"], "stable channel moved during qualification")
            time.sleep(3)
            require(new_pid in owned_processes(token), "updated app exited immediately after successful startup")
            outcome.update({"nativeAssertionsPassed": True, "oldNativePid": old_pid, "newNativePid": new_pid, "schemaVersion": schema_version, "originalPathReplaced": True, "databaseRowsPreserved": True, "identityAndJournalPreserved": True, "nativeSigningAndEncryptionPreserved": True, "responsiveUpdatedUI": True})
        except Exception as error:
            outcome["error"] = str(error)
            raise
        finally:
            cleanup_errors = []
            for process in reversed(processes):
                try:
                    terminate(process)
                except (OSError, subprocess.TimeoutExpired) as error:
                    cleanup_errors.append(str(error))
            for pid in owned_processes(token):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            try:
                wait_until(lambda: not owned_processes(token), 10, "all owned descendants to terminate")
            except RuntimeError as error:
                cleanup_errors.append(str(error))
            for handle in handles:
                handle.close()
            try:
                unmount_owned(state, environment)
            except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
                cleanup_errors.append(str(error))
            outcome["ownedDescendantsRemaining"] = owned_processes(token)
            outcome["ownedMountsRemaining"] = owned_mounts(state)
            outcome["cleanupErrors"] = cleanup_errors
            if cleanup_errors:
                outcome["pass"] = False
            for path in state.glob("*.log"):
                shutil.copyfile(path, evidence / path.name)
            runtime_log = state / "data/studyvis/logs/studyvis.log"
            if runtime_log.exists():
                shutil.copyfile(runtime_log, evidence / "studyvis.log")
            if not cleanup_errors:
                try:
                    shutil.rmtree(state)
                except OSError as error:
                    cleanup_errors.append(str(error))
            outcome["privateStateRemoved"] = not state.exists()
            (evidence / "result.json").write_text(json.dumps(outcome, indent=2) + "\n")
            require(not cleanup_errors, "update qualification left owned processes or cleanup errors")
    outcome["privateStateRemoved"] = not state.exists()
    require(outcome["privateStateRemoved"], "private state remains after qualification")
    outcome["pass"] = True
    (evidence / "result.json").write_text(json.dumps(outcome, indent=2) + "\n")
    print(json.dumps(outcome, indent=2))


def self_test():
    from unittest.mock import patch

    captured = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, *_args):
            return b"{}"

    class Opener:
        def open(self, req, **_kwargs):
            captured.append(req)
            return Response()

    with patch.dict(os.environ, {"GH_TOKEN": "synthetic-read-token", "GITHUB_TOKEN": "synthetic-token", "RELEASE_PAT": "synthetic-pat"}):
        with patch("urllib.request.build_opener", return_value=Opener()):
            request("https://api.github.com/repos/scotej/studyvis/releases/latest", metadata=True)
            request("https://raw.githubusercontent.com/scotej/studyvis/commit/file")
        require(captured[0].get_header("Authorization") == "Bearer synthetic-read-token", "metadata auth fixture failed")
        require(captured[1].get_header("Authorization") is None, "metadata token leaked to raw-source request")
        require(not ({"GH_TOKEN", "GITHUB_TOKEN", "RELEASE_PAT"} & native_environment().keys()), "metadata token leaked to native child environment")
        try:
            request("https://raw.githubusercontent.com/scotej/studyvis/commit/file", metadata=True)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("metadata auth escaped the GitHub API origin")
    target = {"tag_name": "v2.0.0"}
    releases = [
        {"tag_name": "v1.12.8", "draft": False, "prerelease": False, "immutable": True},
        {"tag_name": "v1.12.8.1", "draft": False, "prerelease": False, "immutable": True},
        {"tag_name": "v2.1.0-rc.1", "draft": False, "prerelease": True, "immutable": True},
        {"tag_name": "v1.13.0", "draft": True, "prerelease": False, "immutable": True},
        {"tag_name": "v1.99.0", "draft": False, "prerelease": False, "immutable": False},
    ]
    require(previous_release(releases, target)["tag_name"] == "v1.12.8", "release selection fixture failed")
    mounts = "1 2 0:1 / /tmp/owned/runtime/doc rw - fuse.portal portal rw\n2 3 0:2 / /tmp/owned-elsewhere/runtime/doc rw - fuse.portal portal rw\n"
    require(owned_mounts(Path("/tmp/owned"), mounts) == [("/tmp/owned/runtime/doc", "fuse.portal")], "mount cleanup escaped its owned root")
    before = {"friends": {"columns": ["id", "name"], "rows": [("a", "Sam")]}}
    assert_preserved(before, {"friends": {"columns": ["id", "new", "name"], "rows": [("a", None, "Sam")]}})
    for bad in ({}, {"friends": {"columns": ["id", "name"], "rows": [("a", "Lost")]}}):
        try:
            assert_preserved(before, bad)
        except RuntimeError:
            continue
        raise RuntimeError("preservation negative control passed unexpectedly")
    with tempfile.TemporaryDirectory(prefix="svupdate-fixture-") as temporary:
        path = Path(temporary) / "app.db"
        fixture = {
            "identity": {"ed_pubkey_hex": "aa" * 32, "display_name": "Synthetic owner"},
            "friend": {"ed": "bb" * 32, "x": "cc" * 32, "name": "Synthetic friend"},
            "audit": {"core": {"ts": 1700000000000, "who": "aa" * 32, "kind": "topic_set", "detail": {"topic": "Algebra"}}, "sig": "dd" * 64},
        }
        migrations = [(int(p.name[:3]), p.read_text()) for p in sorted((ROOT / "src-tauri/src/db/migrations").glob("*.sql"))]
        before = seed_database(path, migrations, fixture)
        require(set(before) == set(TABLES), "seed fixture omitted a persisted table")
        with sqlite3.connect(path) as connection:
            connection.execute("ALTER TABLE friends ADD COLUMN future_field TEXT")
        assert_preserved(before, snapshot(path))
        with sqlite3.connect(path) as connection:
            connection.execute("UPDATE friends SET display_name='data loss'")
        try:
            assert_preserved(before, snapshot(path))
        except RuntimeError:
            pass
        else:
            raise RuntimeError("disk database mutation negative control was not rejected")
        log = Path(temporary) / "startup.log"
        log.write_text("\n".join(json.dumps(row) for row in [
            {"run": "old", "win": "native", "msg": "run.start", "data": {"pid": 123}},
            {"run": "old", "win": "native", "msg": "run.version", "data": {"ver": "1.12.8"}},
            {"run": "main", "win": "main", "msg": "run.start", "data": {"app": "1.12.8"}},
        ]))
        require(version_started(log, "1.12.8") == 123, "native startup fixture failed")
        require(version_started(log, "2.0.0") is None, "stale startup passed as new version")
        with log.open("a") as handle:
            handle.write('\n' + json.dumps({"scope": "updater", "msg": "download.failed", "data": {"err": "403 Forbidden"}}))
        try:
            assert_updater_healthy(log)
        except RuntimeError as error:
            require("403 Forbidden" in str(error), "native updater error detail was lost")
        else:
            raise RuntimeError("terminal native updater error was ignored")
        try:
            verify_signed_file(log, "invalid-signature", json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["plugins"]["updater"]["pubkey"])
        except subprocess.CalledProcessError as error:
            require("invalid updater signature base64" in error.stderr, "shared signature verifier did not reject the fixture as expected")
        else:
            raise RuntimeError("invalid signature fixture was accepted")
    print("Linux update fixtures passed (immutable N-1 selection, real SQLite seed/preservation, mutation control and native version correlation)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default="scotej/studyvis")
    parser.add_argument("--expected-tag")
    parser.add_argument("--asset-cache", type=Path, help="optional existing release files; public metadata hashes and signatures are still checked")
    parser.add_argument("--secret-service", default="gnome-keyring-daemon", help="Secret Service test executable, normally supplied by the host package")
    parser.add_argument("--fixture", type=Path, default=ROOT / "src-tauri/target/debug/examples/update_fixture")
    parser.add_argument("--evidence", type=Path, default=ROOT / "linux-update-evidence")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    require(sys.platform == "linux", "native update qualification requires Linux")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository) is not None, "invalid repository")
    require(args.fixture.is_file(), "build cargo example update_fixture before qualification")
    args.evidence.mkdir(parents=True, exist_ok=True)
    qualify(args, args.evidence.resolve())


if __name__ == "__main__":
    main()
