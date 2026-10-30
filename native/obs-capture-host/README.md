# OBS capture host

This Windows x64 host requires **OBS Studio 32.2.2** exactly. Development and installed clients built from this revision use this single capture route, without Rust video/audio fallback. Older published installers are unchanged until a new release. Rust retains source identity and monitor remote-control authorization/input. Microphone capture runs in a separate audio-only OBS host, with the existing Sonora processing retained. Consolidated device acceptance is still pending; selecting the production route is not a performance or compatibility verdict.

## Build without starting capture

From the project root:

```powershell
./native/obs-capture-host/build.ps1
# After the verified archives are cached:
./native/obs-capture-host/build.ps1 -Offline
# Additionally compile the controlled window/game fixtures and identity tests:
./native/obs-capture-host/build.ps1 -Offline -BuildTestWindows
```

Restoring an archive preserves old source timestamps, so each native build cleans compiled objects before rebuilding. This prevents removed or restored registrations from silently retaining an older plugin binary. The script uses existing Visual Studio x64 C++ Build Tools, Windows SDK and Rust/Cargo (2024 edition). It downloads to project-local `release/build-cache/obs-32.2.2`, verifies SHA-256, extracts the required files and builds with CMake. It does not install system components, initialize OBS, start capture or replace the user's OBS installation. No Qt, OBS UI or browser plugins are included. The fixed official FFmpeg muxer and NVENC/QSV/AMF encoder modules support local recording; they load only when recording is requested.

The official Windows ZIP has no development SDK. The script uses matching public headers and generates import libraries from actual fixed DLL exports; it does not invent an upstream CMake package. The fixed upstream `win-capture` source is rebuilt with narrow exact-window patches for both game and ordinary-window sources. The same-version `win-wasapi` source is also rebuilt with exact-process binding and capture-status reporting. Official graphics-hook DLLs and injection helpers are **not** recompiled.

The window patch also checks the real GDI DC and BitBlt result before marking a frame as written. A copy failure invalidates the current frame and latches the existing source-failure state, so the host stops delivery instead of treating old texture contents as a new frame. Only the first failure emits a fixed warning. This check does not establish that pixels from a successful BitBlt operation are always isolated; unexplained contamination still requires reproduction.

Pinned archives:

| Archive | SHA-256 |
| --- | --- |
| OBS 32.2.2 source | `ec81fb66b03e75ddb3076b576f62679c39262e0e9960cef3e17a40dc5d68e6b4` |
| OBS 32.2.2 Windows x64 runtime | `4d6e40e3ab155f56b30de517380566a206d74b63cdf5ad49aa596924768f97e1` |
| OBS Windows build dependencies 2026-07-15 x64 | `6f90e9598fa10cff5ad23cdcfae49b87868c07bf896b02cd464582b4ce2f2ba9` |

