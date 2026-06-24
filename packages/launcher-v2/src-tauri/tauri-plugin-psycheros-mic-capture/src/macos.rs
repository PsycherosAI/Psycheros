//! macOS-only mic capture via AVAudioEngine.
//!
//! Flow:
//!   1. `start_capture` → request mic permission via AVCaptureDevice
//!      (public API — same one Path 1 used, still useful here as a
//!      prompt trigger).
//!   2. Create AVAudioEngine, get inputNode.
//!   3. Build a 16kHz / mono / Float32 AVAudioFormat — AVAudioEngine
//!      inserts an internal converter from the hardware's 48kHz.
//!   4. Install a tap on bus 0 with that format. The tap block receives
//!      an AVAudioPCMBuffer; we read frameLength + floatChannelData,
//!      convert Float32 → Int16, cast to bytes, and ship via the
//!      Tauri Channel.
//!   5. engine.prepare() + engine.start().
//!   6. Stash engine + tap in CaptureState for stop_capture.
//!
//! ## Known fragility
//!
//! - objc2-av-foundation 0.3 API may differ from what the research agent
//!   sketched. We'll iterate based on the friend's first Mac compile.
//! - installTap with a format different from the input hardware format
//!   has historically crashed on some macOS versions. Fallback if it
//!   crashes on Tahoe: tap at hardware rate (48kHz Float32 mono) and
//!   decimate-by-3 in Rust.

use std::sync::Mutex;

use tauri::{ipc::Channel, AppHandle, Runtime, State};

/// File-based logger. macOS doesn't route stderr from Finder-launched GUI
/// apps to Console.app by default (only os_log calls show up there), so
/// eprintln! disappears into /dev/null when the user double-clicks the app.
/// Writing to /tmp/psycheros-mic-capture.log lets us read the output after
/// a crash via `cat /tmp/psycheros-mic-capture.log`.
fn log_event(msg: impl AsRef<str>) {
    use std::io::Write;
    let msg = msg.as_ref();
    let path = "/tmp/psycheros-mic-capture.log";
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
    {
        let _ = writeln!(f, "{}", msg);
    }
    // Keep eprintln! as a backup for terminal-launched runs.
    eprintln!("{}", msg);
}

/// Active capture session — engine + format, kept alive to sustain the tap.
/// Stored as `Option<ActiveCapture>` inside `CaptureState`; `None` when
/// capture isn't running.
pub struct ActiveCapture {
    engine: objc2::rc::Retained<objc2_avf_audio::AVAudioEngine>,
    _format: objc2::rc::Retained<objc2_avf_audio::AVAudioFormat>,
}

// AVAudioEngine and AVAudioFormat are ObjC objects backed by raw pointers,
// which Rust doesn't consider Send/Sync by default. We only ever access
// the engine from inside the CaptureState Mutex (locked in
// platform_start_capture and platform_stop_capture), so access is
// serialized at runtime. The engine also manages its own internal render
// thread for the tap block. Asserting Send + Sync here is safe for our
// mutex-guarded usage pattern.
unsafe impl Send for ActiveCapture {}
unsafe impl Sync for ActiveCapture {}

/// Plugin state. Held in `app.state()` via `app.manage(CaptureState::default())`
/// at plugin setup time. Mutex guards the active session.
#[derive(Default)]
pub struct CaptureState {
    active: Mutex<Option<ActiveCapture>>,
}

pub async fn platform_start_capture<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, CaptureState>,
    on_frame: Channel<Vec<u8>>,
) -> Result<(), String> {
    log_event(format!(
        "[mic-capture] start_capture thread: {:?}",
        std::thread::current().id()
    ));
    // Reentrancy guard — if already active, refuse.
    {
        log_event("[mic-capture] start_capture acquiring state lock");
        let guard = state.active.lock().map_err(|e| format!("state lock: {e}"))?;
        if guard.is_some() {
            return Err("capture already active".to_string());
        }
        log_event("[mic-capture] start_capture state lock OK");
    }

    // 1. Request mic permission via AVCaptureDevice.requestAccess — public
    //    API, triggers the system prompt on first call, returns the user's
    //    decision via the completion handler.
    log_event("[mic-capture] start_capture calling request_mic_permission");
    let granted = request_mic_permission().await?;
    log_event(format!("[mic-capture] request_mic_permission returned granted={}", granted));
    if !granted {
        return Err("Microphone permission denied".to_string());
    }

    // 2-5. Build engine, format, install tap, start. Synchronous because
    //      AVAudioEngine methods must be called from a single thread.
    log_event("[mic-capture] start_capture calling build_and_start_capture");
    let active = build_and_start_capture(on_frame)?;
    log_event("[mic-capture] build_and_start_capture returned");

    // 6. Stash in state.
    let mut guard = state.active.lock().map_err(|e| format!("state lock: {e}"))?;
    *guard = Some(active);

    log_event("[mic-capture] start_capture complete");
    Ok(())
}

