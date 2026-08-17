# Security

StudyVis is a friends-only desktop app. There is no server, no account
system, and no telemetry — everything runs on the machines of the handful
of people who installed it. That shapes what "a vulnerability" means here,
so read this before filing one.

## What the threat model actually is

The full version lives in `ARCHITECTURE.md` §12. The short form:

- **Peers are friends, not strangers.** There are no public rooms. You
  connect to someone only after exchanging a pair link out of band. A
  malicious peer is someone you already decided to study with.
- **All data is local.** Sessions, stats, and the audit log live in a
  SQLite database on your own disk. Private keys live in the OS keychain
  (macOS Keychain, Windows Credential Manager, or the freedesktop Secret
  Service on Linux). Linux requires a provider owning
  `org.freedesktop.secrets`; StudyVis does not fall back to plaintext when
  that service is unavailable. There is no account, no server-side history,
  and no telemetry — none of it is uploaded.
- **Network traffic does leave the machine, but StudyVis does not upload user
  or session content.** Peer discovery rides third-party Nostr/MQTT relays,
  and since I74 presence
  does too: every 30 s the app publishes a tiny ephemeral Nostr event
  (kind 20001) to the pinned relays. The payload is XSalsa20-Poly1305
  sealed and signed with a throwaway per-run key, and it carries a
  heartbeat or a goodbye — nothing about what you are studying. A relay
  operator sees encrypted beacons on an opaque tag, and traffic-analysis
  inferences from them are in scope for a report. See ARCHITECTURE §4.
- **Updates and user-initiated AI installs fetch public artifacts.** With
  auto-update enabled, StudyVis reads GitHub's public release manifest and
  downloads a newer installer. Installing an AI engine/model contacts GitHub
  or Hugging Face. These requests do not upload StudyVis identity, friend, or
  session data.
- **AI inference is on-device.** The llama-server sidecar runs locally;
  screenshots and camera frames never leave the machine.
- **Two entries in `ISSUES.md` are accepted deviations, not open bugs** —
  `I9` (any peer can drive the shared Pomodoro) and `I18` (the sidecar
  model path is not sandboxed). Both are in-scope only for an attacker who
  is already a paired friend or already has local code execution. Reports
  restating them will be closed as accepted.

## The part that is genuinely sensitive

macOS and Windows builds lack commercial OS code signing: friends clear a
Gatekeeper or SmartScreen warning on first install. The next release candidate
adds an x86_64 Linux AppImage rather than a distro-signed native package. From
v1.5.0 the app self-updates on currently shipped platforms; the Linux candidate
uses the same signature chain, so the integrity of every installed
copy rests on three things:

1. **The updater's minisign keypair.** Update artifacts are signed in CI
   and verified in-app against `plugins.updater.pubkey`. This is separate
   from OS code signing and is the only thing standing between a friend's
   machine and an arbitrary payload.
2. **The release workflows themselves.** `.github/workflows/release-prep.yml`
   creates the tag, `release.yml` mints the draft artifacts, and
   `publish-release.yml` revalidates and publishes them. Anything that lets an
   attacker influence what those workflows execute — a moved third-party action
   ref, a script-injection sink in a `run:` block, a widened `GITHUB_TOKEN`
   scope, or a bypass around the intended publication path — is effectively
   remote code execution on every install. Workflow YAML also cannot create the
   repository controls around that path. The publisher therefore also requires
   the latest `release.yml` run for the exact tag name and tag commit to have
   completed successfully; `tauri-action` uploads first, and that run attests
   its artifacts only after the platform-specific checks (including the exact
   AppImage smoke). The publisher downloads the exact twelve-file draft set,
   compares updater signature sidecars with the manifest, verifies every
   artifact's attestation against that workflow/tag/commit, requires the
   physically tested AppImage SHA-256, and rechecks that digest immediately
   before publishing. Before production publication, an administrator must create the
   `release` environment with required reviewers, protect matching
   `v*` tags against creation/update/deletion, and enable immutable releases. This
   sole-owner repository uses `scotej` as its reviewer and permits self-review;
   add an independent reviewer and enable self-review prevention for two-person
   approval.
   The tag ruleset's sole `Always` bypass entry must be `RepositoryRole 5`
   (admin), used by the owner-scoped `RELEASE_PAT`; do not add Write, Maintain,
   team, or integration bypasses. GitHub hides `bypass_actors` from the
   workflow's read-only ruleset API response, so an admin must verify that list.
   On 2026-08-15, the `release` environment (with `scotej` as reviewer), active
   `v*` lifecycle rule, and immutable releases were configured and verified.
   This is a sole-owner approval boundary until an independent reviewer is
   added. The YAML's asset checks are not a substitute for independent approval
   or for preventing later tag/release mutation.
   Every platform artifact must also carry the generated
   `THIRD-PARTY-NOTICES.txt`/`.json` pair. Its offline regeneration gate derives
   the npm production and three target-filtered normal Cargo closures plus the
   pinned llama.cpp runtime, with version/hash-bound Wry, font, and
   victory-vendor exceptions; artifact checks byte-compare the packaged files
   and recorded notice hash. This is release evidence, not legal sign-off.