Source/runtime archives come from the [fixed official release](https://github.com/obsproject/obs-studio/releases/tag/32.2.2). The 66,679,471-byte dependency ZIP comes from the release URL recorded in that verified source's `CMakePresets.json`. Only needed headers/import libraries, Jansson's library and license files are extracted. Each build restores the verified upstream source before applying the local patch with `git apply --recount --whitespace=error-all`. Only diff context formatting is exempted from Git's source-whitespace checks.

The prepared runtime is `release/build-cache/obs-32.2.2/prepared`. It contains one `obs-plugins/64bit/win-capture.dll`: the project-built exact-window plugin. The original upstream plugin is not copied back by a default build, and the old optional game-plugin switch is removed. Test executables stay under `cmake-build/test-tools`, outside default builds and runtime packaging. Build manifests record archive, patch, build-input and binary hashes, compiler, size and resolved static imports. `runtimeExecuted: false` describes the build script, not separately authorized tests. Each build resets `redistributionReady` to false; source packaging must verify the materials again.

## Screen audio and lifecycle

The prepared `obs-plugins/64bit/win-wasapi.dll` is the only audio plugin build. The host loads it on the first shared-audio request, not for video-only sharing. Module/data paths are the `win-wasapi` siblings of the configured `win-capture` paths; no extra environment switches are required. Existing installed clients, microphone capture, UI preferences and server APIs are unchanged. Desktop/helper builds must stay together; there is no older protocol compatibility branch.

- `lycansync_process_output_capture` requires the selected HWND, original process instance and Rust-owned lifetime event, or an explicit process to exclude for monitor sharing. It holds the original process object and rechecks the read-only lifetime and original process before delivering captured packets. It never resolves another window by title/class/executable and never falls back to system mix.
- Monitor process mode is configured to exclude the trusted Electron main-process tree, including received room audio. The manager supplies its own PID, not renderer input; actual exclusion still needs listening acceptance. `lycansync_system_output_capture` is only for the existing explicitly consented old-Windows system-mix mode. Electron retains the current capability and preference policy; the host independently rejects a broader system-mix request on a process-capable OS.
- The private `lycansync_audio_status` procedure (binding version 1) reports state `0` waiting, `1` initialized and capture started, or `2` failed. Source creation alone is not success; silence does not imply failure. Failures are latched, with no title rematch or automatic reconnect. A default-device change invalidates system mix rather than silently changing devices. Packet/frame/silence counters are native source counters, not pipe delivery or remote playback.
- The official microphone input source is registered for the separate audio-only host; output-source failure latching does not disable input-device recovery. WASAPI capture and format handling remain fixed upstream code, not another self-written capture engine. The narrow patch and built binary hashes have a separate `cmake-build/audio-plugin/build-manifest.json`.

`audioStart:<audio-id>:<process|systemMix>:<client-pid>` / `audioStop:<audio-id>` and `audioStarted` / `audioFailed` / `audioStopped` are private host messages. Each attempt uses the main process's fresh pipe UUID, in addition to the video session ID; late replies cannot resurrect or stop another attempt. Electron returns a format only after the native source reports a real successful start. Source initialization has an eight-second deadline and the manager a ten-second start deadline; silence is not a startup failure. Audio start timeout requests cleanup without killing video.

libobs resamples the source to its configured 48 kHz stereo planar-float format. The source callback only interleaves samples into 480-frame packets and a preallocated 12-packet queue, dropping the oldest full packet when overloaded. A separate worker writes the existing little-endian frame-count + stereo float32 pipe protocol with cancelable overlapped I/O; callbacks never wait on the pipe. The page still uses `NativeScreenAudioSession` and its existing AudioWorklet/LiveKit track, not a second audio graph or local speaker. No frames/audio are saved and no per-packet logs are added.

Stop immediately cuts main-process delivery and invalidates the native PCM queue, then removes the callback and source, waits for libobs's destruction queue (including WASAPI cleanup), and acknowledges. The audio-stop command/video thread does not wait on source destruction. An unconfirmed three-second audio stop rejects and blocks another audio attempt, but does not kill the usable video host; a late matching cleanup ACK or host exit releases that blocker. Whole-share stop confirms capture cleanup before releasing Rust identity; process termination remains the bounded cleanup path if that acknowledgement never arrives. Audio failure closes only shared audio and retains video, microphone and remote-control association; quality switching retains the same source/audio worker.

The existing diagnostic request now includes the OBS source's audio state, **original source** sample rate/channels, packet/frame/silence counters and the native output queue's dropped chunks. The pipe format stays 48 kHz stereo even when a system-mix source is, for example, 44.1 kHz multichannel. Main/page queue drops are added separately by the existing projection; these counters do not prove converted frames were published or heard remotely. No new page sampling timer or report schema is introduced. After stop, final counters may remain with an explicit idle state.

After `-BuildTestWindows`, identity and synthetic PCM tests can run without OBS initialization, plugins or audio devices:

```powershell
$env:PATH = "$(Resolve-Path release/build-cache/obs-32.2.2/prepared/bin/64bit);$env:PATH"
& ./release/build-cache/obs-32.2.2/cmake-build/test-tools/lycansync-bound-audio-target-tests.exe
& ./release/build-cache/obs-32.2.2/cmake-build/test-tools/lycansync-bound-game-target-tests.exe
& ./release/build-cache/obs-32.2.2/cmake-build/test-tools/lycansync-screen-audio-pcm-tests.exe
```

They create only their own hidden fixture windows; the audio identity test also starts one short-lived copy of itself that waits for an event, proving an exited process is no longer valid. They do not prove capture, loopback exclusion, audible output, startup/stop timing or synchronization; those require consolidated device acceptance after wiring.

## Production and development paths

Run `npm run build:desktop` from `apps/web` after the verified OBS archives are cached. Development reads the fixed prepared directory; installed clients read `resources/obs-capture`. There is no engine environment switch.


The parent starts the host in its `bin/64bit` directory because libobs locates core effects by relative path. Writable configuration belongs to Electron user-data `obs-capture/32.2.2`, not the runtime bundle. Missing resources explicitly fail rather than starting another engine.

## Source selection and identity

### Host reuse and preparation

The host accepts only fixed module/data/config directories on its command line. `coreReady` confirms core initialization; `prepare` initializes the small 320x180, 1 FPS graphics context and fixed capture plugin, without creating a capture source or WASAPI device. `enginePrepared` is not a first-frame or publication acknowledgement. Main-window entry requests core preparation once; opening the picker requests graphics preparation concurrently with source enumeration. A background failure is recorded once and disables automatic retries for that application run; explicit sharing may retry using the same implementation.

`start|...` supplies the validated source instance and requested quality. Capture acknowledgements and slot releases include the capture session ID, so reuse never reassigns old callbacks to the new source. `stop:<session>` shuts down shared audio, removes the render callback/source/scene, releases shared textures and waits for libobs destruction before acknowledging. It then returns video to the small idle configuration. An unconfirmed stop escalates to process termination; unconfirmed termination retains the blocker. Idle reuse lasts three minutes, while active capture cancels that timer. Application disposal permanently prevents pending preparation from recreating the host.

The capture plugin initializes its existing hook files and graphics-offset helpers during graphics preparation, including when the eventual source is an ordinary window. No game/window capture source is created until confirmation. The existing plugin side effects are therefore moved earlier, not eliminated. Idle graphics still has a rendering thread; real startup, idle-memory/CPU and repeated-start measurements remain pending. Client and host must be rebuilt together; the old per-capture process CLI is not retained.

The existing picker remains unchanged; users do not choose a capture API.

- Monitors use OBS's monitor source and a validated device name, never an opaque source-ID suffix as an OS monitor index.
- Ordinary windows use the patched official `lycansync_window_capture` source with upstream automatic BitBlt/WGC selection, with the selected HWND and lifetime binding rather than title/class/executable rematching. The source captures the client area and disables the built-in audio child source. The previous direct WinRT input adapter is removed.
- Recognized games without a privilege mismatch use the patched `lycansync_game_capture` source. The media helper privately returns the selected window's executable after checking the instance before and after reading its path. The existing activity helper classifies **that executable** using Steam/Epic install catalogs, League's match process and current-account manual mappings. Known launchers, music players and League's browser-based lobby do not enter game capture merely because they have activity status. An unrecognized application uses ordinary-window capture; a failed classification is an error, not a guess.

Classification queries do not enumerate windows or change published activity. The executable is stripped before host startup, never exposed to the renderer or anonymous report. The existing activity scan remains independent of capture resources. Configuration/stop changes invalidate pending classification results; late results cannot start capture or close a newer session.

Rust reserves the selected monitor or exact window lifetime in its existing video session, without starting a capture worker. The private command is now only `reserveVideo`/`videoReserved` with a tagged monitor/window target; the old window-only command and untagged response are rejected, not retained as aliases. Monitors pass their validated device name; window targets include the executable, lifetime event name, original process ID/creation time and whether the permission difference requires non-injecting window capture. The host start command has twelve fields after `start|`, ending with the original process creation time. Removed marker fields are not retained as aliases. Client and helper must be built together. List refresh does not release the reservation. The host checks window instances before source creation and before/after GPU delivery; a closed/replaced window ends capture without selecting a different window or monitor. Stop confirms OBS capture destruction or process termination **before** releasing Rust's reservation. Unconfirmed termination keeps the reservation and blocks another capture.

One helper thread observes window-destruction events out of process; it never writes a property into the target window or injects a hook. Each registered lifetime owns a manual-reset kernel event, signaled on observed destruction, release or observer shutdown and never reset. Window/game/audio share the same native validator: event names bind the exact HWND and original helper process, process creation times are checked when opening process objects, and the event is opened with `SYNCHRONIZE` only. Helper exit invalidates the binding even if a reader remains. Handles follow source lifetime; two registry snapshots plus one active share bound the events. Higher-integrity targets automatically enter the ordinary-window path before game classification; explicit user choices remain explicit. No screen-cropping fallback or quality downgrade is introduced. Elevated-window notifications, rapid recreation, fresh WGC frames and audio remain pending real-device acceptance.

Only a successfully started, current monitor share can receive remote-control authorization. Window/game shares cannot obtain monitor control. Rust still owns the authoritative grant, selected monitor, sequence/rate checks and held-input cleanup; OBS owns shared video/audio. Starting/stopping sessions reject authorization and input before waiting for asynchronous cleanup. Stop first revokes input and releases held keys, then closes OBS, then releases the reservation. A revoke failure still permits the remaining video cleanup, but is reported rather than converted into success. Stop and late authorization replies cannot restore permission; an invalid monitor is rejected and the existing grant revoked before injection.

The stock game query exposes titles, not HWNDs. The fixed-source patch adds `lycansync_get_target` ABI 2 (selected HWND, actual drawing HWND, hooked and valid), disables foreground/fullscreen/hotkey target selection, and guards hook initialization/ticking/rendering/dimensions. Drawing children of the selected window are allowed; another top-level or owned popup is not. The host validates this public query rather than reading a precompiled DLL's private structure. A mismatch remains latched after stopping the plugin so it cannot become an apparent first-frame wait. Neither classifier nor game-source failure falls back to ordinary-window, monitor or Rust capture.

The picker keeps advanced controls collapsed and offers auto/game only. Auto retains the existing game classifier and passes ordinary windows to fixed OBS method 0. The upstream rule selects BitBlt or WGC from the actual selected window class and runtime support when creating the source. It does not trial several captures or inspect pixels to guess success. WGC border display is explained before confirmation: the source attempts to hide it where supported, but the confirmed selection permits the system border. BitBlt does not use a WGC border. No per-application permission preference is saved and there is no fail/reselect/allow-border flow. Monitor capture remains DXGI.

Minimized/hidden windows reuse suspension notifications and separately counted placeholders. WGC capability checks run before the source enters a scene. Ordinary-window sharing allows a system border after the picker explains this before confirmation; unsupported cursor settings and unavailable runtime still fail explicitly. There is no parallel trial capture, pixel-based black-frame detection or monitor cropping. Requested/actual method, border permission and client-area scope use existing bounded diagnostic events; historical rejection reasons remain readable in old logs.

While native video capture owns the main renderer, Electron background throttling is temporarily disabled so minimizing the UI does not throttle its texture receiver and canvas copy. Confirmed stop or failed-start cleanup restores the previous value. This reduces one background scheduling risk but does not prove the cause of an earlier transfer timeout. Electron's fixed transfer timeout still stops capture safely rather than retrying a possibly in-flight texture. Failure events include bounded renderer/window state flags; they do not include window titles or URLs.

Ordinary-window binding ABI 2 reports the selected/captured HWND, actual method, validity, runtime availability and initialization failure. Plugin ticking, dimensions and rendering validate the original instance; rebuilding capture never searches for a replacement. Host queries validate that ABI without reading private plugin memory. A target closing during the query remains a normal end; another window or mismatched ABI is an error. Actual Win10/11 capture, border permissions and performance still require acceptance.

Shared audio remains independently owned. The host reuses the OBS-owned `win-wasapi` module across captures rather than repeatedly opening and registering it in a warmed process; callbacks, sources and audio queues still stop with each share.

### Monitor DXGI selection and evidence

Monitor sharing explicitly selects DXGI. Before capture, the host resolves the selected attached monitor to its adapter and checks the actual graphics device LUID and OBS output index. A prewarmed-device mismatch asks Electron to rebuild the host once, after the old process has confirmed exit; cancellation or unconfirmed exit blocks the restart. LUIDs and monitor names are not included in exported diagnostics.

The fixed upstream `libobs-d3d11` is rebuilt with `patches/dxgi-output-compat.patch`. Only `DXGI_ERROR_UNSUPPORTED` from `DuplicateOutput1` uses OBS's existing standard `DuplicateOutput` branch; other failures remain explicit. This remains DXGI, without WGC fallback, scope expansion or quality downgrade. The standard API supplies SDR BGRA rather than the extended HDR format path. The prepared DLL replaces the official graphics DLL, and build inputs and hashes are included in corresponding-source materials.

Once per session, structured diagnostics record configuration, first render callback and first nonzero source dimensions, with actual DXGI API when known. A render callback alone is not a delivered frame. Stop records capture acknowledgement separately from graceful, forced or unexpected host exit. `obs_wait_for_destroy_queue` waits before acknowledgement; its boolean only says whether tasks were processed during the wait, not whether cleanup succeeded. An empty queue must not be reported as failure. Hung cleanup remains bounded by the existing parent-process termination deadline.

## Frames, configuration and cleanup

Startup additionally records graphics preparation started/completed and source creation started, once per attempt. These distinguish a pre-source timeout from missing source dimensions or frame delivery, without enabling broad upstream debug logs.

The existing diagnostic request also reads libobs render-loop counters, active FPS and average render time. Counters include missed time slots; interval render FPS uses `(delta total - delta lagged) / native monotonic seconds`, not total slots alone. Each video reset, including rollback, increments a session-local configuration number. OBS's approximately one-second rolling averages remain unknown for the first two seconds of the new configuration. The page re-establishes baselines after configuration/session changes, suspension, counter reset or read failure, and preserves zero-frame intervals. Render-loop metrics do not measure unique source frames, encoding or end-to-end delay; no additional timer or per-frame logging is used.

OBS renders at the selected 2560×1440 / 1920×1080 / 1280×720 cap and 30/60/120 FPS target. Source aspect ratio is preserved without upscaling small sources; `contentSize` identifies the top-left content inside the canvas. Same-session `obs_reset_video` preserves source, process and page track. Rendering pauses while the three bounded texture slots are returned. A dimension change rebuilds the pool; an FPS-only change preserves the returned same-device textures, including on rollback. Command processing continues during the drain so release acknowledgements cannot deadlock behind configuration. Success acknowledges applied dimensions and FPS, not measured performance. A rejected reset attempts the previous configuration; failed rollback or an uncertain three-second timeout ends capture without automatic retry. The page may temporarily request 30 FPS for confirmed thumbnail-only demand without changing saved user quality; render configuration IDs still change and require a new diagnostic baseline. Resource savings, restoration time and custom 1440p/120 performance still require real-device acceptance.

The host copies the OBS main texture into three bounded BGRA shared-NT GPU slots. Each has a keyed mutex; D3D11 event-query completion and mutex release precede announcement. Initial zero source dimensions do not count as a first frame. Full slots drop an update rather than allocate more textures or queue indefinitely. Stdout carries only the protocol; warnings/errors go to stderr. Existing bounded low-frequency diagnostics read actual counters even when delivery is blocked.

GPU completion distinguishes ready (`S_OK`), not ready (`S_FALSE`) and actual failures. A 250 ms copy-query timeout skips that frame and keeps the slot excluded from reuse until a later render callback observes completion. It never announces an unfinished or stale skipped frame, overwrites an in-flight query, grows the three slots or adds a polling timer. Key acquisition is non-blocking and rotates eligible slots. A query that stays pending, or mutex contention without progress, for five seconds remains a failure; device/query and mutex-release errors remain fatal with HRESULT evidence. Deferred copies are host-only after mutex release; resizing/stopping releases their references through D3D11 deferred destruction, while imported consumer slots still require the normal release acknowledgement. The first temporary wait records one `obsGpuFrameDeferred` event per share; bridge-drop counters include slot pressure and skipped GPU waits. Real contention and recovery still require device acceptance.

Electron validates the child identity before duplicating handles. A slot is returned only after all imported references are released. Transfers pending Electron acknowledgement retain the main reference, avoiding premature release on stop or rejection. Preload snapshots imported frames through one session-owned OffscreenCanvas because direct external frames stalled the tested generated-track path. The input/import belongs to preload, the transferred copy to the page; matching stop/error/suspension clears the canvas, while late old-session cleanup cannot clear a new one. This adds a canvas conversion, is not zero-copy, and uses no per-frame CPU readback API.

OBS sharing does not start a Rust screen-audio worker. The old Rust video/shared-audio commands, workers and probes have been removed for the agreed formal cutover; consolidated audio/video/remote-control device acceptance remains pending. Rust's retained source identity and input injection are not a second video engine. There is no dual-engine UI or failure fallback.

## Explicit tests and acceptance boundaries

Normal Electron tests do **not** capture devices: `electron/obs-capture.test.cjs` skips its two real tests unless `LYCANSYNC_RUN_OBS_CAPTURE_TEST=1`. Real capture needs authorization for both selected content and the plugin side effects below. Tests use independent profiles, deny renderer network/device permissions, save numeric results but no frames/audio, and close only their owned processes.

From `apps/web`, additionally choose **one** mode and run only `node --test --test-name-pattern='OBS 真实来源纹理' electron/obs-capture.test.cjs`:

| Mode | Scope |
| --- | --- |
| `LYCANSYNC_CAPTURE_WINDOW_CHECK=1` | Two own GDI windows: equal titles, fresh colors, FPS changes, rename/refresh, minimize/restore, stop/reopen, close without takeover. |
| `LYCANSYNC_CAPTURE_GAME_CHECK=1` | Two own D3D11 swap chains, fixture-only activity mapping and the production game classifier/host path. Official hooks may inject only this owned process. |
| `LYCANSYNC_CAPTURE_APPLICATION_CHECK=1` | Dedicated browser fixture titles; optionally an explicitly authorized `LYCANSYNC_CAPTURE_APPLICATION_WINDOW_ID` for read-only existing-window capture. |
| `LYCANSYNC_CAPTURE_QUALITY_CHECK=1` | Authorized primary-monitor 1080p60 → 1440p60/120 → 720p30 → 1080p60 changes, fresh pixels and actual content dimensions. An unconnected local sender exercises parameter APIs; this does not measure encoding or remote playback. |
| `LYCANSYNC_CAPTURE_RESOURCE_CHECK=1` | Short authorized primary-monitor resource measurement of the sole OBS route. |
| `LYCANSYNC_CAPTURE_STARTUP_CHECK=1` | Primary-monitor cold/prewarmed/restart checks at 1080p60 and a 1440p120 cap, fresh color transitions, render statistics and acknowledged stop. |

The startup check requires its own color marker to be visible on the primary desktop. It checks the marker's topmost window before each case and reports `testMarkerOccluded` instead of starting that case when another window covers it. A pixel timeout additionally records only the fixed test-point color and frame counters, not a screenshot or other window identity. Do not move/close unrelated windows automatically or count an occluded test as passed. The original startup timeout still requires separate evidence; a later occlusion does not explain an earlier pre-source hang.

Build the production media helper with `npm run build:media`. Resource checks include the separate Rust identity helper alongside OBS/Electron; working sets remain separate and are not summed as physical memory. Clear test variables afterwards. Running the whole device-test file also captures the primary monitor; window-only authorization does not authorize that.

The native `cmake-build/test-tools/lycansync-bound-game-target-tests.exe` runs from prepared `bin/64bit`, creates its own hidden windows and tests lifetime events, process instances, child/owned-popup and closure constraints without initializing OBS or injecting a process.

Earlier local checks passed ordinary windows, Edge main/popup and QQ. Two controlled D3D11 hook runs passed fresh pixels, 120/30/60/30/60 host timing and lifecycle, with first frames about 4.57/4.35 seconds. Those used a test-only routing override **before** product integration; that override is now removed. The integrated classifier/prepared bundle, commercial games, anti-cheat, audio/remote association, encoding/network, clean-machine and long-running performance remain **pending consolidated real acceptance**. Build and unit-test success do not imply acceptance or performance gains; host FPS is not distinct game frames or remote FPS. The existing one-off startup timeout remains under observation rather than hidden by retries.

## DXGI window-crop feasibility probe

`lycansync-dxgi-window-probe` is an explicitly built test tool, excluded from the default build and installed runtime. It is **not** a capture candidate or an automatic-mode fallback. It does not initialize OBS, load capture plugins, publish media or save images. Build it with:

```powershell
cmake --build release/build-cache/obs-32.2.2/cmake-build --config Release --target lycansync-dxgi-window-probe
./release/build-cache/obs-32.2.2/cmake-build/test-tools/lycansync-dxgi-window-probe.exe --self-test
```

`--self-test` only checks synthetic marker pixels and padded row stride, without creating windows or a graphics device. Running without an explicit mode fails without capture. The separate `--run-controlled-windows` mode requires user authorization: it creates two nonactivating 320×180 color windows on the primary monitor, briefly covers its own green target with magenta, then removes the cover. It does not send keyboard/mouse input or change existing application windows. It requires a desktop-attached, unrotated output and a BGRA surface; unsupported or interrupted runs report an error rather than success. CPU readback is restricted to the fixture's center 16×16 pixels; the underlying DXGI resource is still a desktop image on the GPU.

This deliberately schedules an occluder between the initial and final visibility checks, correlating its marker with the desktop frame's `LastPresentTime`. The JSON result describes whether a naive before/after gate would accept foreign pixels. `productionApproved` is always false: even an inconclusive run cannot approve window cropping. The experiment diagnoses a race, not performance or production privacy. Its `DwmFlush` is only for the two owned windows and must not be treated as synchronization with other applications. The installed OBS renderer currently does not expose original DXGI presentation timestamps through its monitor-source interface; adding a rectangle crop alone does not resolve that boundary.

`--run-event-delay` is a separate explicitly authorized device mode using the same two fixture windows. A dedicated observer subscribes only to the current test process's overlay show/hide events, initially holds its message loop, then resumes after the final visibility decision. The result records event generations before/at the decision and after draining, plus whether callback delivery followed that decision. It tests whether unchanged **delivered** event counts can miss queued changes. Missing expected events, an observer timeout or a failed hook makes the experiment inconclusive and returns failure. The observer unhooks on its own thread and joins before fixture destruction; no DLL is injected. This mode also always reports `productionApproved: false`.

## Plugin effects and redistribution

Initializing `win-capture`, even for a monitor, can update `%ProgramData%/obs-studio-hook`, run helper initialization, modify Vulkan implicit-layer files/registry entries and contact OBS's compatibility-update endpoint. Native networking is not governed by Electron session denial. Graphics preparation initializes this shared plugin before source selection, so these effects can also occur when the user later chooses an ordinary window. Do not claim system neutrality simply because OBS's installation directory is untouched; do not force-replace occupied hooks or terminate unrelated programs.

The recompiled plugin does not inherit an official signature or guarantee anti-cheat support, even with unchanged official hook/helper binaries. This directory is GPL-2.0-or-later (see LICENSE.md and COPYING), without relicensing the rest of the project. The build collects OBS and dependency licenses; source packaging additionally includes FFmpeg's GPL v3 text because the pinned build enables version3. The official plugin compatibility updater retains its upstream network behavior described above; it is not an Electron-controlled update or another capture route. Clean-machine installation, signatures and anti-cheat compatibility remain real-device checks.

Before the first installer build, cache the pinned corresponding sources (curl respects `HTTPS_PROXY` if the network requires one):

```powershell
node native/obs-capture-host/package-source.cjs --download
```

`sources.lock.json` records exact upstream archives, dependency recipe revisions, SHA-256 and byte sizes, including the MbedTLS framework submodule. `npm --prefix apps/web run package:desktop` builds the runtime, then verifies and bundles these archives with this host's complete source/build files as `release/desktop/LycanSync-VERSION-obs-source.tar.gz`. See [source rebuilding instructions](SOURCE_BUILD.md). It binds the source archive to the application version and current runtime file hashes; missing/changed source, runtime or archive files reject packaging. Only a successfully generated matching source bundle sets `redistributionReady`; the installer independently checks its hash. Publish this versioned source bundle and third-party notices at the same download location as the installer, before publishing `latest.yml`. No application, device or OBS runtime is started by this step.

## Fixed capture module updates

The hosted win-capture module uses the bundled compatibility table. `offline-capture-module.patch` removes its independent download thread, and CMake excludes the file updater and curl link. Runtime dependency inspection rejects HTTP updater libraries in this plugin. Client updates remain owned by the application's update service. OBS hook-file and Vulkan initialization still have the separately documented system effects.

## Independent microphone host

`lycansync-obs-audio-host.exe` loads only libobs and the fixed WASAPI module. It configures 48 kHz mono audio without initializing video, a GPU device, win-capture or game hooks. A default communications input source feeds the `lycansync_voice_processing` filter, statically linked to pinned Sonora 0.2.0. The original noise suppression, AGC2, high-pass and post-processing user gain are preserved; Chromium receives the processed PCM through the existing mono worklet and LiveKit track. There is no Rust microphone capture or desktop fallback.

The processor adapts variable OBS blocks with a bounded 480-frame staging buffer, adding one 10 ms block of processing latency without dropping tails. This is not a measured end-to-end delay. Audio callback queues retain at most twelve 10 ms packets; pipe writes run separately and are cancelable. Default-device reconnect remains the upstream WASAPI behavior. Silence produces valid PCM; absent PCM after readiness has an eight-second recovery deadline and then an explicit failure.

Ready requires an actual PCM pipe delivery. The private command stream accepts configure, statistics and stop only, bounded to 256 bytes per line. Startup cancellation requests stop immediately. Stop acknowledgement follows source cleanup, and Electron also confirms process exit; unconfirmed termination blocks replacement. Diagnostics timeouts do not stop a working microphone. No device names, IDs or raw WASAPI messages enter exported reports.

`cargo test --manifest-path native/obs-capture-host/audio-processing/Cargo.toml` validates processing without opening a device. Manager and bridge tests use simulated child processes. Actual input, USB/Bluetooth recovery, microphone tests and simultaneous video lifecycle still require consolidated device acceptance. The corresponding source bundle includes Cargo.lock and vendored dependency sources/licenses; the installer includes their notices.


## Local recording

The video host records the existing authorized source through the official `ffmpeg_muxer`, hardware H.264 (current graphics adapter preferred) and AAC. It does not create another capture source or reuse the network-encoded WebRTC stream. Recommended constant-quality settings and MKV are fixed in the first version. Each segment fits the source's initial aspect ratio within the selected sharing resolution without upscaling; libobs aligns width to four pixels and height to two. A recording-only scene/view centers and fits later source resizes within that fixed segment size, avoiding the unused right/bottom area of the sharing canvas. This adds bounded GPU composition/conversion only during recording; the main-render callback excludes auxiliary views from shared-texture delivery and counts. Releasing recording first detaches encoders, then removes the auxiliary view and scene. Recording uses the requested FPS and NV12/Rec.709; shared-texture delivery remains BGRA without idle NV12 conversion. Real encoder availability, timing, color and resource cost remain device acceptance items.

Application audio is the same exact-process WASAPI source, attached to recording mix 0 only while needed. System-mix audio is rejected because it cannot reliably exclude friends' voices; monitor recordings use the existing process-exclusion loopback to capture other applications while excluding the LycanSync process tree. Only systems limited to system-mix capture must disable application audio. Optional own processed microphone and subscribed friends' microphone tracks are borrowed in the renderer, mixed by one bounded worklet/PCM pipe into a recording-only OBS source. Remote screen-share audio tracks are never selected. Stopping this consumer closes only its graph/pipe, not the borrowed media tracks or the independent microphone host.

The main process owns paths and a unique MKV file per segment. Defaults are install `data/recordings`, application audio on, both voice options off, and manual start. Source/quality changes finish the prior output before a new segment; closing the source or stopping sharing ends recording. Output stop acknowledgements include actual video-frame counts; header-only files are not reported as saved. Errors preserve partial files and keep sharing available. Stop timeouts block another recording until late confirmation or host exit. Disk failures, phases, bytes and frame counts use the existing bounded diagnostic log, excluding file paths, PCM and member identity.

The command reader wakes immediately for texture-slot releases. Recording callbacks only mark completion; command-thread maintenance emits events and releases output resources, avoiding callback-thread teardown. No sampling or encoder module loading runs during idle prewarm. Offline lifecycle/pipe/worklet tests do not prove a playable recording or microphone synchronization.

## Ordinary-window pixel isolation

Ordinary-window auto requests upstream method 0. The host reports the actual BitBlt/WGC selection; Electron requires that method before accepting frames and rejects a method change within the session. Exact window binding, original process lifetime and client-area scope remain enforced in both paths. Local recording reads that same source, not a second capture. Binding the correct HWND alone does not prove pixel isolation; controlled fixture success does not settle the earlier affected-application report. Existing game capture, monitor DXGI and independent audio remain unchanged. Unsupported settings never authorize desktop capture.

The optional `lycansync-window-isolation-test` target uses two temporary solid-color windows and reads only their central 16×16 pixels in memory. It checks automatic BitBlt/WGC selection, fresh updates under full occlusion, restoration, rename, minimize/restore, stop/reopen and no takeover after closure with a same-title replacement. Its executable is excluded from runtime packages. The production pipeline fixture uses `LYCANSYNC_CAPTURE_WINDOW_CHECK=1`; adding `LYCANSYNC_CAPTURE_WINDOW_WGC=1` changes only its window class so upstream auto selects WGC, without forcing the production method. Alternatively, `LYCANSYNC_CAPTURE_WINDOW_MIXED=1` creates two different classes and checks BitBlt → WGC → BitBlt with the same retained host and distinct pixels. These options are test-only. Run the window-only test by name rather than the whole device-test file. A passing controlled test does not replace installed-client acceptance with the affected application.

The microphone host verifies the registered input type and fixed status interface before accepting a source. A non-null libobs source may still be an unavailable placeholder, so creation alone is insufficient. Diagnostics retain source frames separately from host-received frames, fixed failure codes, whitelisted HRESULTs and exit codes; device names and raw OBS messages are not exported.
