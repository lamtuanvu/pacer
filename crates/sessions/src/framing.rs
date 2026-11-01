//! `src/session/framing.ts` v1 log and socket format.
use serde::{Deserialize, Serialize};

pub const MAX_FRAME: usize = 16 * 1024 * 1024;
const MAGIC: &[u8; 8] = b"PACERTTY";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FrameError {
    #[error("invalid session log header")]
    InvalidHeader,
    #[error("incomplete session log header")]
    IncompleteHeader,
    #[error("session frame too large")]
    TooLarge,
    #[error("invalid session log JSON: {0}")]
    InvalidJson(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogHeader {
    pub cols: u32,
    pub rows: u32,
    pub started_at: f64,
    pub generation: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_offset: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub ms: Option<u32>,
    pub data: Vec<u8>,
}

#[derive(Debug, PartialEq)]
pub struct DecodedLog {
    pub header: serde_json::Value,
    pub frames: Vec<Frame>,
    pub valid_bytes: usize,
}

pub fn encode_header(header: &LogHeader) -> Result<Vec<u8>, serde_json::Error> {
    let mut value = serde_json::to_value(header)?;
    // JS JSON.stringify emits an integral number without `.0`.
    if header.started_at.fract() == 0.0 && header.started_at.abs() <= 9_007_199_254_740_991.0 {
        value["startedAt"] = serde_json::json!(header.started_at as i64);
    }
    let json = serde_json::to_vec(&value)?;
    let mut out = Vec::with_capacity(13 + json.len());
    out.extend_from_slice(MAGIC);
    out.push(1);
    out.extend_from_slice(&(json.len() as u32).to_be_bytes());
    out.extend_from_slice(&json);
    Ok(out)
}

pub fn encode_record(kind: u8, ms: f64, data: &[u8]) -> Vec<u8> {
    let time = if ms.is_nan() || ms < 0.0 {
        0
    } else if ms > u32::MAX as f64 {
        u32::MAX
    } else {
        ms.floor() as u32
    };
    let mut out = Vec::with_capacity(9 + data.len());
    out.push(kind);
    out.extend_from_slice(&time.to_be_bytes());
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(data);
    out
}

pub fn decode_log(bytes: &[u8]) -> Result<DecodedLog, FrameError> {
    if bytes.len() < 13 || &bytes[..8] != MAGIC || bytes[8] != 1 {
        return Err(FrameError::InvalidHeader);
    }
    let n = u32::from_be_bytes(
        bytes[9..13]
            .try_into()
            .map_err(|_| FrameError::InvalidHeader)?,
    ) as usize;
    if n > MAX_FRAME || bytes.len() < 13 + n {
        return Err(FrameError::IncompleteHeader);
    }
    let header: serde_json::Value = serde_json::from_slice(&bytes[13..13 + n])
        .map_err(|e| FrameError::InvalidJson(e.to_string()))?;
    let mut pos = 13 + n;
    let mut frames = Vec::new();
    while pos + 9 <= bytes.len() {
        let len = u32::from_be_bytes(
            bytes[pos + 5..pos + 9]
                .try_into()
                .map_err(|_| FrameError::InvalidHeader)?,
        ) as usize;
        if len > MAX_FRAME {
            return Err(FrameError::TooLarge);
        }
        if pos + 9 + len > bytes.len() {
            break;
        }
        frames.push(Frame {
            kind: bytes[pos],
            ms: Some(u32::from_be_bytes(
                bytes[pos + 1..pos + 5]
                    .try_into()
                    .map_err(|_| FrameError::InvalidHeader)?,
            )),
            data: bytes[pos + 9..pos + 9 + len].to_vec(),
        });
        pos += 9 + len;
    }
    Ok(DecodedLog {
        header,
        frames,
        valid_bytes: pos,
    })
}

pub fn wire(kind: u8, data: &[u8]) -> Result<Vec<u8>, FrameError> {
    if data.len() > MAX_FRAME {
        return Err(FrameError::TooLarge);
    }
    let mut out = Vec::with_capacity(5 + data.len());
    out.push(kind);
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(data);
    Ok(out)
}

#[derive(Default)]
pub struct WireDecoder {
    pending: Vec<u8>,
}

impl WireDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Frame>, FrameError> {
        self.pending.extend_from_slice(bytes);
        let mut frames = Vec::new();
        let mut pos = 0;
        while self.pending.len() - pos >= 5 {
            let len = u32::from_be_bytes(
                self.pending[pos + 1..pos + 5]
                    .try_into()
                    .map_err(|_| FrameError::TooLarge)?,
            ) as usize;
            if len > MAX_FRAME {
                return Err(FrameError::TooLarge);
            }
            if self.pending.len() - pos < 5 + len {
                break;
            }
            frames.push(Frame {
                kind: self.pending[pos],
                ms: None,
                data: self.pending[pos + 5..pos + 5 + len].to_vec(),
            });
            pos += 5 + len;
        }
        self.pending.drain(..pos);
        Ok(frames)
    }
}
