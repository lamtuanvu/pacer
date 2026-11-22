//! Isolated experiment only: copy into a scratch crate, never the production workspace.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::io::{self, Read};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let corpus: Value = serde_json::from_str(&input)?;
    let streams = corpus["streams"]
        .as_array()
        .ok_or("streams must be an array")?;
    let mut entries = Vec::new();
    for stream in streams {
        let data = stream["data"]
            .as_str()
            .ok_or("data must be text")?
            .as_bytes();
        let sizes = stream["chunkSizes"]
            .as_array()
            .ok_or("chunkSizes must be an array")?;
        if sizes.is_empty() {
            return Err("chunk sizes cannot be empty".into());
        }
        let mut parser = vt100::Parser::new(
            std::num::NonZeroU16::new(40).ok_or("invalid rows")?,
            std::num::NonZeroU16::new(120).ok_or("invalid cols")?,
            5000,
        );
        let mut offset = 0;
        let mut index = 0;
        while offset < data.len() {
            let size = sizes[index % sizes.len()]
                .as_u64()
                .ok_or("invalid chunk size")? as usize;
            if size == 0 {
                return Err("zero chunk size".into());
            }
            let end = data.len().min(offset + size);
            parser.process(&data[offset..end]);
            offset = end;
            index += 1;
        }
        let screen = parser.screen();
        // Explicit alternate-buffer selection is necessary before repainting.
        let mut replay = Vec::new();
        if screen.alternate_screen() {
            replay.extend_from_slice(b"\x1b[?1049h");
        }
        replay.extend_from_slice(screen.contents_formatted().as_bytes());
        replay.extend_from_slice(screen.cursor_state_formatted().as_bytes());
        replay.extend_from_slice(screen.attributes_formatted().as_bytes());
        replay.extend_from_slice(screen.input_mode_formatted().as_bytes());
        entries.push(json!({"id":stream["id"],"replayBase64":STANDARD.encode(replay)}));
    }
    println!(
        "{}",
        json!({"schema":1,"engine":"vt100","version":"0.18.1",
        "corpusSha256":corpus["corpusSha256"],"entries":entries})
    );
    Ok(())
}
