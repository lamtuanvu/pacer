//! Owned duplex streams (assigned-session input/output), provided to
//! `hostRunner.stream` handlers when the request carries a numeric id, a string
//! `params.streamId` and a string `_meta.capabilityCall`
//! (packages/plugin-sdk/src/index.ts:184-214, 296-300).
//!
//! A stream owner can push output frames with [`OwnedStream::progress`] and
//! pull owned input frames with [`OwnedStream::next_input`], withdrawing only
//! the frames the host delivers for exactly this owner, one at a time, and
//! only after the host acknowledges the connection's `seq`.

use crate::{Host, PluginError, js, wire};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

fn is_hex(bs: &[u8]) -> bool {
    bs.iter().all(u8::is_ascii_hexdigit)
}

/// A v4 UUID with dashes, as the host uses for owned stream ids and handles.
fn is_uuid4(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b[8] == b'-'
        && b[13] == b'-'
        && b[18] == b'-'
        && b[23] == b'-'
        && is_hex(&b[..8])
        && is_hex(&b[9..13])
        && is_hex(&b[14..18])
        && is_hex(&b[19..23])
        && is_hex(&b[24..])
        && b[14] == b'4'
        && matches!(b[19], b'8' | b'9' | b'a' | b'b')
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// One owned input slot, keyed by the numeric request id of its stream owner.
pub(crate) struct StreamInputState {
    pub stream_id: String,
    pub next_seq: u64,
    /// The single available (or delivered) frame; the host delivers exactly
    /// one at a time and clears it on `$/streamInputAck`.
    pub frame: Option<OwnedFrame>,
    /// A `next_input` waiting for the next frame (there is at most one).
    pub waiter: Option<oneshot::Sender<Result<(), PluginError>>>,
}

/// The logical identity of one owned input frame held by the slot.
pub(crate) struct OwnedFrame {
    pub seq: u64,
    pub bytes: Vec<u8>,
    pub delivered: bool,
}

/// The per-connection registry of owned input slots, shared with the `serve`
/// loop so `$/streamInput` notifications are matched to their owner.
#[derive(Default, Clone)]
pub(crate) struct Streams {
    map: Arc<Mutex<HashMap<u64, Arc<Mutex<StreamInputState>>>>>,
}

impl Streams {
    pub(crate) fn lock(&self) -> MutexGuard<'_, HashMap<u64, Arc<Mutex<StreamInputState>>>> {
        lock(&self.map)
    }
}

/// An owned duplex stream handle, available to a `hostRunner.stream` handler
/// through [`crate::Ctx::owned_stream`].
#[derive(Clone)]
pub struct OwnedStream {
    pub(crate) request_id: u64,
    pub(crate) stream_id: String,
    pub(crate) host: Host,
    pub(crate) cancel: CancellationToken,
    pub(crate) streams: Streams,
}

impl OwnedStream {
    /// Push one output frame (`$/progress` then the `$/streamAck` round trip).
    pub async fn progress(&self, stream_id: &str, seq: u64, bytes: &[u8]) -> Result<(), PluginError> {
        if self.cancel.is_cancelled()
            || !is_uuid4(stream_id)
            || bytes.is_empty()
            || bytes.len() > 65_536
        {
            return Err(PluginError::new(
                "capability_denied",
                "invalid owned stream progress frame",
            ));
        }
        self.host.emit(
            "$/progress",
            json!({
                "id": self.request_id,
                "event": {
                    "streamId": stream_id,
                    "seq": seq,
                    "base64": js::base64::encode(bytes),
                }
            }),
        );
        let ack = self
            .host
            .call(
                "$/streamAck",
                json!({
                    "request": self.request_id,
                    "streamId": stream_id,
                    "seq": seq,
                }),
            )
            .await?;
        if ack.get("seq").and_then(Value::as_u64) != Some(seq) {
            return Err(PluginError::new(
                "plugin_refused",
                "invalid stream progress acknowledgement",
            ));
        }
        Ok(())
    }

