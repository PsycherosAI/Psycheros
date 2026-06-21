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
use std::time::Duration;

use tauri::{ipc::Channel, AppHandle, Runtime, State};

/// Active capture session — engine + format, kept alive to sustain the tap.
/// Stored as `Option<ActiveCapture>` inside `CaptureState`; `None` when
/// capture isn't running.
pub struct ActiveCapture {
    engine: objc2::rc::Retained<objc2_avf_audio::AVAudioEngine>,
    _format: objc2::rc::Retained<objc2_avf_audio::AVAudioFormat>,
}

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
    // Reentrancy guard — if already active, refuse.
    {
        let guard = state.active.lock().map_err(|e| format!("state lock: {e}"))?;
        if guard.is_some() {
            return Err("capture already active".to_string());
        }
    }

    // 1. Request mic permission via AVCaptureDevice.requestAccess — public
    //    API, triggers the system prompt on first call, returns the user's
    //    decision via the completion handler.
    let granted = request_mic_permission().await?;
    if !granted {
        return Err("Microphone permission denied".to_string());
    }

    // 2-5. Build engine, format, install tap, start. Synchronous because
    //      AVAudioEngine methods must be called from a single thread.
    let active = build_and_start_capture(on_frame)?;

    // 6. Stash in state.
    let mut guard = state.active.lock().map_err(|e| format!("state lock: {e}"))?;
    *guard = Some(active);

    Ok(())
}

pub fn platform_stop_capture(state: State<'_, CaptureState>) -> Result<(), String> {
    let mut guard = state.active.lock().map_err(|e| format!("state lock: {e}"))?;
    if let Some(active) = guard.take() {
        stop_engine_and_remove_tap(active);
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
    use objc2_avf_audio::{
        AVAudioCommonFormat, AVAudioEngine, AVAudioFormat, AVAudioPCMBuffer, AVAudioTime,
    };

    let engine = AVAudioEngine::new();
    let input_node = engine.inputNode();

    // Build a 16kHz mono Float32 format. AVAudioEngine auto-inserts an
    // internal converter from the hardware 48kHz — saves us manual
    // decimation.
    let format = AVAudioFormat::alloc().init_with_common_format_sample_rate_channels_interleaved(
        AVAudioCommonFormat::PCMFloat32,
        16000.0,
        1,
        false,
    );

    // Tap block: receives (AVAudioPCMBuffer *, AVAudioTime *).
    // Convert Float32 → Int16 PCM and ship via the channel. RcBlock is
    // heap-allocated and reference-counted — block2 0.6 has no
    // Block::new constructor, only RcBlock::new and StackBlock::new.
    let tap = RcBlock::new(
        move |buf: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
            let buffer = unsafe { buf.as_ref() };
            let frames = buffer.frameLength() as usize;
            // floatChannelData returns a pointer to a *const f32 (one per channel).
            // Mono = single channel, so we deref once.
            let ch0_ptr = unsafe { *buffer.floatChannelData() };
            let mut pcm: Vec<u8> = Vec::with_capacity(frames * 2);
            for i in 0..frames {
                let sample = unsafe { *ch0_ptr.add(i) };
                let clamped = sample.clamp(-1.0, 1.0);
                let int16 = (clamped * 32767.0) as i16;
                pcm.extend_from_slice(&int16.to_le_bytes());
            }
            let _ = on_frame.send(pcm);
        },
    );

    unsafe {
        input_node.installTapOnBus_bufferSize_format_block(
            0,
            1024,
            Some(&format),
            &tap,
        );
        engine.prepare();
        engine.start().map_err(|e| format!("engine.start: {e}"))?;
    }

    // RcBlock is already reference-counted — the engine retains the block
    // internally via installTap, and our RcBlock can be dropped on the
    // Rust side without freeing the block. No mem::forget needed.
    drop(tap);

    Ok(ActiveCapture { engine, _format: format })
}

#[cfg(target_os = "macos")]
fn stop_engine_and_remove_tap(active: ActiveCapture) {
    let input_node = active.engine.inputNode();
    unsafe {
        input_node.removeTapOnBus(0);
        active.engine.stop();
    }
    // ActiveCapture drops here, releasing the engine + format.
}