3. **The bundled Linux browser runtime.** Official distro WebKitGTK production
   builds in the maintained Linux path compile the GTK `ENABLE_WEB_RTC`
   peer-connection binding out (not the media-device API), so the candidate
   cannot inherit either that functionality or later distro security fixes. Its
   AppImage carries hash-pinned WebKitGTK 2.52.5 + librice 0.4.3 plus one
   reviewed AppImage runtime portability patch. That patch resolves the
   packaged WebKit subprocesses, injected bundle, and sandbox helpers relative
   to the executable before native fallbacks; it does not disable the process
   sandbox. The exact source and patch hashes are in `INSTALL.md` and
   `ARCHITECTURE.md`, and in the AppImage's own `BUILD-MANIFEST.txt`. Its
   adjacent readable/hash-addressed
   inventory covers all 59 upstream WebKit license/notice files found by the
   pinned build. A separate generated librice text/JSON pair covers the exact
   locked normal dependency union for the `rice-proto` and `rice-io` `cargo-c`
   roots with `capi` enabled. After the exact tagged AppImage smoke, the draft also receives
   a deterministic corresponding-source archive containing the verified
   upstream archives and complete build delta, plus a SHA-256 sidecar. A second
   deterministic system-source pair audits every finished-AppImage ELF,
   symlink, byte hash/build ID, and dynamic-link edge; maps Ubuntu bytes to exact
   package/source/copyright material; and carries pinned packaging-tool,
   AppRun, and llama.cpp source/notice inputs. All four source assets are
   mandatory, re-downloaded, and verified before publication, and an unmapped
   modeled byte/source/checksum fails closed. The system-source pair includes
   StudyVis's source-built AppImage type-2 runtime revision 2 with hash-pinned
   type2, musl, zlib, decompression-only-zstd, libfuse, squashfuse, and Meson
   sources/licenses; exact Noble toolchain/CRT provenance; build metadata; a
   link map; and per-input hashes. Verification requires an
   `x86_64-linux-musl` static PIE with no interpreter or dynamic dependencies,
   using musl mallocng and no mimalloc. This completes the pre-SquashFS
   runtime's static source/notice/link closure. The Ubuntu 24.04 hosted image
   and Noble apt indexes remain a bounded, mutable baseline rather than a bit-reproducible
   build environment. Neither checksum pair replaces immutable releases or the
   protected publication path, and none is legal sign-off.
   Maintainers must monitor both upstreams, review and re-pin every update,
   rebuild and validate the exact AppImage and source archive, rerun the
   physical WebRTC matrix, preserve required license notices and
   corresponding-source provision, and deliver the replacement through the
   signed updater. A stale bundled runtime, a hash/check bypass, a missing
   required license/source provision, or a patch that weakens WebKit's process
   sandbox is security/release-pipeline scope even if the host distro is fully
   patched.

Findings in those three areas are the ones worth reporting, and they are
taken seriously regardless of how theoretical they look.

## Reporting

Use **GitHub's private vulnerability reporting** on this repository
(Security → Report a vulnerability). That keeps the report out of public
issues until there is a fix.

If you would rather not use GitHub, open a normal issue that says only
"security report, please make contact" with no details, and wait to be
contacted.

Please include: what an attacker can do, what they need first (paired
friend? local access? a malicious relay?), and the shortest reproduction
you have. A proof of concept is welcome but not required.

**Do not** paste a BIP39 recovery phrase, a private key, or a keychain
export into an issue, a pull request, or a chat with any AI service —
including while debugging with a coding agent.

## What to expect back

This is a hobby project maintained by one person for a small group of
friends, so there is no SLA. Realistically: an acknowledgement within a
week, and a fix shipped in the next release for anything that reaches the
updater keypair or the release pipeline. Lower-severity findings may be
logged in `ISSUES.md` and batched into a maintenance wave.

## Supported versions

Only the latest release. Friends update in place from v1.5.0 onward, and
there is no backporting — the fix ships as the next `vX.Y.Z` tag. Linux is not
yet a supported release: its exact AppImage must first pass PLAN §8's physical
data-channel/media/cross-platform-peer matrix and the external repository
publication controls above must be configured.
