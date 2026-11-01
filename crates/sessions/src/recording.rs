//! Read-only compatibility with `src/session/recording.ts` artifacts.
use crate::framing::{Frame, FrameError, decode_log};
use serde_json::Value;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum RecordingError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Frame(#[from] FrameError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, PartialEq)]
pub struct RecordingRead {
    pub checkpoint: Option<Value>,
    pub frames: Vec<Frame>,
}

/// Returns a gap-free suffix of output bytes, or `None` for invalid/gapped history.
pub fn since(dir: &Path, from: u64, output_offset: u64) -> Option<Vec<Vec<u8>>> {
    if from > 9_007_199_254_740_991 || from > output_offset {
        return None;
    }
    if from == output_offset {
        return Some(Vec::new());
    }
    let mut next = from;
    let mut chunks = Vec::new();
    for name in ["session.log.1", "session.log"] {
        let path = dir.join(name);
        if !path.exists() {
            continue;
        }
        let log = decode_log(&std::fs::read(path).ok()?).ok()?;
        let mut offset = log.header["outputOffset"].as_u64().unwrap_or(0);
        for frame in log.frames.into_iter().filter(|f| f.kind == 1) {
            let end = offset.checked_add(frame.data.len() as u64)?;
            if end > next {
                if offset > next {
                    return None;
                }
                chunks.push(frame.data[(next - offset) as usize..].to_vec());
                next = end;
            }
            offset = end;
        }
    }
    (next == output_offset).then_some(chunks)
}

pub fn read_recording(dir: &Path, from: Option<u64>) -> Result<RecordingRead, RecordingError> {
    let checkpoint: Option<Value> = if dir.join("session.ckpt").exists() {
        Some(serde_json::from_slice(&std::fs::read(
            dir.join("session.ckpt"),
        )?)?)
    } else {
        None
    };
    let current_log = std::fs::read(dir.join("session.log"))
        .map_err(RecordingError::from)
        .and_then(|b| decode_log(&b).map_err(RecordingError::from));
    let current = match current_log {
        Ok(log) => log,
        Err(_) if dir.join("session.log.1").exists() => {
            decode_log(&std::fs::read(dir.join("session.log.1"))?)?
        }
        Err(_) if checkpoint.is_some() => {
            let offset = checkpoint.as_ref().and_then(|c| c["outputOffset"].as_u64());
            return Ok(RecordingRead {
                checkpoint: if from == offset { None } else { checkpoint },
                frames: Vec::new(),
            });
        }
        Err(error) => return Err(error),
    };
    let checkpoint_offset = checkpoint
        .as_ref()
        .and_then(|c| c["outputOffset"].as_u64())
        .unwrap_or(0);
    let generation = checkpoint
        .as_ref()
        .and_then(|c| c["generation"].as_u64())
        .unwrap_or(0);
    let header_offset = current.header["outputOffset"].as_u64();
    let header_generation = current.header["generation"].as_u64().unwrap_or(0);
    let mut offset = header_offset.unwrap_or(if header_generation > generation {
        checkpoint_offset
    } else {
        0
    });
    let mut frames = Vec::new();
    for mut frame in current.frames {
        if frame.kind == 1 {
            let end = offset.saturating_add(frame.data.len() as u64);
            if end > checkpoint_offset {
                let skip = checkpoint_offset.saturating_sub(offset) as usize;
                frame.data.drain(..skip);
                frames.push(frame);
            }
            offset = end;
        } else if offset >= checkpoint_offset {
            frames.push(frame);
        }
    }
    if let Some(from) = from
        && let Some(chunks) = since(dir, from, offset.max(checkpoint_offset))
    {
        return Ok(RecordingRead {
            checkpoint: None,
            frames: chunks
                .into_iter()
                .map(|data| Frame {
                    kind: 1,
                    ms: None,
                    data,
                })
                .collect(),
        });
    }
    let checkpoint = checkpoint.or_else(|| {
        Some(serde_json::json!({
        "generation":current.header["generation"],
        "outputOffset":header_offset.unwrap_or(0),
        "cols":current.header["cols"],"rows":current.header["rows"],
            "scrollbackAnsi":"","screenAnsi":"","modes":{}
        }))
    });
    Ok(RecordingRead { checkpoint, frames })
}
