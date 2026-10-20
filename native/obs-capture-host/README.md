# OBS capture host (development migration)

This Windows x64 host requires **OBS Studio 32.2.2** exactly. It is an unpackaged development path, not an installer-ready replacement. Installed clients still use Rust until migration acceptance. Screen audio and remote-control association are not yet supported by the OBS path.

## Build without starting capture

From the project root:

```powershell
./native/obs-capture-host/build.ps1
# After the verified archives are cached:
./native/obs-capture-host/build.ps1 -Offline
# Additionally compile the controlled window/game fixtures and identity tests:
./native/obs-capture-host/build.ps1 -Offline -BuildTestWindows
```

The script uses existing Visual Studio x64 C++ Build Tools and Windows SDK. It downloads to project-local `release/build-cache/obs-32.2.2`, verifies SHA-256, extracts the required files and builds with CMake. It does not install system components, initialize OBS, start capture or replace the user's OBS installation. No Qt, OBS UI, browser or recording/output plugins are included.

The official Windows ZIP has no development SDK. The script uses matching public headers and generates import libraries from actual fixed DLL exports; it does not invent an upstream CMake package. The fixed upstream `win-capture` source is rebuilt with the narrow exact-window patch. Official graphics-hook DLLs and injection helpers are **not** recompiled.

Pinned archives:

| Archive | SHA-256 |
| --- | --- |
| OBS 32.2.2 source | `ec81fb66b03e75ddb3076b576f62679c39262e0e9960cef3e17a40dc5d68e6b4` |
| OBS 32.2.2 Windows x64 runtime | `4d6e40e3ab155f56b30de517380566a206d74b63cdf5ad49aa596924768f97e1` |
| OBS Windows build dependencies 2026-07-15 x64 | `6f90e9598fa10cff5ad23cdcfae49b87868c07bf896b02cd464582b4ce2f2ba9` |

