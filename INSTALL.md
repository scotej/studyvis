# Installing StudyVis

StudyVis ships friends-only builds for macOS and Windows. The next release
candidate adds x86_64 Linux AppImage support, subject to the physical CachyOS
sign-off documented below.
macOS and Windows warn on the first launch because their installers do not
carry commercial OS code-signing identities; the steps below explain how to
clear those warnings. The Linux candidate is an AppImage rather than a native
distro package.

> **You only have to do this once.** From v1.5.0 on, StudyVis updates itself — see [Updating](#updating) below.

## macOS (Apple Silicon)

> StudyVis ships an Apple Silicon (`aarch64`) `.dmg` only. Intel Macs are not in the release matrix. (In → About This Mac, "Apple M…" = Apple Silicon.)

1. From the [Releases page](https://github.com/scotej/studyvis/releases), download `StudyVis_<version>_aarch64.dmg`.
2. Double-click the `.dmg`. A window opens showing the StudyVis icon and an Applications shortcut. Drag StudyVis into Applications.
3. Open Finder → Applications. **Right-click** (or Control-click) the StudyVis icon and choose **Open**. The app is ad-hoc signed, so macOS shows the milder _"macOS cannot verify the developer of 'StudyVis'. Are you sure you want to open it?"_ prompt — not a hard block. Click **Open**.
4. Subsequent launches do not re-prompt — double-click works normally.
5. The first time you join a session, macOS asks for camera and microphone permission. Allow both. Screen-recording permission is requested separately when you share a screen or turn on AI features.

## Windows 10 / 11

1. From the [Releases page](https://github.com/scotej/studyvis/releases), download `StudyVis_<version>_x64-setup.exe`.
2. Double-click the installer. **SmartScreen** intercepts: _"Windows protected your PC"_. Click **More info**, then **Run anyway**.
3. Step through the installer (defaults are fine). StudyVis lands in your Start menu and Programs list.
4. The first time you join a session, Windows asks for camera and microphone permission via WebView2. Allow both.

> **Coming from StudyVis 1.4.0 or earlier?** Those shipped as an `.msi`. Uninstall the old StudyVis from Settings → Apps first, then run this installer — otherwise Windows lists two copies. Your identity, friends, and history are untouched by the uninstall; they live in your user data directory, not the program folder.

## Linux (x86_64 AppImage)

The Linux release candidate is an x86_64 AppImage. CachyOS with KDE Plasma on
Wayland is the reference Linux desktop and must pass the release matrix before the
candidate is published. ARM64 Linux and native Arch, Debian, RPM,
Flatpak, and Snap packages are not currently shipped.

### CachyOS runtime prerequisites

On a current CachyOS/Arch installation, install the AppImage mount bridge and
KDE screen-capture services:

```sh
sudo pacman -S --needed fuse2 xdg-desktop-portal xdg-desktop-portal-kde \
  pipewire wireplumber
```

The production AppImage bundles its WebKitGTK, JavaScriptCore, librice,
GStreamer, and sandbox helper runtime. In particular, installing the official
distro `webkit2gtk-4.1` package is not a WebRTC fix: its production build has
the GTK `ENABLE_WEB_RTC` peer-connection binding compiled out. It still exposes
`navigator.mediaDevices`; the missing surface is `RTCPeerConnection`. That
package remains useful as a build-time Tauri development dependency, but the
release candidate does not use it as its production browser runtime.

StudyVis stores private identity keys and optional Hugging Face credentials in
the freedesktop Secret Service, never in its plaintext settings. A user-session
service must own `org.freedesktop.secrets`. If you do not already use a
compatible provider (for example KeePassXC with Secret Service integration
enabled), install and enable one such as `gnome-keyring`:

```sh
sudo pacman -S --needed gnome-keyring
```

Log out and back in after adding a portal or keyring provider so the user D-Bus
session starts it consistently. Installing multiple competing portal backends
can make the KDE picker unreliable; keep `xdg-desktop-portal-kde` as the Plasma
backend.

### Install and launch

1. Once the candidate is published, download its x86_64 `.AppImage` from the
   [Releases page](https://github.com/scotej/studyvis/releases).
2. Put it somewhere both the file and containing directory are writable. A
   stable per-user location makes automatic updates predictable:

   ```sh
   mkdir -p "$HOME/.local/bin"
   install -m 0755 ./StudyVis_X.Y.Z_amd64.AppImage \
     "$HOME/.local/bin/StudyVis.AppImage"
   "$HOME/.local/bin/StudyVis.AppImage"
   ```

   Replace `X.Y.Z` with the downloaded version. A desktop-menu integration
   tool is optional; StudyVis does not require root access to run.

3. When KDE asks, allow camera/microphone access and choose the requested
   screen in the desktop-portal picker. Screen sharing and optional AI capture
   both use the Wayland portal + PipeWire path. StudyVis cannot silently bypass
   or preselect that picker.

The AppImage contains the packaged x86_64 llama.cpp engine. That candidate
build is CPU-only: it works without a dedicated GPU, but larger vision models can be
slow. Run the optional benchmark and prefer a lighter model if the measured
cadence is not usable.

It also contains the pinned WebKitGTK 2.52.5 + librice 0.4.3 runtime required
for peer connections. A window opening successfully is not proof that this
runtime works: Linux remains a release candidate until the exact downloaded
AppImage completes the data-channel/media/physical-peer matrix in `PLAN.md` §8.

### FUSE-free fallback

If AppImage reports that it cannot open `libfuse.so.2`, installing `fuse2` as
above is the normal fix. Where FUSE mounting is unavailable by policy, launch
the same download without mounting it:

```sh
chmod +x ./StudyVis_X.Y.Z_amd64.AppImage
./StudyVis_X.Y.Z_amd64.AppImage --appimage-extract-and-run
```

This is the documented but slower candidate launch fallback: it extracts to a
temporary tree on every run. Tauri keeps the original `APPIMAGE` path and uses
that file for updates and relaunch, so automatic update can still work. The
original AppImage and its containing directory must remain writable; extraction
does not bypass that requirement.

### Building on CachyOS / Arch Linux

The source build additionally needs the compiler toolchain and frontend tools:

```sh
sudo pacman -S --needed base-devel bison bubblewrap cmake curl dbus file flex \
  glib2-devel gperf ninja nodejs-lts-krypton npm openssl patchelf ruby rustup \
  unifdef webkit2gtk-4.1 xdg-dbus-proxy libayatana-appindicator librsvg xdotool \
  gst-libav gst-plugin-pipewire gst-plugins-bad gst-plugins-base \
  gst-plugins-good libnice
rustup toolchain install 1.97.1 --profile minimal --component rustfmt --component clippy
cargo install cargo-c --version '=0.10.24' --locked
npm ci
npm run tauri dev
```

The same portal, PipeWire, and Secret Service runtime requirements above apply.
Debug builds can install the pinned engine on first AI use; before a
release-profile build, fetch the real sidecar explicitly with
`bash scripts/fetch-llama-server.sh --triple x86_64-unknown-linux-gnu`. Build the
pinned browser runtime once, then package it:

```sh
bash scripts/build-linux-webkit-runtime.sh
npm run build:linux
```

`npm run build:linux` produces an unsigned, non-updater local AppImage and sets
linuxdeploy's `NO_STRIP=1` compatibility mode; Cargo has already optimized the
executable, while the older strip embedded in linuxdeploy cannot parse the
DT_RELR sections emitted by current CachyOS/Arch toolchains. Official release
artifacts use the workflow's pinned Linux build environment and are signed for
updater integrity.

### Cross-platform third-party notices

Every macOS, Windows, and Linux bundle includes the same generated
`THIRD-PARTY-NOTICES.txt` and `THIRD-PARTY-NOTICES.json` Tauri resources. The
generator walks npm's locked production tree and Cargo's normal dependency
closure separately for each release target, then adds the pinned llama.cpp
runtime. It reads no network data: run `npm ci` and populate Cargo's locked
cache first when starting cold:

```sh
cargo fetch --locked --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin
cargo fetch --locked --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
cargo fetch --locked --manifest-path src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu
npm run check-notices
```

`npm run generate-notices` rewrites the canonical root files and their exact
`src-tauri/resources/` bundle copies. The version-bound override manifest covers
vendored Wry's MIT selection, llama.cpp b9095, the Inter and JetBrains Mono OFL
texts, victory-vendor's omitted root MIT text and all 13 nested d3/internmap
licenses, and locked archives that declare a license while omitting its text.
Missing text, version/license drift, an unused override, or a changed pinned
hash fails generation. After extracting an artifact, run
`npm run check-notice-bundle -- <artifact-root>` to require one co-located notice
pair, byte-compare it with the committed files, and verify the manifest's notice
hash. These gates produce a reviewable inventory; they are not legal advice or
legal sign-off.

### Pinned Linux WebKit runtime

WebKitGTK's GTK release configuration makes `ENABLE_WEB_RTC` follow the
experimental-feature umbrella, which official distro production packages in the
maintained path leave off. `ENABLE_MEDIA_STREAM` remains on: the native distro
probe exposed `navigator.mediaDevices` while `RTCPeerConnection` was undefined.
A Wry runtime preference cannot restore the compiled-out peer-connection
binding. StudyVis therefore builds that binding into a private AppImage runtime,
explicitly reasserts media streams, and keeps the rest of WebKit's experimental
feature set disabled.

The pinned, hash-verified input tuple for runtime revision 3 is:

| Input                              | Pinned source                                                        | SHA-256                                                            |
| ---------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| WebKitGTK                          | `https://webkitgtk.org/releases/webkitgtk-2.52.5.tar.xz`             | `8a531a9abd2215936e8a8a914c077b586c0228b31d652f205286a8ec90f3364b` |
| librice                            | `https://github.com/ystreet/librice/archive/refs/tags/v0.4.3.tar.gz` | `4671e1835f9ab0f8d87e8d9e22b6bfb06f928aeae442841ab81881dff61e3f4b` |
| AppImage runtime portability patch | `scripts/patches/webkitgtk-2.52.5-appimage-sandbox.patch`            | `907380c80b541f89924bfd0d9709ac9a20d353b99d361d785dbe017324837eb8` |

`scripts/linux-webkit-runtime.env` is the exact source URL/version/hash,
portability-patch hash, `cargo-c` version, runtime revision, and AppImage
runtime-directory source of truth.
`scripts/build-linux-webkit-runtime.sh` verifies both downloads before
extracting them, applies the named patch, asserts the effective CMake cache
(`ENABLE_WEB_RTC=ON`, `ENABLE_MEDIA_STREAM=ON`, GStreamer WebRTC + librice +
bubblewrap sandbox on, all experimental features off), and installs the
runtime's provenance/license material. Run it with `--print-manifest` to review
the expected manifest without compiling. Despite its historical filename, the
revision-3 portability patch covers the full AppImage relocation boundary. It
resolves `WebKitNetworkProcess`, `WebKitWebProcess`, `WebKitGPUProcess`, and the
injected bundle from `studyvis-webkit-runtime/` beside the StudyVis executable,
then uses WebKit's compiled native paths only as fallbacks. The staged locations
are `/usr/bin/studyvis-webkit-runtime/{WebKitNetworkProcess,WebKitWebProcess,WebKitGPUProcess,injected-bundle/libwebkit2gtkinjectedbundle.so}`.
It likewise prefers the packaged `/usr/bin/{bwrap,xdg-dbus-proxy}` beside the
StudyVis executable. It does not weaken or disable the Web/GPU/Network process
sandbox.

This is a pinned, reviewable build recipe, not a claim that independent builds
are bit-for-bit identical. Production builds use Ubuntu 22.04, Rust 1.97.1,
`cargo-c` 0.10.24, and the workflow's declared source-build dependency set.
CI/preview cache keys cover the runtime tuple, builder, librice notice generator,
patch, and toolchain pins, and the verified builder runs after a restore. Tagged
releases deliberately restore no compiled Rust or WebKit state and cold-build
the runtime from the verified tuple. The hosted runner image and Jammy apt
indexes remain mutable, so this is a bounded Jammy baseline, not a fully pinned
build environment. Stronger future closure would require a snapshot-pinned apt
repository or digest-pinned build container plus a complete build-host dpkg
inventory. The AppImage carries
the resulting libraries, subprocesses, GStreamer helpers/plugins, sandbox
helpers, upstream license texts, librice licenses, and the applied patch. Under
`usr/share/licenses/studyvis-webkit-runtime/`, `BUILD-MANIFEST.txt` records the
exact URLs/hashes, patch, `cargo-c`, compiler policy, effective CMake/Rice and
pkg-config inputs, AppImage-relative process/helper layout, runtime identity,
and payload list;
`WEBKIT-THIRD-PARTY-LICENSES.txt` concatenates the 59 upstream WebKit
license/notice files and `WEBKIT-LICENSE-FILES.sha256` records their individual
hashes. The builder also derives `LIBRICE-THIRD-PARTY-NOTICES.txt` and its JSON
manifest from the exact locked/offline normal-dependency union for the
`rice-proto` and `rice-io` `cargo-c` roots with `capi` enabled. This pair records
the target, root commands, librice `Cargo.lock` hash, direct source
URLs/checksums, and normalized license-text hashes, and remains verifiable after
the extracted source tree is deleted.

The builder's `--source-bundle <output.tar.gz>` mode produces the deterministic
corresponding-source archive used by tagged releases. It contains the two exact
verified upstream archives, the complete portability patch, pinned env file,
build script, build manifest, a reconstruction README, and internal
`SHA256SUMS`. After the tagged workflow's exact-AppImage smoke succeeds, the
draft receives `StudyVis_X.Y.Z_linux-webkit-sources.tar.gz` and the matching
`StudyVis_X.Y.Z_linux-webkit-sources.tar.gz.sha256`; release validation requires
and verifies both. Here `X.Y.Z` is the release tag without its leading `v`, and
the external checksum file contains exactly one `<sha256>  <basename>` entry.
The source archive is a separate release asset rather than being embedded in
every AppImage.

The tagged Linux job also creates
`StudyVis_X.Y.Z_linux-system-sources.tar.gz` and its basename-only `.sha256`
sidecar from the exact finished AppImage. This deterministic bundle inventories
every regular ELF, symlink, SHA-256/build ID, `DT_NEEDED`, and `PT_INTERP` edge;
maps Ubuntu-derived bytes to exact binary/source package versions and Debian
copyright files; downloads and verifies the matching apt source components;
and carries the modeled linuxdeploy/appimagetool/type-2-runtime/AppRun,
GTK/GStreamer hook, and llama.cpp source/notice inputs. An unclassified byte,
missing modeled copyright/source, unavailable exact Ubuntu source version, or
checksum failure stops release creation. The bundle includes the complete
evidence directory for StudyVis's source-built AppImage type-2 runtime revision
1: hash-pinned type2, musl 1.2.5, zlib 1.3.1, decompression-only zstd 1.5.6,
libfuse 3.15.0, squashfuse 0.5.2, and Meson 1.7.2 sources and license texts;
exact Jammy gcc-11, clang-14, binutils, CRT, and libgcc provenance; build
metadata; a link map; and hashes for every selected link input. The runtime is
an `x86_64-linux-musl` `ET_DYN` static PIE with no `PT_INTERP` or `DT_NEEDED`.
Its allocator is musl mallocng; mimalloc is neither linked nor shipped. This
completes the pre-SquashFS runtime's static source/notice/link closure. Publication still
downloads and verifies both Linux source pairs, but these mechanical checks are
not legal sign-off and do not make the mutable Jammy baseline bit-reproducible.

Because the host package manager cannot update this private copy, every
WebKitGTK or librice security bump must update the tuple, rebase and re-hash the
patch, rebuild the AppImage and source archive, repeat the packaged checks and
physical matrix, and ship through StudyVis's signed updater. Maintainers are
also responsible for continuing to satisfy all notice and corresponding-source
obligations for the redistributed components.

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
- **Linux candidate (once published):** download the new x86_64 AppImage,
  replace the old AppImage in its writable location, and keep it executable. Do
  not replace the live file while StudyVis is running.

Your identity, friends list, and local session history live in your OS data directory — they are preserved across updates and reinstalls.

> **macOS permission re-prompts.** Because the app is not yet signed with an Apple Developer ID, macOS may treat an updated StudyVis as a new app and ask for camera / microphone / screen-recording permission again after an update. Granting it again is safe; this goes away if the app is ever properly signed.

## Troubleshooting

- **macOS, "App is damaged and can't be opened"** — uncommon now that the app is ad-hoc signed (the usual first-run prompt is the milder "cannot verify the developer" one above), but it can still happen on a stubborn download where quarantine is flagged and right-click → Open is skipped. From Terminal: `xattr -dr com.apple.quarantine /Applications/StudyVis.app`, then double-click again.
- **Windows, SmartScreen does not show "More info"** — make sure you're running Windows 10 1903 or later. Older builds present a different dialog.
- **Linux, AppImage asks for FUSE / `libfuse.so.2`** — install CachyOS package
  `fuse2`, or use `--appimage-extract-and-run` for that launch. The extraction
  fallback is slower, but it still updates the original AppImage when that file
  and its directory are writable.
- **Linux, `RTCPeerConnection` is missing in a dev build** — the distro WebKitGTK
  build has the feature compiled out. Use the pinned runtime and build path
  above; changing a Wry setting or reinstalling `webkit2gtk-4.1` cannot add a
  compiled-out peer-connection binding.
- **Linux, identity or token storage fails** — confirm one Secret Service
  provider owns `org.freedesktop.secrets` in the user D-Bus session. Start or
  unlock gnome-keyring/KeePassXC, then relaunch StudyVis. Installing only the
  development `libsecret` library does not provide the service.
- **KDE Wayland does not show a screen picker, or capture is black** — confirm
  `xdg-desktop-portal`, `xdg-desktop-portal-kde`, and `pipewire` are running in
  the user session, then log out and back in. The picker must be accepted for
  screen sharing and for AI capture.
- **Linux candidate automatic update downloads but cannot install** — move the
  AppImage to a directory you own (for example `~/.local/bin`), ensure both it and the
  directory are writable, and launch that file. This requirement applies to
  both normal FUSE and extraction-mode launches.
- **Camera or mic permission denied at first launch** — open the OS privacy
  panel (macOS System Settings → Privacy & Security; Windows Settings → Privacy
  & security → Camera/Microphone; Linux desktop portal/privacy settings) and
  grant StudyVis access manually, then relaunch.
