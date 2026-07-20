# Installing StudyVis

StudyVis ships unsigned installers for a friends-only audience. Each OS will warn the first time you run the app — the steps below explain how to clear those warnings. After the first launch, the OS remembers your decision and stops asking.

> **You only have to do this once.** From v1.5.0 on, StudyVis updates itself — see [Updating](#updating) below.

## macOS (Apple Silicon)

> StudyVis ships an Apple Silicon (`aarch64`) `.dmg` only. Intel Macs are not in the release matrix. (In → About This Mac, "Apple M…" = Apple Silicon.)

1. From the [Releases page](https://github.com/scotej/studyvis/releases), download `StudyVis_<version>_aarch64.dmg`.
2. Double-click the `.dmg`. A window opens showing the StudyVis icon and an Applications shortcut. Drag StudyVis into Applications.
3. Open Finder → Applications. **Right-click** (or Control-click) the StudyVis icon and choose **Open**. The app is ad-hoc signed, so macOS shows the milder _"macOS cannot verify the developer of 'StudyVis'. Are you sure you want to open it?"_ prompt — not a hard block. Click **Open**.
4. Subsequent launches do not re-prompt — double-click works normally.
5. The first time you join a session, macOS asks for camera and microphone permission. Allow both. (Screen-recording permission is requested separately, and only if you turn on AI features.)

## Windows 10 / 11

1. From the [Releases page](https://github.com/scotej/studyvis/releases), download `StudyVis_<version>_x64-setup.exe`.
2. Double-click the installer. **SmartScreen** intercepts: _"Windows protected your PC"_. Click **More info**, then **Run anyway**.
3. Step through the installer (defaults are fine). StudyVis lands in your Start menu and Programs list.
4. The first time you join a session, Windows asks for camera and microphone permission via WebView2. Allow both.

> **Coming from StudyVis 1.4.0 or earlier?** Those shipped as an `.msi`. Uninstall the old StudyVis from Settings → Apps first, then run this installer — otherwise Windows lists two copies. Your identity, friends, and history are untouched by the uninstall; they live in your user data directory, not the program folder.

## Linux

Linux installers are not available yet. WebKitGTK's `getDisplayMedia` support was not validated during the V0 sanity check; Linux returns once that path is verified. If you want to try the development build today, clone the repo and run `npm run tauri dev`.

## Updating

StudyVis updates itself. It checks GitHub for new releases shortly after
launch and every few hours after that, downloads one in the background when
it finds it, and then shows a **"StudyVis X.Y.Z is ready"** banner with a
**Restart now** button. Clicking it takes a couple of seconds — the download
already happened.

It will not interrupt you: no check, no download, and no banner while you are
in a session. Dismissing the banner with **Later** keeps the update waiting;
it stays available in Settings → About until you restart.

Nothing about you is sent in any of this — the requests are anonymous
fetches of a public file. Each update is signature-checked before it is
installed, so a tampered download is rejected. To opt out entirely, turn
**Automatic updates** off in Settings → About; StudyVis then makes no
outbound requests at all beyond connecting you to friends.

**If you ever need to install by hand** — you're on a build older than
v1.5.0, or an update failed:

- **macOS:** download the new `.dmg` and drag StudyVis to Applications, replacing the existing app.
- **Windows:** download the new `-setup.exe` and run it; it upgrades the existing install in place.

Your identity, friends list, and local session history live in your OS data directory — they are preserved across updates and reinstalls.

> **macOS permission re-prompts.** Because the app is not yet signed with an Apple Developer ID, macOS may treat an updated StudyVis as a new app and ask for camera / microphone / screen-recording permission again after an update. Granting it again is safe; this goes away if the app is ever properly signed.

## Troubleshooting

- **macOS, "App is damaged and can't be opened"** — uncommon now that the app is ad-hoc signed (the usual first-run prompt is the milder "cannot verify the developer" one above), but it can still happen on a stubborn download where quarantine is flagged and right-click → Open is skipped. From Terminal: `xattr -dr com.apple.quarantine /Applications/StudyVis.app`, then double-click again.
- **Windows, SmartScreen does not show "More info"** — make sure you're running Windows 10 1903 or later. Older builds present a different dialog.
- **Camera or mic permission denied at first launch** — open the OS privacy panel (macOS System Settings → Privacy & Security; Windows Settings → Privacy & security → Camera/Microphone) and grant StudyVis access manually, then relaunch.
