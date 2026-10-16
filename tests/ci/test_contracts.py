"""Mutation fixtures prove the policy catches changes that syntax lint accepts."""

import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
import re

import yaml


REPO = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("ci_contracts", REPO / "scripts/check-ci-contracts.py")
CONTRACTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTRACTS)


class Contracts(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for path in (
            ".github/workflows/ci.yml", ".github/workflows/deploy.yml",
            ".github/workflows/release.yml", "src-tauri/Cargo.toml",
            "src-tauri/build.rs", "src-tauri/src/lib.rs",
            "src-tauri/permissions/window-commands.toml",
            "scripts/linux-webkit-runtime.env", "scripts/linux-appimage-runtime.env",
            "scripts/linux-appimage-runtime-sources.tsv",
            "scripts/native-component-policy.json", "src-tauri/tauri.conf.json",
        ):
            destination = self.root / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / path, destination)
        for directory in ("scripts/patches", "src-tauri/capabilities"):
            shutil.copytree(REPO / directory, self.root / directory)

    def modify_workflow(self, name, change):
        path = self.root / ".github/workflows" / name
        document = yaml.safe_load(path.read_text())
        change(document)
        path.write_text(yaml.safe_dump(document))

    def assert_failure(self, message):
        failures = CONTRACTS.check_contracts(self.root)
        self.assertTrue(any(message in failure for failure in failures), failures)

    def test_repository_contracts(self):
        self.assertEqual(CONTRACTS.check_contracts(self.root), [])

    def test_new_job_cannot_bypass_aggregate(self):
        self.modify_workflow("ci.yml", lambda doc: doc["jobs"].update({"new-test": {"runs-on": "ubuntu-latest"}}))
        self.assert_failure("missing=['new-test']")

    def test_skipped_jobs_cannot_satisfy_aggregate(self):
        path = self.root / ".github/workflows/ci.yml"
        path.write_text(path.read_text().replace('.value.result != "success"', '.value.result == "failure"'))
        self.assert_failure("including skipped")

    def test_preview_key_cannot_drift_from_ci(self):
        def mutate(doc):
            for step in doc["jobs"]["installer"]["steps"]:
                options = step.get("with", {})
                if options.get("key", "").startswith("studyvis-webkitgtk-"):
                    options["key"] += "-drift"
        self.modify_workflow("deploy.yml", mutate)
        self.assert_failure("shared webkitgtk cache key differs")

    def test_runtime_fallback_cannot_cross_manifest_even_in_both_workflows(self):
        for filename, job in (("ci.yml", "linux-appimage"), ("deploy.yml", "installer")):
            def mutate(doc, job=job):
                for step in doc["jobs"][job]["steps"]:
                    options = step.get("with", {})
                    if options.get("key", "").startswith("studyvis-webkitgtk-") and "restore-keys" in options:
                        options["restore-keys"] += "\nstudyvis-webkitgtk-"
            self.modify_workflow(filename, mutate)
        self.assert_failure("WebKit fallback crosses")

    def test_runtime_cannot_be_saved_after_failed_build(self):
        def mutate(doc):
            for step in doc["jobs"]["linux-appimage"]["steps"]:
                if step.get("uses", "").startswith("actions/cache/save") and step.get("with", {}).get("key", "").startswith("studyvis-webkitgtk-"):
                    step["if"] = "${{ !cancelled() }}"
        self.modify_workflow("ci.yml", mutate)
        self.assert_failure("webkitgtk save must require success()")

    def test_tool_verifier_inputs_cannot_leave_cache_key(self):
        for filename in ("ci.yml", "deploy.yml"):
            path = self.root / ".github/workflows" / filename
            path.write_text(path.read_text().replace(", 'scripts/verify-linux-appimage-runtime.sh'", ""))
        self.assert_failure("linuxdeploy key omits")

    def test_tagged_release_rejects_restore_even_for_platform_condition(self):
        self.modify_workflow("release.yml", lambda doc: doc["jobs"]["publish"]["steps"].insert(0, {
            "uses": "Swatinem/rust-cache@0123456789012345678901234567890123456789",
            "if": "runner.os == 'Linux'",
        }))
        self.assert_failure("tagged release must not restore")

    def test_tagged_release_rejects_compiler_cache(self):
        self.modify_workflow("release.yml", lambda doc: doc["jobs"]["publish"]["steps"].append({"run": "export CC='sccache cc'"}))
        self.assert_failure("without compiler caches")

    def test_patch_manifest_must_match_bytes(self):
        patch = next((self.root / "scripts/patches").glob("webkitgtk-*.patch"))
        patch.write_text(patch.read_text() + "\nchanged\n")
        self.assert_failure("native manifest patch hash differs")

    def test_source_commit_must_match_runtime_tuple(self):
        path = self.root / "scripts/linux-appimage-runtime-sources.tsv"
        path.write_text(path.read_text().replace("75849dce7cc37e4319b633df1f116ca895c71a12", "0" * 40))
        self.assert_failure("source commit differs")

    def test_command_registration_requires_acl_entry(self):
        path = self.root / "src-tauri/src/lib.rs"
        path.write_text(path.read_text().replace("generate_handler![", "generate_handler![\nnew_sensitive_command,"))
        self.assert_failure("AppManifest and invoke_handler")

    def test_main_grants_cannot_silently_omit_a_command(self):
        path = self.root / "src-tauri/permissions/window-commands.toml"
        path.write_text(path.read_text().replace('  "allow-identity-sign",\n', ""))
        self.assert_failure("main command grants differ")

    def test_dialog_command_set_cannot_expand(self):
        path = self.root / "src-tauri/permissions/window-commands.toml"
        path.write_text(re.sub(r'(identifier = "ai-dialog-commands".*?permissions = \[)', r'\1\n  "allow-identity-sign",', path.read_text(), flags=re.S))
        self.assert_failure("AI dialog must retain only")

    def test_secondary_window_cannot_gain_a_plugin(self):
        path = self.root / "src-tauri/capabilities/session-overlay.json"
        document = json.loads(path.read_text())
        document["permissions"].append("updater:default")
        path.write_text(json.dumps(document))
        self.assert_failure("permissions differ from the reviewed")

    def test_remote_origin_cannot_gain_capability(self):
        path = self.root / "src-tauri/capabilities/ai-dialog.json"
        document = json.loads(path.read_text())
        document["remote"] = {"urls": ["https://example.com"]}
        path.write_text(json.dumps(document))
        self.assert_failure("capability must be local")

    def test_wildcard_window_cannot_gain_main_capability(self):
        path = self.root / "src-tauri/capabilities/default.json"
        document = json.loads(path.read_text())
        document["windows"] = ["*"]
        path.write_text(json.dumps(document))
        self.assert_failure("scoped to exactly main")

    def test_inline_capability_cannot_bypass_window_policy(self):
        path = self.root / "src-tauri/tauri.conf.json"
        document = json.loads(path.read_text())
        document["app"]["security"]["capabilities"] = [{"identifier": "extra", "windows": ["*"], "permissions": ["main-commands"]}]
        path.write_text(json.dumps(document))
        self.assert_failure("inline/override capability")

    def test_new_native_source_cannot_be_unmonitored(self):
        path = self.root / "scripts/linux-appimage-runtime-sources.tsv"
        path.write_text(path.read_text() + "new-component\t1.0.0\tsource.tar.gz\thttps://example.com/source.tar.gz\t" + "0" * 64 + "\tMIT\tLICENSE\n")
        self.assert_failure("native monitoring must cover every pinned")


if __name__ == "__main__":
    unittest.main()
