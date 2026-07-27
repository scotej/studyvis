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
  (macOS Keychain, Windows Credential Manager). Nothing is uploaded, ever.
- **AI inference is on-device.** The llama-server sidecar runs locally;
  screenshots and camera frames never leave the machine.
- **Two entries in `ISSUES.md` are accepted deviations, not open bugs** —
  `I9` (any peer can drive the shared Pomodoro) and `I18` (the sidecar
  model path is not sandboxed). Both are in-scope only for an attacker who
  is already a paired friend or already has local code execution. Reports
  restating them will be closed as accepted.

## The part that is genuinely sensitive

Builds are **unsigned**: friends clear a Gatekeeper or SmartScreen warning
on first install, and from v1.5.0 the app self-updates. The integrity of
every installed copy therefore rests on two things:

1. **The updater's minisign keypair.** Update artifacts are signed in CI
   and verified in-app against `plugins.updater.pubkey`. This is separate
   from OS code signing and is the only thing standing between a friend's
   machine and an arbitrary payload.
2. **The release workflows themselves.** `.github/workflows/release.yml`
   and `release-prep.yml` mint the artifacts. Anything that lets an
   attacker influence what those workflows execute — a moved third-party
   action ref, a script-injection sink in a `run:` block, a widened
   `GITHUB_TOKEN` scope — is effectively remote code execution on every
   install.

Findings in those two areas are the ones worth reporting, and they are
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
there is no backporting — the fix ships as the next `vX.Y.Z` tag.
