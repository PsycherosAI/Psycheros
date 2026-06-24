# Changelog

All notable changes to the Psycheros desktop launcher are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/), and this package
follows [Semantic Versioning](https://semver.org/). It is pre-1.0 until
cross-platform supervisors ship.

## [0.2.38] - 2026-06-23

### Fixed

- macOS mic-capture diagnostics now write to `/tmp/psycheros-mic-capture.log` in
  addition to stderr. macOS doesn't route Finder-launched GUI app stderr to
  Console.app (only `os_log` calls reach it), so the `eprintln!` tracing added
  in 0.2.37 was invisible after double-click launches — it went to `/dev/null`.
  A `std::panic::set_hook` installed in `run()` also records the panic message,
  thread ID, and source location to the same file before the default abort
  handler fires. macOS crash reports capture the abort but not the Rust panic
  that triggered it; this hook fills that gap (foreign ObjC exceptions still
  abort, but the hook runs first). Purely additive — no behavioral change.

## [0.2.39] - 2026-06-24

### Fixed

- macOS mic-capture diagnostics now include granular step-by-step logging at
  every AVAudioEngine call in `start_capture`: permission request, engine
  creation, input node, format setup, tap installation, prepare, and start. Each
  step logs to `/tmp/psycheros-mic-capture.log` so crashes can be isolated to
  the exact AVAudioEngine method throwing the foreign ObjC exception. Purely
  additive — no behavioral change.

## [0.2.40] - 2026-06-24

### Fixed

- macOS mic-capture no longer crashes on start. The crash log from 0.2.39
  pinpointed the failure to `installTapOnBus_bufferSize_format_block` — Apple
  throws `NSInvalidArgumentException` when the tap format doesn't match the
  input node's output format. We were requesting 16kHz Float32 on a hardware
  input node that runs at 48kHz. The fix queries the hardware's actual format
  via `outputFormatForBus(0)` and decimates in Rust to ~16kHz (take every Nth
  sample) — same algorithm the original JS path used. Mic capture now works on
  all Macs regardless of native sample rate.

## [0.2.41] - 2026-06-24

### Fixed

- macOS mic-capture now correctly resamples audio at any hardware sample rate,
  not just 48kHz. The integer decimation from 0.2.40 only handled 48kHz cleanly;
  at 24kHz (which AVAudioEngine hands out for some AirPods configurations) it
  shipped audio at the wrong rate, which would have produced garbage
  speech-to-text. Switched to linear interpolation with a float ratio — works
  for 48kHz, 44.1kHz, 32kHz, 24kHz, and 16kHz hardware formats. Also adds a
  defensive bounds check to skip empty buffers and avoid reading past the input.

## [Unreleased]

## [0.2.37] - 2026-06-23

### Fixed

- Added debug tracing to macOS audio capture: thread IDs, step-by-step teardown
  logging, and completion signals for `start_capture`, `stop_capture`, and
  `stop_engine_and_remove_tap`. Diagnoses potential tokio thread-hopping bugs
  where `AVAudioEngine` methods are called from different threads (Apple
  requires same-thread access). No functional change — pure diagnostic output.

## [0.2.36] - 2026-06-22

### Fixed

- macOS audio capture no longer crashes the app when stopping. The teardown
  order in `stop_capture` was reversed — the tap block was removed while
  `AVAudioEngine` was still running, so an in-flight audio callback could access
  the freed tap block (use-after-free), crashing the entire Tauri process. The
  engine is now stopped first (`engine.stop()` is synchronous; once it returns
  no more callbacks fire), then the tap is removed. Per Apple's `AVAudioEngine`
  guidance. No change on Windows/Linux (function is
  `#[cfg(target_os = "macos")]`-gated).

## [0.2.35] - 2026-06-22

### Fixed

- Fixed `entitlements.plist` XML syntax error that broke macOS code-signing in
  0.2.34. The plist contained `--` (double-hyphen) inside an XML comment
  (`--jitless`), which is illegal per the XML spec and caused
  `AMFIUnserializeXML: syntax error near line 41` during `codesign`. The Rust
  binary compiled fine; only the signing step failed. Comments have been
  stripped from the entitlements file entirely — the five entitlement keys
  (allow-jit, allow-unsigned-executable-memory, disable-library-validation,
  allow-dyld-environment-variables, device.audio-input) are unchanged.

## [0.2.34] - 2026-06-22

### Fixed

- Added `com.apple.security.device.audio-input` to the app's Hardened Runtime
  entitlements. macOS silently blocks microphone access under Hardened Runtime
  unless this entitlement is present — `AVCaptureDevice.requestAccess` returns
  `granted=false` immediately and the app never appears in System Settings →
  Privacy & Security → Microphone. Entitlements are now declared in a new
  `src-tauri/entitlements.plist` (standard Tauri 2 set for ad-hoc signed apps
  plus audio-input), wired via `bundle.macOS.entitlements` in `tauri.conf.json`.
  No Rust changes; purely code-sign configuration.

## [0.2.33] - 2026-06-22

### Reverted

- Reverted the `AVCaptureDevice` authorization status probes added in 0.2.31
  (commit `ccfbb59`). The mic-capture permission code is back to the simpler
  0.2.30 form that calls `requestAccessForMediaType` directly without
  pre-probing. This revert was prompted by a Tahoe compatibility regression
  reported in testing: the Tahoe compat switch (which applies `--jitless` and
  `--sandbox=off` V8 flags to the daemon) stopped working after 0.2.31, causing
  the V8 "Failed to reserve virtual memory for CodeRange" crash to return. The
  mic-capture code and the Tahoe compat switch are in separate files and there
  is no obvious code-level connection; reverting eliminates the variable to
  confirm whether the probe code was the trigger.

## [0.2.32] - 2026-06-22

### Fixed

- Extended the Tahoe compatibility V8 flags to include `--sandbox=off` alongside
  `--jitless`. The friend's test confirmed `--jitless` was applied correctly
  (visible in both the plist env var and the daemon's `ps` args), but V8 still
  crashed with "Failed to reserve virtual memory for CodeRange". V8's sandbox
  feature (default-on in recent 64-bit builds) reserves a 1TB virtual address
  range; Tahoe's VM subsystem fails this even when jitless shrinks the CodeRange
  itself. Disabling the sandbox is acceptable here because the daemon already
  runs locally with `-A` (full user-level access), so the sandbox's V8-exploit
  defense doesn't add meaningful protection. Updated the
  `tahoe_compat_true_includes_deno_v8_flags` test to expect the combined flag
  string.

## [0.2.31] - 2026-06-21

### Fixed

- Added diagnostic probes for `AVCaptureDevice.authorizationStatusForMediaType`
  _before_ calling `requestAccessForMediaType`, so the launcher log shows
  exactly what macOS thinks the microphone permission state is. macOS returns:
  - `notDetermined (0)` — TCC hasn't decided yet (request would prompt)
  - `restricted (1)` — MDM/parental controls (can't grant)
  - `denied (2)` — user denied, or TCC refused to ask
  - `authorized (3)` — already granted This stops the guessing when the friend's
    test hits "Microphone permission denied" without ever seeing the prompt. All
    status output goes to stderr (visible via tray → View Logs). Not a fix yet,
    but diagnostic groundwork — if Tahoe is genuinely denying without prompting,
    the logs will show which code path we're in.

## [0.2.30] - 2026-06-21

### Fixed

- Expanded the `psycheros-daemon` capability's remote URL patterns so that URLs
  with paths (e.g. `http://localhost:3000/`, `http://localhost:3000/c/abc`) are
  allowed by Tauri 2's glob matcher. Previously only the bare origin and
  origin-with-port forms were listed (`http://localhost`, `http://localhost:*`),
  and Tauri's `*` glob does not match a leading `/` — so the mic-capture command
  was rejected at runtime with "not allowed by ACL" even though the webview had
  loaded the daemon correctly. Added `/`, `:*/`, and `:*/**` variants for both
  `localhost` and `127.0.0.1`.

## [0.2.29] - 2026-06-21

### Fixed

- Removed stray `?` operator on the `unsafe` block that sets up the audio engine
  and format tuple. The `?` was intended to propagate the
  `Option<Retained<AVAudioFormat>>` from the initializer, but that is already
  handled by `.ok_or(...)?` inside the block. Applying `?` to the block's return
  value — a
  `(Retained<AVAudioEngine>, Retained<AVAudioInputNode>,
  Retained<AVAudioFormat>)`
  tuple — does not compile because tuples do not implement `Try`.

## [0.2.28] - 2026-06-21

### Fixed

- All remaining `objc2` / `objc2-avf-audio` method calls in the macOS
  mic-capture module are now wrapped in `unsafe` blocks (`AVAudioEngine::new()`,
  `AVAudioFormat::initWithCommonFormat_...`, `buffer.frameLength()`).
- `installTapOnBus` now receives `RcBlock::as_ptr(&tap)` instead of `&mut *tap`
  — `RcBlock` does not implement `DerefMut`, so the previous raw-pointer cast
  did not compile. The method expects a `*mut DynBlock<dyn Fn(...)>` raw
  pointer, which `as_ptr` provides canonically (block2 0.6 API).

## [0.2.27] - 2026-06-21

### Fixed

- `AVAudioFormat` initializer now called as an associated function
  (`AVAudioFormat::initWithCommonFormat_sampleRate_channels_interleaved(alloc(), ...)`)
  instead of method syntax (`alloc().initWith...`). objc2's generated init
  methods take `this: Allocated<Self>` as the first positional parameter (not a
  `self:` receiver), so on stable Rust they are associated functions — method
  syntax only works with the nightly-only `unstable-arbitrary-self-types`
  feature. The method existed but couldn't resolve as a chained call.

## [0.2.26] - 2026-06-21

### Fixed

- `AVAudioFormat` initializer now uses the correct CamelCase selector name
  (`initWithCommonFormat_sampleRate_channels_interleaved`). objc2 0.6+ generates
  method names preserving the ObjC selector segments as CamelCase, not
  snake_case — the prior `init_with_common_format_...` name did not exist on
  `Allocated<AVAudioFormat>`. Also handles the initializer's
  `Option<Retained<...>>` return (can fail and return nil for unsupported
  formats) with `.ok_or(...)`. With mono/16kHz Float32 the call won't fail in
  practice, but the type system requires the unwrap.

## [0.2.25] - 2026-06-21

### Fixed

- Native mic-capture plugin's `AVAudioEngine` API calls now match the
  objc2-avf-audio 0.3 method signatures (six API surface mismatches from the
  previous cycle's compile). All mechanical fixes from compiler diagnostics, no
  architectural changes:

  - `AVAudioFormat::alloc()` requires `objc2::AnyThread` trait in scope (objc2
    0.6 moved `alloc()` from inherent to trait).
  - `AVAudioCommonFormat::PCMFormatFloat32` (the constant name has "Format" in
    the middle).
  - `floatChannelData()` returns `NonNull<NonNull<f32>>`; deref once, then
    `.as_ptr()` to get a real `*const f32` that can be indexed.
  - `installTapOnBus_bufferSize_format_block` expects `*mut Block<...>`, not
    `&RcBlock` — pass `&mut *tap` to coerce the deref'd RcBlock.
  - `engine.startAndReturnError()` (ObjC selector is `-startAndReturnError:`;
    objc2 maps verbatim). Returns `Result<(), NSError>`.
  - `AVAudioEngine::inputNode()` is marked `unsafe`; wrapped the call sequences
    in both `build_and_start_capture` and `stop_engine_and_remove_tap` inside
    `unsafe {}` blocks.

## [0.2.24] - 2026-06-21

### Fixed

- `CaptureState` now satisfies `Send` + `Sync`. `ActiveCapture` holds objc2
  `Retained<AVAudioEngine>` and `Retained<AVAudioFormat>`, which wrap raw ObjC
  object pointers (`*const UnsafeCell<()>`). Rust conservatively refuses to send
  raw pointers across threads, so `app.state::<CaptureState>()` and the async
  command futures failed `E0277` trait bounds on macOS. Added
  `unsafe impl Send + Sync` for `ActiveCapture` — sound because all access is
  serialized through the `Mutex<CaptureState>` lock (the engine also manages its
  own internal render thread for the tap block).
- Removed an unused `use std::time::Duration;` at module scope — it was shadowed
  by an inner import inside `request_mic_permission()` and would have failed
  clippy under `-D warnings`.

## [0.2.23] - 2026-06-21

### Fixed

- Native mic-capture plugin's Rust code now compiles on macOS. The plugin
  (introduced in 0.2.21) was importing `AVAudioEngine`, `AVAudioFormat`,
  `AVAudioPCMBuffer`, `AVAudioTime`, and `AVAudioCommonFormat` from
  `objc2-av-foundation`, but those types live in Apple's separate AVFAudio
  framework — mapped by the `objc2-avf-audio` crate. Switched the imports and
  `ActiveCapture` struct field types to `objc2-avf-audio`; the crate was already
  in the dependency graph transitively. `AVCaptureDevice` (used by the system
  permission prompt) stays in `objc2-av-foundation`.
- Tap block now constructed via `RcBlock::new` instead of the nonexistent
  `Block::new` (block2 0.6 removed the bare constructor — `Block` is an opaque
  type; blocks are built via `RcBlock` or `StackBlock`). Matches the pattern
  already used by `request_mic_permission()` in the same file. The now-redundant
  `std::mem::forget(tap)` is dropped — `RcBlock` is ref-counted and the engine
  retains the block internally.

## [0.2.22] - 2026-06-21

### Fixed

- Plugin Builder registration renamed from `mic-capture` to
  `psycheros-mic-capture` to match the ACL namespace Tauri derives from the
  crate name (`tauri-plugin-psycheros-mic-capture`). With the mismatch, JS
  invokes targeting `plugin:mic-capture|...` were rejected by Tauri 2's ACL
  ("Command not allowed by ACL") even though the capability granted
  `psycheros-mic-capture:default` — Tauri resolves the invoke prefix against the
  registered Builder name, not the package-derived namespace. Native mic capture
  now authorizes correctly.

### Changed

- Removed dead `permissions/allow-request-mic-permission.toml` — defined a
  permission for a command that no longer exists as a Tauri command
  (`request_mic_permission` is now internal to the mic-capture plugin).
- Updated the `psycheros-daemon` capability description to reflect the current
  architecture (plugin handles macOS system permission internally; the
  capability just grants the plugin's start/stop commands).

## [0.2.21] - 2026-06-20

### Changed

- Replaced the permission-only `mic` plugin with a dedicated
  `tauri-plugin-psycheros-mic-capture` crate that captures audio natively via
  `AVAudioEngine` and streams Int16 PCM 16kHz mono frames to JS over a Tauri IPC
  channel. macOS Tahoe (26)'s WKWebView does not expose `navigator.mediaDevices`
  at all — the previous permission-shim approach (flip private WebKit flags,
  then getUserMedia) was dead on arrival because the API surface itself is
  missing. The new plugin sidesteps WebRTC entirely. No-op on Windows/Linux
  (stub returns an error; voice.js falls back to getUserMedia).
- Removed `macos_media.rs` and `mic_plugin.rs` — their private-API flag-flipping
  and permission-request logic are superseded by the native capture plugin.

## [0.2.20] - 2026-06-20

### Fixed

- Microphone permission command now resolves from the psycheros web UI. Tauri
  2's ACL only honors plugin-namespaced commands for remote origins, so the bare
  `request_mic_permission` was silently dropped — extracted into a small `mic`
  plugin; capability now references `mic:allow-request-mic-permission`.
- `macos_media.rs` no longer writes the hallucinated private KVC selectors
  (`_allowedMediaCapture` etc.) that wry never actually used. It is now a
  read-only diagnostic logging WKWebView class, pointer retain, and selector
  probes.

## [0.2.19] - 2026-06-20

### Fixed

- **macOS desktop app now exposes `navigator.mediaDevices` for voice chat.**
  WKWebView does not expose the mediaDevices API surface at all unless the host
  app flips several private WebKit flags — voice chat failed inside the desktop
  app because the API was missing, not just unpermitted. New `macos_media.rs`
  module flips three private WebKit flags on the WKWebView at startup
  (`_allowedMediaCapture`, `_setRequiresUserActionForMediaCapture`,
  `mediaCaptureEnabled`). Private-API use is safe for Psycheros's ad-hoc signed
  distribution (no Mac App Store goal). Also adds the missing
  `allow-request-mic-permission` Tauri capability that blocked the mic
  permission command. No-op on Windows/Linux.

## [0.2.18] - 2026-06-19

### Fixed

- **macOS desktop app now grants microphone access for Tauri WebView voice
  chat.** WKWebView's media-capture delegate isn't wired in wry, so
  `getUserMedia()` silently failed inside the Tauri desktop app on macOS — the
  app never appeared in System Settings → Microphone. New
  `request_mic_permission` command pre-grants at the TCC level via
  `AVCaptureDevice.requestAccess`; psycheros invokes it before `getUserMedia`
  when `window.__TAURI__` is present. No-op on Windows/Linux; falls through
  cleanly in browser mode and older launchers.

## [0.2.17] - 2026-06-18

### Fixed

- **macOS desktop app now prompts for microphone access.** The Tauri bundle had
  no `NSMicrophoneUsageDescription` in its Info.plist, so macOS refused to even
  ask the user for mic permission — voice chat silently failed in the desktop
  app on Mac. Added `src-tauri/Info.plist` with the required usage descriptions
  (`NSMicrophoneUsageDescription` + `NSAudioInputUsageDescription`); Tauri 2
  auto-discovers and merges it with the generated Info.plist. Windows/Linux
  unaffected — WebView2 treats `tauri.localhost` as a secure context and OS mic
  privacy is user-level.

## [0.2.16] - 2026-06-04

### Fixed

- **Tahoe codesign repair now recurses into plug cache subdirectories.** The
  Deno plug cache nests `.dylib` files under `plug/https/github.com/<hash>/`,
  not at the top level of `plug/`. The non-recursive walk missed every actual
  plugin, so the ad-hoc re-signing never touched the real dylib. Switched to a
  stack-based recursive walk that finds plugins regardless of nesting depth.

## [0.2.15] - 2026-06-03

### Fixed

- **Compile fix: `bundled_deno_path()` returns `PathBuf` directly**, not
  `Result`. Previous code used `if let Ok(...)` which caused a type mismatch on
  macOS builds.

## [0.2.14] - 2026-06-03

### Fixed

- **macOS Tahoe codesign repair now runs on every daemon start**, not just
  first-run. Existing installations whose launcher binary updated without
  re-running first-run now get the Team ID fix automatically. Also re-signs the
  Deno binary itself (not just plugins), and triggers repair when the Tahoe
  compatibility toggle is flipped.

## [0.2.13] - 2026-06-03

### Fixed

- **macOS Tahoe native-plugin code-signature mismatch.** Tahoe enforces Team ID
  matching on `dlopen()`: the official Deno binary is signed with one Team ID
  and prebuilt native plugins (`@db/sqlite` via `@denosaurs/plug`) are signed
  with another, causing `Failed to load SQLite3 Dynamic Library`. The launcher
  now ad-hoc re-signs both the staged Deno binary and all cached `.dylib` files
  on every daemon start (not just first-run), aligning their signatures so
  `dlopen()` succeeds. Safe for all macOS versions — ad-hoc signing is a no-op
  on pre-Tahoe systems.

## [0.2.12] - 2026-06-03

### Fixed

- **Tahoe VM workaround now passes `--v8-flags=--jitless` as a ProgramArgument
  in the launchd plist**, not just as an environment variable. The previous
  implementation only set `DENO_V8_FLAGS=--jitless` in the plist's
  EnvironmentVariables block, but Deno needs the flag as a direct CLI argument
  to actually disable JIT.

## [0.2.11] - 2026-06-03

### Fixed

- **Tahoe VM workaround toggle now visible regardless of daemon state.** The
  toggle in Settings > Compatibility was hidden when the daemon wasn't running —
  it now always shows so you can enable/disable the JITless workaround before
  launching.

## [0.2.10] - 2026-06-03

### Added

- **Tahoe VM nonsense workaround toggle** in Settings > Compatibility. When
  enabled, injects `--v8-flags=--jitless` as both a ProgramArgument and an
  environment variable (`DENO_V8_FLAGS=--jitless`) in the launchd plist, then
  restarts the daemon. Bypasses a macOS Tahoe 26.3.x virtual memory regression
  that crashes V8's JIT CodeRange reservation. Toggle is visible regardless of
  daemon install state so users can enable it before their first install
  attempt. Persists across restarts. ~20-40% slower JS execution; negligible for
  an I/O-bound chat daemon.

## [0.2.9] - 2026-06-03

### Fixed

- Rust formatting in URL opener (pre-existing `cargo fmt` disagreement).

## [0.2.8] - 2026-06-02

### Changed

- Install scripts updated for Deno 2.7.14.

## [0.2.7] - 2026-05-28

### Fixed

- **Git-missing remediation now works across all platforms.** The first-run
  wizard previously showed a macOS-specific "Install Xcode CLT" button when git
  was not found. Replaced with a friendly, platform-aware card: macOS gets the
  CLT installer, Windows opens the Git for Windows download page, and Linux
  opens the distribution-specific install instructions.

### Added

- **`open_url` command** for opening HTTP(S) URLs in the default browser.
  Cross-platform (macOS `open`, Linux `xdg-open`, Windows `cmd /C start`). Used
  by the git-missing remediation flow to direct users to download pages.

## [0.2.6] - 2026-05-26

### Fixed

- Daemon supervisors (launchd, Task Scheduler) now pass `PSYCHEROS_MCP_COMMAND`
  with the bundled Deno path so entity-core spawns using the same Deno binary as
  the daemon itself, instead of relying on PATH resolution.

## [0.2.5] - 2026-05-24

### Fixed

- Windows daemon runner now creates the log directory before opening log files,
  preventing exit code 65 (`E_LOG_OPEN`) when a stale Task Scheduler task
  survives an uninstall/reinstall cycle (the task is stored in the system
  registry, not AppData, so deleting AppData doesn't remove it).

## [0.2.4] - 2026-05-24

### Fixed

- First-run no longer aborts when `deno cache` exits 1 due to Deno 2.x
  lifecycle-script failures (`onnxruntime-node`, `sharp` can't resolve sibling
  deps in the flat `.deno/` layout). The packages are fully installed and the
  daemon works fine — the error is now treated as a non-fatal warning.

## [0.2.3] - 2026-05-24

### Fixed

- `warm_deno_cache` error now includes the last 15 lines of `deno cache` stderr
  output so the actual diagnostic (missing native binary, network failure,
  lifecycle-script error, etc.) is visible instead of just the exit code.

## [0.2.2] - 2026-05-23

### Fixed

- macOS: improved Deno sidecar resolution with multiple search strategies
  (Resource dir, executable parent, bundle walk-up) and diagnostic-rich error
  messages so failures are traceable.

## [0.2.1] - 2026-05-23

### Fixed

- macOS: "bundled deno sidecar not found in app resources" error on first run.
  Tauri 2 places the Deno sidecar in `Contents/MacOS/`, not
  `Contents/Resources/` — the resolver now checks both locations.

## [0.2.0] - 2026-05-22

### Added

- **Full Windows support**: MSI installer (WiX), standalone .exe (NSIS), Task
  Scheduler daemon supervisor, Win32 Job Object cascade-kill, system-tray
  integration, and Ctrl+, global shortcut — at parity with the macOS launchd
  reference. No UAC or admin required.
- **Windows runner sidecar** (`psycheros-daemon-runner.exe`): silent
  `CREATE_NO_WINDOW` Deno spawn wrapped in a Job Object so `schtasks /End`
  cascades cleanly to the daemon process.
- **Windows autologon task**: launcher boots silently to system tray at every
  user login, mirroring the macOS launcher-agent posture.
- **`CREATE_NO_WINDOW` on all subprocess spawns**: no ghost console windows from
  schtasks, whoami, netstat, tasklist, git, deno, or where.exe during normal
  operation.
- **Per-OS tray icons**: full-color 32x32 PNG on Windows, template PNG with
  auto-tint on macOS.
- **`tauri-plugin-global-shortcut`** for Ctrl+,/Cmd+, preferences chord, because
  Tauri 2 menu accelerators don't fire from WebView2-focused windows on Windows.
- **CI split**: `launcher-v2-macos` and `launcher-v2-windows` jobs in both
  check.yml and release.yml. Windows job builds .msi + .exe and uploads both to
  the GitHub release page.
- **Per-OS externalBin config** (`tauri.windows.conf.json`): avoids shipping
  Windows-only sidecars on macOS builds.
- **`setup.ps1`**: PowerShell equivalent of setup.sh for Windows dev setup.
- **13 new "Traps that bite" entries** in CLAUDE.md covering Windows-specific
  gotchas surfaced during the port.

### Changed

- `default-run = "psycheros-launcher"` in Cargo.toml (required by the new
  dual-`[[bin]]` layout).
- `splash_url` is now `Mutex<String>` with lazy capture to fix WebView2's
  about:blank race on preferences navigation.
- `stage_bundled_deno` renamed to `stage_bundled_binary` (back-compat alias).
- `--allow-scripts` added to Deno warm-cache so npm postinstalls (onnxruntime,
  sharp) complete during first-run.
- Update-watcher toast shows per-OS shortcut hint (⌘, on macOS, Ctrl+, on
  Windows/Linux).
- `check_port_conflict` uses `netstat -ano` + `tasklist` on Windows.
- `resolve_sidecar_binary` generic helper for future externalBin sidecars.

## [0.1.1] - 2025-05-20

### Fixed

- **macOS bundle now ad-hoc signed at the bundle level** (`tauri.conf.json`).
  Added `bundle.macOS.signingIdentity: "-"` so Tauri invokes `codesign --sign -`
  on the final `.app` after embedding the deno sidecar. Before this, the
  launcher binary carried only Rust's linker-signed stub and the bundle had no
  `Contents/_CodeSignature/CodeResources` at all. On Apple Silicon that
  combination is fatal: when a user downloads the `.dmg` from GitHub, Chrome
  sets `com.apple.quarantine`, AMFI sees no real CMS blob, and the kernel kills
  the process at launch before Gatekeeper can even prompt — bypassing the
  familiar "Open Anyway" workflow entirely. Proper ad-hoc signing keeps us in
  the no-cost / no-Apple-Developer-account posture but produces a signature AMFI
  accepts, so quarantined launches land on the standard Gatekeeper "cannot
  verify developer → Open Anyway" path documented in [`README.md`](README.md)
  and [`docs/release.md`](docs/release.md).

## [0.1.0] - 2025-05-20

### Added

- **Real brand icons across the launcher and `psycheros` web surface**
  (`packages/launcher-v2/src-tauri/icons/`, `packages/psycheros/web/icons/`).
  The launcher's placeholder solid-violet PNGs are replaced with the canonical
  heart-chip silhouette and the cyan→purple stroke gradient from
  `site/src/assets/psycheros-logo.svg`. `scripts/setup.sh` regenerates the full
  Tauri icon set (32x32, 128x128, 128x128@2x, .icns, .ico) from the canonical
  SVG via `sips` + `npx tauri icon`; the desktop variants are committed,
  mobile + Windows-tile noise is gitignored. A separate monochrome template
  variant (`tray-icon-template.svg`/.png) drives the menu-bar tray — macOS
  auto-tints to light/dark menu-bar themes via the alpha channel.
- **macOS menu-bar tray (always-on menu-bar agent)**
  (`src-tauri/src/app/tray.rs`, `src-tauri/src/supervisor/launcher_agent.rs`).
  The launcher is now a true menu-bar agent: a separate launchd plist
  (`ai.psycheros.launcher`) auto-starts the launcher at login with
  `--no-window`, the tray icon is the user's persistent surface, and the manager
  window is just a feature opened on demand. Hybrid activation policy —
  `Regular` when the window is visible (dock icon shows), `Accessory` when only
  the tray is up (dock icon hides) — matches the Tailscale / 1Password /
  Backblaze convention. Tray menu items: status label, Open chat, Open manager,
  Stop daemon, View logs, "Start Psycheros at login" checkbox. Left-click
  dispatches on daemon state (Running → chat, otherwise → manager). Cmd+Q routes
  through the same hide-then-surfaces-check path as the close button rather than
  process-killing, so the tray can't be stranded by a reflexive Cmd+Q.
- **Strict tray = daemon `Running` rule**. The tray icon is visible if and only
  if the daemon's `/health` probe answers Psycheros. Stop the daemon and the
  icon vanishes; the user's re-entry is the .app in /Applications. No-surfaces
  auto-exit retires the launcher process when both the tray and the window are
  hidden (with a has-been-running gate so login boot waits for the daemon to
  come up, and a 5-second exit grace so transients don't kill the launcher
  mid-flight).
- **HTTP `/health` probe disambiguation** (§probe). The daemon-state probe used
  to flip to `Running` whenever anything bound the port — a different project's
  Node dev server, a misconfigured test, etc. Now sends `GET /health` and
  matches `"name":"psycheros"` in the response body; only Psycheros's own health
  endpoint answers in that shape. Hand-rolled HTTP/1.1 (no new deps), bounded by
  a 500ms timeout. Six unit tests on the response-shape recognizer.
- **`LauncherConfig.port` actually wires through** (§probe + config). The probe
  and the daemon-config builder now read `cfg.port` instead of the const, so
  changing port in `config.json` no longer silently breaks backup/restore.
- **Autostart toggle is a preference change, not a daemon restart**. The
  Settings-card "Switch to Autostart/Manual" and the tray's "Start Psycheros at
  login" checkbox both flip a plist-content preference now —
  `LaunchdSupervisor::set_mode_only` writes the new RunAtLoad / KeepAlive
  content to the existing plist and returns. No `launchctl unload/load`, no
  daemon restart, no cascade of dropped HTTP connections through entity-core and
  the chat surface. macOS picks the new content up at next session load (next
  login), which is precisely when "autostart at login" matters. The `KeepAlive`
  crash-restart behavior takes effect at next daemon start.
- **End-to-end test harness via `tauri-plugin-webdriver`**
  (`packages/launcher-v2/e2e/`). Closes the largest empirical gap left after the
  smoke-binary + integration-test pass: the UI ↔ IPC boundary. Twelve specs
  across three files exercise the real Tauri webview — `smoke` (boots +
  renders), `wizard` (first-run form interactivity + defaults), `ipc` (read-only
  commands round-trip through `window.__TAURI__`, unknown commands reject). Each
  spec spawns a hermetic launcher in a temp `PSYCHEROS_LAUNCHER_DATA_DIR` and
  tears down on completion. Suite runs in ~2s locally. Opt-in cargo feature
  `webdriver` keeps the WebDriver server out of release builds. CI runs the
  suite on macos-14 as a fourth step in the `launcher-v2` job. See
  [`e2e/README.md`](e2e/README.md).
- **CI release job for launcher-v2** (§5.23). New `launcher-v2` job in
  `.github/workflows/release.yml`: macos-14 runner, sets up Rust
  - Deno, runs `./scripts/setup.sh` + `tauri build` for aarch64-apple-darwin,
    uploads the resulting `.dmg` + `.app.tar.gz` to the GitHub release page.
    Triggers on `launcher-v2-v*` tags; the v1 launcher job's matcher tightened
    to exclude v2 tags so a v2 tag doesn't fire both jobs. `--latest=false`
    keeps the repo-wide "Latest" badge on the v1 launcher during the transition
    window per `RELEASES.md`. A `release-footers/launcher-v2.md` covers the
    unsigned-Gatekeeper dance on the release page.
- **Operations runbook** (`docs/runbook.md`, §5.26). Symptom → recovery mapping
  for the common failure modes — crashloops, MCP offline, port conflicts,
  bootstrap failures, restore errors, etc. Links every symptom to the exact
  in-app button to click. Linked from the README's Troubleshooting section.
- **CONTRIBUTING.md** for the launcher-v2 package (§5.25). Dev setup, build
  commands, gate commands, agent context. The README's former "Building from
  source (devs)" section is gone — README is now user-focused, CONTRIBUTING is
  dev-focused.
- **v1-roadmap.md marked complete** (§5.27). Banner at the top of the doc points
  future revisions at CHANGELOG entries. The file itself is preserved as the
  historical artifact of the planning + execution pass.
- **Migration runner during source updates** (§5.20). Between fetch and
  warm-cache, `apply_source_update` checks for a
  `migrations/<from-tag>-to-<to-tag>.ts` file in the cloned source root. When
  present, runs it via the bundled Deno with `-A` and the user's data dir as its
  sole argument, streaming stdout + stderr into the update progress ticker (new
  `migrate` phase). Missing file is a quiet no-op (most version bumps don't need
  migrations); non-zero exit aborts the update and leaves the source clone +
  data untouched — maintainers ship idempotent migrations so a retry safely
  resumes. Skipped on rollback (snapshots restore data directly).
- **Pin to specific version + rollback affordances** (§5.17 + §5.22).
  - `apply_source_update` now accepts an optional `target_tag`. With `None` (the
    default) it queries the latest channel tag and installs that. With
    `Some("psycheros-v0.3.2")` it installs that specific tag — used by the
    version picker and effective for forward-pin or rolling forward/back without
    restoring a snapshot.
  - `list_available_tags` Tauri command (`bundle::list_tags`) returns every tag
    on the configured channel, sorted highest semver first. Surfaced in the
    Settings card as a "Source version" dropdown + "Install version" button.
  - `rollback_to_snapshot(history_index)` Tauri command: stop daemon → wipe
    `<data>/.psycheros/` → restore from the entry's snapshot dir → reset source
    clone to the entry's tag → warm cache → start daemon. Emits the existing
    `source-update-progress` events with new `rollback-*` phase names so the
    bootstrap card's progress ticker renders the operation. Surfaced as a "Roll
    back" button on each rollback-eligible row in the diagnostics card's Update
    history section.
- **Pre-update snapshots + persisted update history** (§5.18 + §5.21). Before
  `apply_source_update` fetches the new tag, the launcher copies
  `<data>/.psycheros/` into a timestamped directory under
  `<launcher_data_dir>/.snapshots/`. On success it appends an
  `UpdateHistoryEntry` (tag / applied_at / previous_tag / snapshot_id) to
  `LauncherConfig.update_history` (capped at 10 entries; older snapshots pruned
  in lockstep). The diagnostics card now renders the history as a separate
  "Update history" section, with applied-at + previous-tag + a "rollback
  available" marker for entries whose snapshot still exists.
- **`get_update_history` Tauri command.** Returns the history list with
  `snapshot_id` cleared on any entry whose snapshot directory has been pruned —
  so callers can rely on `snapshot_id: Some(_)` meaning the rollback target
  still exists on disk. Sets up the §5.17 / §5.22 pin + rollback flows that come
  next.
- **Mode switch + update channel selection** in the Settings card.
  - `set_daemon_mode("autostart"|"manual")` overwrites the plist inline (no
    uninstall/reinstall round trip); the supervisor's `write_and_load_plist`
    already does unload → write → reload, so the flip is clean. Surfaced as a
    "Switch to Manual" / "Switch to Autostart" button next to the current-mode
    row.
  - `set_update_channel("stable"|"beta")` persists the chosen channel; the next
    `query_latest_tag` picks up the new prefix via `effective_tag_prefix()`.
    Stable tracks `psycheros-v*`, Beta tracks `psycheros-beta-v*`.
  - New `update_channel` field on `LauncherConfig`. Optional + serde default to
    `None` so old configs parse fine; `effective_channel()` treats `None` as
    Stable.
- **Self-repair warnings panel** in the manager card. Renders only when the
  launcher detects a problem the underlying state probes don't directly expose.
  Three warning sources for v1.0:
  - **MCP down** — log-line substring match for psycheros's MCP error patterns;
    surfaces a "Restart daemon" remediation.
  - **Crashloop** — daemon-status-changed history; if 3+ Running→Installed
    transitions occur within a 60-second window, surfaces a "Atlas keeps
    crashing" warning with a shortcut into the Data card's Re-init flow.
  - **Port conflict** — when stuck in Installed for >20 seconds, calls
    `check_port_conflict` (lsof on macOS) and renders the holding process's
    name + PID so the user knows what to quit.
- **`check_port_conflict` + `install_xcode_clt` Tauri commands.** Port-conflict
  uses `lsof -i :<port> -P -n -sTCP:LISTEN -Fpc` on macOS; install_xcode_clt
  spawns `xcode-select --install`. Linux + Windows return None / Err since their
  equivalents wait on the not-yet-implemented supervisors. 4 new unit tests on
  the lsof fielded-output parser.
- **Git-missing remediation in the bootstrap-error path** (§5.14). When
  `first_run` fails with the GitMissing fingerprint, the bootstrap card adds an
  "Install Xcode CLT" button alongside Try Again. Clicking it opens the system
  installer dialog; the explanatory error copy switches to "click Install in
  that dialog, then come back here."
- **Data management card** (`Data` button in the manager footer) with four
  actions, each behind an in-app confirm:
  - **Back up** — `backup_data` POSTs to psycheros's
    `/api/admin/entity-data/export`, streams the resulting zip to
    `~/Downloads/psycheros-backup-<UTC timestamp>.zip`. Simple confirm; daemon
    must be Running.
  - **Restore** — file picker (via `tauri-plugin-dialog`) → daemon's
    `/api/admin/entity-data/import` → automatic daemon restart on success.
    Simple confirm.
  - **Wipe entity data** — typed-confirm `WIPE`; clears the entity data dir
    (memories / identity / vault / settings / DB) while keeping the OS service
    registration. First-run re-templates fresh identity files on next daemon
    boot.
  - **Re-init** — typed-confirm `REINIT`; uninstalls the service, deletes the
    cloned source + identity dir, clears `bundled_source_version` so the next
    launch routes through the first-run wizard. Memories and vault content
    survive.
- **Minimal localhost HTTP/1.1 client** (`src/http.rs`). Hand-rolled ~200 lines
  so the data-management commands can call psycheros's admin API without pulling
  in `reqwest` + tokio + a TLS stack we don't need for `127.0.0.1` calls. 5 unit
  tests cover header parsing + the `\r\n\r\n` terminator.
- **`tauri-plugin-dialog`** for the OS-native file picker (Restore action).
  `dialog:allow-open` permission added to default capabilities.
- **Typed-confirm modal** alongside the existing simple-confirm modal. Requires
  the user to type a specific phrase before the destructive button activates;
  Esc dismisses; default-focus the input so it's keyboard-accessible.
- **Settings card** accessible from the manager footer (next to Diagnostics).
  View-only display of entity name / user name / timezone (from
  `read_general_settings`) and daemon port. The "Edit in Psycheros" button calls
  `set_view_mode("chat")` so the user navigates to psycheros's own settings UI
  for edits — keeping one source of truth for all entity-facing config. Button
  is disabled (with an explanatory title) when the daemon isn't Running, since
  the chat view is just a splash in that case.
- **Log panel filter + search + copy + save + load-more.** Level toggles (info /
  warn / error) drive a pure-CSS hide via `data-hide-*` attributes on the panel
  body. Search input does a case-insensitive substring filter, applied to both
  existing lines and new arrivals from the live tail. Copy uses
  `navigator.clipboard`; Save downloads a timestamped `.log` via a Blob URL.
  Load more re-reads `recent_daemon_log_lines` with a doubled tail size (cap 8
  MB), replacing the current panel content.
- **Shared `info-grid.js` module.** Renders labeled key/value grids with
  optional per-row action buttons. Diagnostics and Settings cards both consume
  it via `.info-grid` / `.info-row` / `.info-row__*` CSS classes.
  Diagnostics-specific class names (`.diagnostics__*`) renamed to the shared
  form in the same change.
- **Diagnostics card** accessible from the manager footer. Read-only snapshot of
  launcher version, installed source tag, daemon state + PID + last-exit-status
  (parsed from `launchctl list`), daemon mode, service label, filesystem paths
  (data dir / source dir / log dir / config / launcher data dir) with per-row
  "Reveal" buttons that open the path in Finder, recursive byte count of the
  entity data dir, upstream repo URL + tag prefix. On-demand fetch — no polling
  — with a Refresh button for re-reading after a daemon restart.
- **`get_diagnostics` / `open_path` Tauri commands.** Diagnostics builds a full
  snapshot on a blocking thread (the disk walk and `launchctl list` are
  I/O-bound); open_path shells to `open` / `xdg-open` / `explorer` per OS.
- **`ServiceSupervisor::query_runtime_info`** — best-effort
  `RuntimeInfo { pid, last_exit_status }` parsed from the supervisor's native
  status output. launchd impl walks `launchctl list <label>` lines; the default
  trait impl returns `RuntimeInfo::default()`, so Linux / Windows stubs need no
  per-platform code yet.
- **`DaemonState::as_str()`** — stable kebab-case string view matching the
  existing `#[serde(rename_all = "kebab-case")]`, used by diagnostics to surface
  state without going through serde.
- **`read_general_settings` Tauri command.** Direct disk read of psycheros's
  `<data>/.psycheros/general-settings.json`, returning `Option<GeneralSettings>`
  (None when the file is absent on a fresh install). Works when the daemon is
  down — used by the wizard's pre-fill, and slated for upcoming diagnostics +
  settings cards.
- **Wizard pre-fill from existing general-settings.json.** When the user re-runs
  the wizard (e.g. after a reinstall that preserved the data dir), the entity
  name / user name / timezone inputs come up pre-populated from psycheros's own
  settings rather than the generic defaults. Fresh installs still see the
  default "Assistant" / "You" / browser-detected timezone.
- **Source-as-git-clone provisioning.** Replaces the original tarball model.
  `bundle::clone_or_fetch_source` shallow-clones the public Psycheros repo at
  the latest matching `psycheros-v*` tag into `<data>/source/` on first run, and
  fetches forward on update. No source bundled inside the `.app`.
- **Tag-tracked update detection + apply.** `bundle::query_latest_tag` semver-
  sorts client-side; `check_for_updates` Tauri command returns
  `UpdateInfo { current_version, latest_version, update_available }`;
  `apply_source_update` runs fetch + reset to FETCH_HEAD + warm cache +
  `supervisor.restart()` with streamed `source-update-progress` events.
- **Background update watcher** (`src/app/update_watcher.rs`). Polls upstream
  every 3 hours, emits `update-available`, injects an in-window
  webview-eval-driven toast on rising-edge transitions. `window.confirm` is
  blocked in Tauri 2 webviews so we never use it — see "Confirm modal" below.
- **Manual daemon mode**, alongside the existing autostart mode.
  `DaemonMode { Autostart, Manual }` enum on `LauncherConfig`. Supervisor trait
  grew `install_autostart`, `install_manual`, `start_daemon`, `stop_daemon`,
  `is_installed`. launchd impl writes two plist variants (autostart =
  `RunAtLoad=true` + `KeepAlive=true`; manual omits `KeepAlive`). Stop is
  session-scoped `launchctl unload` (no `-w`) so autostart users can pause for
  the session without flipping their persistent enable state.
- **New `Stopped` daemon state** in `daemon::probe`. Plist file present but not
  loaded in launchctl = user manually stopped (vs. NotInstalled = never
  installed). The manager card renders a Start daemon affordance in Stopped, and
  the state survives across launcher restarts.
- **Universal Start / Stop buttons.** Work in both autostart and manual modes.
  Available from Running (Stop), Stopped (Start), and Installed (Stop, for the
  rare crashlooping case).
- **Live daemon log panel** in the manager card. `src/app/log_tailer.rs` polls
  `<data>/logs/daemon.stderr.log` every ~1.5s and emits `daemon-log-line`
  events. Frontend renders most recent ~300 lines with INFO/WARN/ERROR
  coloring + auto-scroll + Clear button. `recent_daemon_log_lines` command
  populates the panel on manager init.
- **First-run welcome wizard** (`frontend/js/first-run.js`). Three-field form
  (entity name / user name / timezone with IANA dropdown), then the bootstrap
  card with live progress ticker (git clone → stage Deno → warm cache).
- **Loud action-feedback UX.** Card-level action-progress banner with spinner +
  pulsing accent glow during any in-flight action. Button-level busy state with
  solid accent fill + trailing spinner + label swap ("Stop daemon" →
  "Stopping…"). Mis-click protection: while one button is busy, all sibling
  buttons in the same card are disabled.
- **In-app confirm modal** replacing `window.confirm` (which Tauri 2 blocks
  silently). Themed to match the launcher, default-focused on Cancel for
  destructive actions, Esc dismisses. Wired to Uninstall.
- **Gatekeeper documentation** in `README.md` — right-click → Open + `xattr`
  one-liner. v2 ships unsigned by deliberate decision.

### Changed

- **Wizard inputs no longer cached in `LauncherConfig`.** Dropped `entity_name`,
  `user_name`, `timezone` from the launcher config — they live exclusively in
  psycheros's `general-settings.json` now. Caching them on the launcher side
  caused drift the moment the user edited their entity name via psycheros's
  settings UI: the launcher's stale copy would re-stamp the file on next
  install. Single source of truth, owned by psycheros. Upgrade is automatic —
  serde ignores the legacy fields and they drop out of `config.json` on next
  save.
- **Migration story rewritten** to use Psycheros's native
  `/api/admin/entity-data/{export,import}` round-trip rather than a
  launcher-specific copy script. Removes parallel migration code and inherits
  the daemon-side fixes (post-import MCP restart, vault scope, etc.) for free.
  See `docs/migration.md`.
- **Docs refreshed** for the git-clone source model: `docs/bundle.md` renamed to
  `docs/source-provisioning.md` and rewritten; `docs/architecture.md` +
  `docs/release.md` tarball-era language swept; `docs/migration.md` rewritten.
- **`bundled_source_version`** now stores the tag name (e.g. `psycheros-v0.3.3`)
  rather than a SHA. Easier to read in config + UI.
- **Confirm dialog default-focus** on Cancel (was none) — Enter on accident
  doesn't fire destructive actions.
- **Snapshot rollback is atomic** via a rename swap in
  `restore_directory_atomically` (`src-tauri/src/commands.rs`). The previous
  flow removed `<data>/.psycheros/` first and then copied the snapshot in — a
  mid-copy failure left a half-restored directory. New flow copies the snapshot
  to a sibling `.psycheros.tmp/`, renames the live dir aside to
  `.psycheros.old/`, promotes the temp dir into place, then deletes the backup.
  If promotion fails, the backup is renamed back. Two tests cover the happy path
  and the absent-snapshot branch.

### Removed

- **Embedded `release-bundle.tar.gz`** and the `bundle.resources` entry in
  `tauri.conf.json`. The `.app` no longer ships a source tarball.
- **`scripts/bundle-source.sh`** — produced the now-unused tarball. Deleted.
- **`scripts/migrate-from-v1.sh`** — replaced by Psycheros's native export/
  import flow.
- **`autostart_installed` field** from `LauncherConfig` — dead field, never read
  after install. Subsumed by `daemon_mode` semantics + on-disk probe.
- **`flate2` + `tar` Cargo deps** — no longer needed without the tarball.

### Fixed

- **MCP path-shattering bug** in `packages/psycheros/src/main.ts:119-121` —
  `mcpArgsStr.split(" ")` shattered paths containing spaces (broke the
  launcher's macOS install path `~/Library/Application Support/...`). Fix: build
  argv as a proper array. Shipped in `psycheros-v0.3.3`. See staging commit
  `2b84cbf`.
- **Post-update UI race** — `daemon_status` called immediately after
  `supervisor.restart()` could capture a transient `Installed` state before the
  daemon rebound the port. Manager now polls daemon_status for up to 30s after
  applying an update, rendering each intermediate state.
- **Tauri-2 sidecar resolution** — `resolve_sidecar_deno` tries four candidate
  paths (`deno`, `deno-<triple>`, `binaries/deno`, `binaries/deno-<triple>`)
  since Tauri's runtime layout for `externalBin` differs between dev and prod.
- **`git reset --hard origin/<branch>`** for tag fetches — switched to
  `FETCH_HEAD` which works for both branches and tags. Annotated tags peel to
  their commit automatically.
- **`--progress` on `git reset`** — emitted from `clone_or_fetch_source`'s reset
  step, where `--progress` is rejected as a usage error (exit 129). Removed from
  the reset args; kept on clone/fetch where it's accepted.
- **Migration pipe deadlock** in `run_migration_if_present`
  (`src-tauri/src/commands.rs`). Previous code drained the child `deno`'s stderr
  to EOF and _then_ stdout to EOF — if stdout's ~64 KB pipe buffer filled while
  we were still reading stderr, the child blocked writing and the migration
  hung. Rewrote as two reader threads feeding an mpsc channel, so both streams
  drain concurrently and lines interleave in arrival order.

### Known gaps (not yet implemented)

- Linux + Windows supervisors return `NotImplemented`. Trait + stubs +
  module-doc implementation notes are in place; cross-platform work resumes when
  development moves to those machines.
- Auto-update for the Tauri shell binary via `tauri-plugin-updater`: not
  initialized. The plugin can't run without a real Ed25519 signing key, a
  manifest endpoint, and a CI signing step — all three need to land together
  (faked any one of them and the plugin either crashes at startup or is
  functionally inert). The four-step maintainer checklist is in `src/lib.rs`
  next to where the `.plugin()` call belongs. Source-side updates ship via the
  tag-tracking flow and don't depend on this; only the launcher's own `.app`
  shell binary still needs manual re-download on new releases until the keypair
  work happens.
- Real icon set (§5.24): blocked on a 1024² source PNG. The launcher currently
  ships placeholder violet squares. Once the design asset is provided, generate
  via `cargo tauri icon <path>` from `packages/launcher-v2/`; the script
  overwrites `src-tauri/icons/`.
- Code signing / notarization: none, by decision. Gatekeeper / SmartScreen
  workaround documented in README + `docs/release.md`.