    /// Withdraw the next owned input frame, waiting for the host to deliver it.
    pub async fn next_input(&self) -> Result<InputFrame, PluginError> {
        let slot = {
            let slots = self.streams.lock();
            match slots.get(&self.request_id) {
                Some(s) => s.clone(),
                None => {
                    return Err(PluginError::new(
                        "capability_denied",
                        "stream input owner is unavailable",
                    ))
                }
            }
        };
        loop {
            // Take the frame if a new undelivered one is present; otherwise
            // (or when its slot is busy) return the next step to take. The
            // guard is always released before this block returns, so it never
            // spans the await in `wait_for_frame`.
            enum Next {
                Wait,
                Busy,
            }
            let next = {
                let mut st = lock(&slot);
                if self.cancel.is_cancelled()
                    || st.frame.as_ref().is_some_and(|f| f.delivered)
                    || st.waiter.is_some()
                {
                    Next::Busy
                } else if st.frame.is_none() {
                    Next::Wait
                } else {
                    let seq = st.frame.as_ref().expect("frame present").seq;
                    let bytes = st.frame.as_ref().expect("frame present").bytes.clone();
                    st.frame.as_mut().expect("frame present").delivered = true;
                    drop(st);
                    return Ok(InputFrame {
                        seq,
                        bytes,
                        stream_id: self.stream_id.clone(),
                        request_id: self.request_id,
                        host: self.host.clone(),
                        streams: self.streams.clone(),
                    });
                }
            };
            match next {
                Next::Busy => {
                    return Err(PluginError::new(
                        "capability_denied",
                        "stream input owner is unavailable",
                    ))
                }
                Next::Wait => self.wait_for_frame(&slot).await?,
            }
        }
    }

    /// Park the current owner until `$/streamInput` delivers a frame or the
    /// connection is cancelled. Never holds a `MutexGuard` across an await.
    async fn wait_for_frame(&self, slot: &Arc<Mutex<StreamInputState>>) -> Result<(), PluginError> {
        let (tx, rx) = oneshot::channel::<Result<(), PluginError>>();
        {
            let mut st = lock(slot);
            if st.waiter.is_some() {
                return Err(PluginError::new(
                    "capability_denied",
                    "stream input owner is unavailable",
                ));
            }
            st.waiter = Some(tx);
        }
        let cancel = self.cancel.clone();
        let slot = slot.clone();
        let mut rx = rx;
        let waited = tokio::select! {
            r = &mut rx => match r {
                Ok(res) => res,
                Err(_) => {
                    let mut s2 = lock(&slot);
                    if s2.waiter.is_some() {
                        s2.waiter = None;
                    }
                    Err(PluginError::new(
                        "plugin_unavailable",
                        "stream input owner ended",
                    ))
                }
            },
            _ = cancel.cancelled() => {
                let mut s2 = lock(&slot);
                if s2.waiter.is_some() {
                    s2.waiter = None;
                }
                Err(PluginError::new(
                    "plugin_unavailable",
                    "stream input owner ended",
                ))
            }
        };
        waited
    }
}

/// One delivered owned input frame. Call [`InputFrame::ack`] after the bytes
/// have been written back to the remote, so the host may retire the frame.
pub struct InputFrame {
    pub(crate) seq: u64,
    pub(crate) bytes: Vec<u8>,
    pub(crate) stream_id: String,
    pub(crate) request_id: u64,
    pub(crate) host: Host,
    pub(crate) streams: Streams,
}

impl InputFrame {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Acknowledge the frame (`$/streamInputAck` then retire the slot). Only
    /// the current delivered frame of this slot may be acknowledged.
    pub async fn ack(self) -> Result<(), PluginError> {
        let tx = self
            .host
            .call(
                "$/streamInputAck",
                json!({
                    "request": self.request_id,
                    "streamId": self.stream_id,
                    "seq": self.seq,
                }),
            )
            .await?;
        let expected = tx.get("seq").and_then(Value::as_u64) == Some(self.seq);
        if !expected {
            return Err(PluginError::new(
                "plugin_refused",
                "invalid stream input acknowledgement",
            ));
        }
        let slots = self.streams.lock();
        if let Some(slot) = slots.get(&self.request_id) {
            let mut st = lock(slot);
            match &st.frame {
                Some(f) if f.seq == self.seq => {
                    st.frame = None;
                    st.next_seq = st.next_seq.saturating_add(1);
                    Ok(())
                }
                _ => Err(PluginError::new(
                    "capability_denied",
                    "stream input frame retired",
                )),
            }
        } else {
            Ok(())
        }
    }
}

/// Build the host → host request payload used by `serve` to install a stream
/// owner and by `tests` to script `$/streamInput`.
pub fn stream_input_notification(request: u64, stream_id: &str, seq: u64, bytes: &[u8]) -> String {
    wire::notification(
        "$/streamInput",
        json!({
            "request": request,
            "streamId": stream_id,
            "seq": seq,
            "base64": js::base64::encode(bytes),
        }),
    )
}