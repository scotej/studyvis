# Installing StudyVis

V1 ships unsigned installers for a friends-only audience. Each OS will warn the first time you run the app — the steps below explain how to clear those warnings. After the first launch, the OS remembers your decision and stops asking.

> StudyVis does **not** auto-update. When a new version is available, download the latest installer from the [GitHub Releases page](https://github.com/scotej/studyvis/releases) and re-run the install steps for your OS.

## macOS (Apple Silicon + Intel)

1. From the [Releases page](https://github.com/scotej/studyvis/releases), download `StudyVis_<version>_universal.dmg`.
2. Double-click the `.dmg`. A window opens showing the StudyVis icon and an Applications shortcut. Drag StudyVis into Applications.
3. Open Finder → Applications. **Right-click** (or Control-click) the StudyVis icon and choose **Open**. macOS shows: _"macOS cannot verify the developer of 'StudyVis'. Are you sure you want to open it?"_. Click **Open**.
4. Subsequent launches do not re-prompt — double-click works normally.
5. The first time you join a session, macOS asks for camera and microphone permission. Allow both. (StudyVis V1 does not request screen-recording permission; that arrives in V2 with AI features.)

## Windows 10 / 11

1. From the [Releases page](https://github.com/scotej/studyvis/releases), download `StudyVis_<version>_x64_en-US.msi`.
2. Double-click the `.msi`. **SmartScreen** intercepts: _"Windows protected your PC"_. Click **More info**, then **Run anyway**.
3. Step through the installer (defaults are fine). StudyVis lands in your Start menu and Programs list.
4. The first time you join a session, Windows asks for camera and microphone permission via WebView2. Allow both.

## Linux

Linux installers are not in V1. WebKitGTK's `getDisplayMedia` support was not validated during the V0 sanity check; Linux returns in V3 once that path is verified. If you want to try the development build today, clone the repo and run `npm run tauri dev`.

## Updating

There is no in-app update prompt. To upgrade:

- **macOS:** download the new `.dmg` and drag StudyVis to Applications, replacing the existing app.
- **Windows:** download the new `.msi` and run it; it upgrades the existing install in place.

Your identity, friends list, and local session history live in your OS data directory — they are preserved across reinstalls.

## Troubleshooting

- **macOS, "App is damaged and can't be opened"** — this happens when the `.dmg` is downloaded with quarantine flagged but right-click → Open is skipped. From Terminal: `xattr -dr com.apple.quarantine /Applications/StudyVis.app`, then double-click again.
- **Windows, SmartScreen does not show "More info"** — make sure you're running Windows 10 1903 or later. Older builds present a different dialog.
- **Camera or mic permission denied at first launch** — open the OS privacy panel (macOS System Settings → Privacy & Security; Windows Settings → Privacy & security → Camera/Microphone) and grant StudyVis access manually, then relaunch.