pub fn platform_stop_capture(state: State<'_, CaptureState>) -> Result<(), String> {
    log_event(format!(
        "[mic-capture] stop_capture thread: {:?}",
        std::thread::current().id()
    ));
    let mut guard = state.active.lock().map_err(|e| format!("state lock: {e}"))?;
    if let Some(active) = guard.take() {
        log_event("[mic-capture] stop_capture calling stop_engine_and_remove_tap");
        stop_engine_and_remove_tap(active);
        log_event("[mic-capture] stop_capture teardown returned");
    } else {
        log_event("[mic-capture] stop_capture no active session, nothing to do");
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn request_mic_permission() -> impl std::future::Future<Output = Result<bool, String>> {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    async move {
        let (tx, rx) = mpsc::sync_channel::<bool>(1);
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        let media_type = NSString::from_str("soun");
        unsafe {
            let cls = class!(AVCaptureDevice);
            let _: () = msg_send![
                cls,
                requestAccessForMediaType: &*media_type,
                completionHandler: &*handler,
            ];
        }
        rx.recv_timeout(Duration::from_secs(60))
            .map_err(|e| format!("mic permission response timeout: {e}"))
    }
}

#[cfg(target_os = "macos")]
fn build_and_start_capture(
    on_frame: Channel<Vec<u8>>,
) -> Result<ActiveCapture, String> {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2::AnyThread;
    use objc2_avf_audio::{
        AVAudioEngine, AVAudioFormat, AVAudioPCMBuffer, AVAudioTime,
    };

    // AVAudioEngine::new() + inputNode() + format setup are all
    // marked unsafe in objc2-avf-audio — single unsafe block for the
    // engine + format setup.
    log_event("[mic-capture] build_and_start_capture: before engine setup");
    let (engine, input_node, format, hw_rate) = unsafe {
        log_event("[mic-capture] build: AVAudioEngine::new()");
        let engine = AVAudioEngine::new();
        log_event("[mic-capture] build: engine.inputNode()");
        let input_node = engine.inputNode();
        // Use the input node's ACTUAL hardware output format for the
        // tap — Apple's installTap throws NSInvalidArgumentException
        // if the tap format is incompatible with the node's output
        // format. The previous attempt used a 16kHz Float32 format
        // (to skip manual resampling), which doesn't match the typical
        // 48kHz hardware format. The crash log confirmed this —
        // installTap was the last call before SIGABRT.
        //
        // Solution: tap at the hardware format, then decimate in the
        // tap block to get 16kHz Int16 output. Same algorithm the
        // original JS code used (RESAMPLE_RATIO = 48000/16000 = 3).
        log_event("[mic-capture] build: input_node.outputFormatForBus(0)");
        let format = input_node.outputFormatForBus(0);
        let hw_rate = format.sampleRate();
        log_event(format!(
            "[mic-capture] build: hardware format sampleRate={} channels={}",
            hw_rate,
            format.channelCount()
        ));
        (engine, input_node, format, hw_rate)
    };

    // Resampling ratio from hardware rate to the 16kHz target the
    // daemon expects. Always floats — works for any hw_rate, including
    // non-integer ratios like 24kHz→16kHz (1.5x) or 44.1kHz→16kHz (2.756x).
    // The previous decimation-by-integer approach only handled 48kHz
    // cleanly; at 24kHz it sent audio at the wrong rate and the daemon
    // would have received 24kHz Int16 PCM labeled as 16kHz → STT garbage.
    const TARGET_RATE: f64 = 16000.0;
    let ratio = hw_rate / TARGET_RATE;
    log_event(format!(
        "[mic-capture] build: resample ratio = {:.4} ({}Hz → {}Hz)",
        ratio,
        hw_rate as u32,
        TARGET_RATE as u32
    ));

    // Tap block: receives (AVAudioPCMBuffer *, AVAudioTime *).
    // Linear-interpolate Float32 samples from hw_rate to 16kHz, convert
    // to Int16 PCM, ship via channel. Slightly more compute than raw
    // decimation but voice audio is low-volume so it's negligible.
    let tap = RcBlock::new(
        move |buf: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| unsafe {
            let buffer = buf.as_ref();
            let frames = buffer.frameLength() as usize;
            if frames == 0 {
                return;
            }
            let ch0_ptr = *buffer.floatChannelData();
            let sample_ptr = ch0_ptr.as_ptr();
            // out_frames is the number of OUTPUT samples for 16kHz given
            // this buffer's input frame count. floor() to avoid reading
            // past the input buffer.
            let out_frames = ((frames as f64) / ratio).floor() as usize;
            let mut pcm: Vec<u8> = Vec::with_capacity(out_frames * 2);
            for i in 0..out_frames {
                // Position in the input buffer for output sample i.
                let src_pos = i as f64 * ratio;
                let idx0 = src_pos.floor() as usize;
                let idx1 = (idx0 + 1).min(frames - 1);
                let frac = (src_pos - idx0 as f64) as f32;
                let s0 = *sample_ptr.add(idx0);
                let s1 = *sample_ptr.add(idx1);
                let sample = s0 + (s1 - s0) * frac;
                let clamped = sample.clamp(-1.0, 1.0);
                let int16 = (clamped * 32767.0) as i16;
                pcm.extend_from_slice(&int16.to_le_bytes());
            }
            let _ = on_frame.send(pcm);
        },
    );

    unsafe {
        log_event("[mic-capture] build: installTapOnBus_bufferSize_format_block");
        input_node.installTapOnBus_bufferSize_format_block(
            0,
            1024,
            Some(&format),
            RcBlock::as_ptr(&tap),
        );
        log_event("[mic-capture] build: engine.prepare()");
        engine.prepare();
        log_event("[mic-capture] build: engine.startAndReturnError()");
        // ObjC selector is -startAndReturnError: which objc2-avf-audio
        // maps to startAndReturnError() returning Result<(), NSError>.
        engine.startAndReturnError().map_err(|e| format!("engine.start: {e}"))?;
        log_event("[mic-capture] build: engine started OK");
    }

    // RcBlock is already reference-counted — the engine retains the block
    // internally via installTap, and our RcBlock can be dropped on the
    // Rust side without freeing the block. No mem::forget needed.
    drop(tap);

    Ok(ActiveCapture { engine, _format: format })
}

#[cfg(target_os = "macos")]
fn stop_engine_and_remove_tap(active: ActiveCapture) {
    // ORDER MATTERS. Stop the engine FIRST, then remove the tap.
    //
    // The previous order (removeTap then stop) crashes: when the engine
    // is still running, calling removeTapOnBus can yank the tap block
    // out from under an in-flight audio callback. The callback is
    // mid-execution (reading samples, building the PCM Vec, calling
    // on_frame.send) when its memory is freed — classic use-after-free.
    //
    // engine.stop() is synchronous — once it returns, no more audio
    // callbacks will fire, so removing the tap is safe.
    //
    // inputNode() is marked unsafe in objc2-avf-audio — wrap the
    // whole teardown block so all calls are inside unsafe {}.
    log_event(format!(
        "[mic-capture] stop_engine_and_remove_tap enter, thread: {:?}",
        std::thread::current().id()
    ));
    log_event("[mic-capture] before engine.stop()");
    unsafe {
        active.engine.stop();
    }
    log_event("[mic-capture] after engine.stop(), before inputNode()");
    unsafe {
        let input_node = active.engine.inputNode();
        log_event("[mic-capture] got input_node, before removeTapOnBus");
        input_node.removeTapOnBus(0);
        log_event("[mic-capture] after removeTapOnBus");
    }
    log_event("[mic-capture] stop_engine_and_remove_tap returning, ActiveCapture about to drop");
    // ActiveCapture drops here, releasing the engine + format.
}