Source/runtime archives come from the [fixed official release](https://github.com/obsproject/obs-studio/releases/tag/32.2.2). The 66,679,471-byte dependency ZIP comes from the release URL recorded in that verified source's `CMakePresets.json`. Only needed headers/import libraries, Jansson's library and license files are extracted. Each build restores the verified upstream source before applying the local patch with `git apply --recount --whitespace=error-all`. Only diff context formatting is exempted from Git's source-whitespace checks.

The prepared runtime is `release/build-cache/obs-32.2.2/prepared`. It contains one `obs-plugins/64bit/win-capture.dll`: the project-built exact-window plugin. The original upstream plugin is not copied back by a default build, and the old optional game-plugin switch is removed. Test executables stay under `cmake-build/test-tools`, outside default builds and runtime packaging. Build manifests record archive, patch and binary hashes, compiler, size and resolved static imports. `runtimeExecuted: false` describes the build script, not separately authorized tests; `redistributionReady: false` remains deliberate.

## Enable the development route

Build the activity and media helpers together with the host (`npm run build:activity` and `npm run build:media` from `apps/web`). Set these three environment variables to absolute existing paths:

- `LYCANSYNC_OBS_CAPTURE_HOST`: prepared `bin/64bit/lycansync-obs-capture-host.exe`.
- `LYCANSYNC_OBS_WIN_CAPTURE_MODULE`: prepared `obs-plugins/64bit/win-capture.dll`, **not** the unpatched upstream copy.
- `LYCANSYNC_OBS_WIN_CAPTURE_DATA`: prepared `data/obs-plugins/win-capture`.

All three are required; the opt-in is Windows/unpackaged only. The parent starts the host in its `bin/64bit` directory because libobs locates core effects by relative path. Module paths are normalized before libobs derives the module name. Writable configuration belongs to Electron's user-data `obs-capture/32.2.2`, not the fixed runtime bundle.

## Source selection and identity

The existing picker remains unchanged; users do not choose a capture API.

- Monitors use OBS's monitor source and a validated device name, never an opaque source-ID suffix as an OS monitor index.
- Ordinary windows use a small OBS input adapter over the same official `libobs-winrt.dll`, with the selected HWND rather than title/class/executable rematching.
- Recognized games use the patched `lycansync_game_capture` source. The media helper privately returns the selected window's executable after checking the instance before and after reading its path. The existing activity helper classifies **that executable** using Steam/Epic install catalogs, League's match process and current-account manual mappings. Known launchers, music players and League's browser-based lobby do not enter game capture merely because they have activity status. An unrecognized application uses ordinary-window capture; a failed classification is an error, not a guess.

Classification queries do not enumerate windows or change published activity. The executable is stripped before host startup, never exposed to the renderer or anonymous report. The existing activity scan remains independent of capture resources. Configuration/stop changes invalidate pending classification results; late results cannot start capture or close a newer session.

Rust reserves the exact selected window/instance-property tuple in its existing video session, without starting a capture worker. List refresh does not release the reservation. The host checks the instance before source creation and before/after GPU delivery; a closed/replaced window ends capture without selecting a different window or monitor. Stop confirms the OBS process exit **before** releasing Rust's reservation. Unconfirmed termination keeps the reservation and blocks another capture. Old private protocol responses lacking the executable are rejected, not accepted via a compatibility path.

The stock game query exposes titles, not HWNDs. The fixed-source patch adds `lycansync_get_target` ABI 1 (selected HWND, actual drawing HWND, hooked and valid), disables foreground/fullscreen/hotkey target selection, and guards hook initialization/ticking/rendering/dimensions. Drawing children of the selected window are allowed; another top-level or owned popup is not. The host validates this public query rather than reading a precompiled DLL's private structure. A mismatch remains latched after stopping the plugin so it cannot become an apparent first-frame wait. Neither classifier nor game-source failure falls back to ordinary-window, monitor or Rust capture.

Minimized/hidden windows reuse suspension notifications and separately counted placeholders. Ordinary-window WinRT capability checks run on libobs's existing MTA graphics thread. Unsupported/denied cursor or border hiding fails explicitly: no bordered fallback or monitor cropping. Ordinary-window capture does not initialize the game-hook updater. Borderless/fullscreen and actual game/anti-cheat compatibility still require acceptance.

## Frames, configuration and cleanup

OBS renders a fixed 1920×1080 canvas at 30/60/120 FPS. The existing page/sender handles 720p output and text/motion hints. Same-session `obs_reset_video` preserves source, process, three texture slots and page track; it does not render permanently at 120 FPS and discard frames. Success is acknowledged after application. A rejected reset attempts the previous configuration; failed rollback or an uncertain three-second timeout ends capture without automatic retry.

The host copies the OBS main texture into three bounded BGRA shared-NT GPU slots. Each has a keyed mutex; D3D11 event-query completion and mutex release precede announcement. Initial zero source dimensions do not count as a first frame. Full slots drop an update rather than allocate more textures or queue indefinitely. Stdout carries only the protocol; warnings/errors go to stderr. Existing bounded low-frequency diagnostics read actual counters even when delivery is blocked.

Electron validates the child identity before duplicating handles. A slot is returned only after all imported references are released. Transfers pending Electron acknowledgement retain the main reference, avoiding premature release on stop or rejection. Preload snapshots imported frames through one session-owned OffscreenCanvas because direct external frames stalled the tested generated-track path. The input/import belongs to preload, the transferred copy to the page; matching stop/error/suspension clears the canvas, while late old-session cleanup cannot clear a new one. This adds a canvas conversion, is not zero-copy, and uses no per-frame CPU readback API.

Screen audio and remote control remain blocked in this development path until integrated. The agreed cutover completes those capabilities, runs consolidated acceptance, then removes replaced Rust video/audio commands, probes and residual callers. There is no permanent dual-engine UI or failure fallback.

## Explicit tests and acceptance boundaries

Normal Electron tests do **not** capture devices: `electron/obs-capture.test.cjs` skips its two real tests unless `LYCANSYNC_RUN_OBS_CAPTURE_TEST=1`. Real capture needs authorization for both selected content and the plugin side effects below. Tests use independent profiles, deny renderer network/device permissions, save numeric results but no frames/audio, and close only their owned processes.

From `apps/web`, additionally choose **one** mode and run only `node --test --test-name-pattern='OBS 真实来源纹理' electron/obs-capture.test.cjs`:

| Mode | Scope |
| --- | --- |
| `LYCANSYNC_CAPTURE_WINDOW_CHECK=1` | Two own GDI windows: equal titles, fresh colors, FPS changes, rename/refresh, minimize/restore, stop/reopen, close without takeover. |
| `LYCANSYNC_CAPTURE_GAME_CHECK=1` | Two own D3D11 swap chains, fixture-only activity mapping and the production game classifier/host path. Official hooks may inject only this owned process. |
| `LYCANSYNC_CAPTURE_APPLICATION_CHECK=1` | Dedicated browser fixture titles; optionally an explicitly authorized `LYCANSYNC_CAPTURE_APPLICATION_WINDOW_ID` for read-only existing-window capture. |
| `LYCANSYNC_CAPTURE_QUALITY_CHECK=1` | Authorized primary-monitor 60→30→120→60 changes. |
| `LYCANSYNC_CAPTURE_RESOURCE_CHECK=1` | Short primary-monitor resource comparison; optional `LYCANSYNC_CAPTURE_REFERENCE=rust` is test-only, never production fallback. |

Rebuild the reference media helper after private protocol changes with `cargo build --manifest-path native/media-helper/Cargo.toml --release --features shared-texture-output --target-dir release/build-cache/media-helper-compare`. The game mode also needs the normal release activity helper. Clear test variables afterwards. Running the **whole** device-test file also captures the primary monitor; a window-only authorization does not authorize that.

The native `cmake-build/test-tools/lycansync-bound-game-target-tests.exe` runs from prepared `bin/64bit`, creates its own hidden windows and tests markers/child/owned-popup/closure constraints without initializing OBS or injecting a process.

Earlier local checks passed ordinary windows, Edge main/popup and QQ. Two controlled D3D11 hook runs passed fresh pixels, 120/30/60/30/60 host timing and lifecycle, with first frames about 4.57/4.35 seconds. Those used a test-only routing override **before** product integration; that override is now removed. The integrated classifier/prepared bundle, commercial games, anti-cheat, audio/remote association, encoding/network, clean-machine and long-running performance remain **pending consolidated real acceptance**. Build and unit-test success do not imply acceptance or performance gains; host FPS is not distinct game frames or remote FPS. The existing one-off startup timeout remains under observation rather than hidden by retries.

## Plugin effects and redistribution

Initializing `win-capture`, even for a monitor, can update `%ProgramData%/obs-studio-hook`, run helper initialization, modify Vulkan implicit-layer files/registry entries and contact OBS's compatibility-update endpoint. Native networking is not governed by Electron session denial. Ordinary-window mode skips module initialization. Do not claim system neutrality simply because OBS's installation directory is untouched; do not force-replace occupied hooks or terminate unrelated programs.

The recompiled parent plugin does not inherit an official signature or guarantee anti-cheat support, even with unchanged official hook/helper binaries. The bundle retains OBS's GPL license and fixed complete source-archive reference. Corresponding source, third-party dependency licenses, distribution materials, update-network policy and clean-machine installation remain release checks. This is not a release-ready redistribution.
