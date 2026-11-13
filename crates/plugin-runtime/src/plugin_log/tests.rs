#![allow(clippy::unwrap_used)]
use super::*;
use std::os::unix::fs::PermissionsExt;

fn split(chunks: &[&[u8]]) -> Vec<String> {
    let (mut lines, mut out) = (Lines::default(), Vec::new());
    for chunk in chunks {
        lines.push(chunk, &mut out);
    }
    lines.finish(&mut out);
    out
}

/// Each line with its `<ISO time> ` prefix checked and removed.
fn logged(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| {
            let (time, rest) = line.split_once(' ').unwrap();
            let shape = time.bytes().enumerate().all(|(i, b)| match i {
                4 | 7 => b == b'-',
                10 => b == b'T',
                13 | 16 => b == b':',
                19 => b == b'.',
                23 => b == b'Z',
                _ => b.is_ascii_digit(),
            });
            assert!(time.len() == 24 && shape, "not an ISO time: {line}");
            rest.to_owned()
        })
        .collect()
}

#[test]
fn iso_time_matches_to_iso_string() {
    let at = |ms: u64| iso_time(UNIX_EPOCH + Duration::from_millis(ms));
    assert_eq!(at(0), "1970-01-01T00:00:00.000Z");
    // new Date(1709164800123).toISOString(), a leap day.
    assert_eq!(at(1_709_164_800_123), "2024-02-29T00:00:00.123Z");
    assert_eq!(at(951_868_799_999), "2000-02-29T23:59:59.999Z");
    assert_eq!(at(951_868_800_000), "2000-03-01T00:00:00.000Z");
    assert_eq!(at(1_794_492_245_007), "2026-11-12T14:04:05.007Z");
    assert_eq!(at(4_102_444_800_000), "2100-01-01T00:00:00.000Z");
}

#[test]
fn lines_split_strip_cr_and_keep_empty_lines() {
    assert_eq!(
        split(&[b"one\r\ntw", b"o\n\nthree\r\r\n"]),
        ["one", "two", "", "three\r"]
    );
    assert_eq!(split(&[b"\n"]), [""]);
    assert!(split(&[b""]).is_empty());
}

#[test]
fn partial_last_line_is_flushed_without_stripping_cr() {
    assert_eq!(split(&[b"done\nlast"]), ["done", "last"]);
    assert_eq!(split(&[b"last\r"]), ["last\r"]);
}

#[test]
fn oversize_line_is_dropped_with_one_note() {
    let limit = vec![b'a'; MAX_STDERR_LINE];
    let over = vec![b'b'; MAX_STDERR_LINE + 1];
    let out = split(&[&limit, b"\n", &over[..10], &over[10..], b"\nafter\n"]);
    assert_eq!(out.len(), 3);
    assert_eq!(
        out[0].len(),
        KEPT_BYTES,
        "a 1 MiB line is kept, cut in memory"
    );
    assert_eq!(&out[1..], [DROP_NOTE, "after"]);
    // A line over the limit with no newline before end of stream leaves only the note.
    assert_eq!(split(&[&over]), [DROP_NOTE]);
    // `\r` counts toward the limit, as in `readLines`.
    assert_eq!(split(&[&limit, b"\r\n"]), [DROP_NOTE]);
}

#[test]
fn cut_keeps_4096_utf16_units() {
    let ascii = "x".repeat(5000);
    assert_eq!(cut(&ascii).len(), 4096);
    assert_eq!(cut(&"x".repeat(4096)).len(), 4096);
    let straddles = format!("{}😀tail", "x".repeat(4095));
    assert_eq!(cut(&straddles), format!("{}\u{FFFD}", "x".repeat(4095)));
    let fits = format!("{}😀tail", "x".repeat(4094));
    assert_eq!(cut(&fits), format!("{}😀", "x".repeat(4094)));
    let bmp = "é".repeat(5000);
    assert_eq!(cut(&bmp).chars().count(), 4096);
}

#[test]
fn append_writes_the_typescript_line_with_private_modes() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("logs").join("plugins");
    let log = PluginLog::new(&dir, "fx-good").unwrap();
    log.append("stderr", "hello").unwrap();
    log.append("stderr", &"y".repeat(5000)).unwrap();
    let path = dir.join("fx-good.log");
    assert_eq!(
        logged(&path),
        [
            "[stderr] hello".to_owned(),
            format!("[stderr] {}", "y".repeat(4096))
        ]
    );
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&path), 0o600);
    assert_eq!(mode(&dir), 0o700);
}

#[test]
fn rotation_at_one_mib_keeps_one_generation() {
    let dir = tempfile::tempdir().unwrap();
    let log = PluginLog::new(dir.path(), "fx").unwrap();
    let path = dir.path().join("fx.log");
    let rotated = dir.path().join("fx.log.1");
    fs::write(&path, vec![b'a'; 1024 * 1024 - 1]).unwrap();
    log.append("stderr", "below").unwrap();
    assert!(!rotated.exists(), "under 1 MiB the file grows");
    fs::write(&path, vec![b'a'; 1024 * 1024]).unwrap();
    fs::write(&rotated, "older generation").unwrap();
    log.append("stderr", "rotated").unwrap();
    assert_eq!(fs::metadata(&rotated).unwrap().len(), PLUGIN_LOG_MAX_BYTES);
    assert_eq!(logged(&path), ["[stderr] rotated"]);
}

#[test]
fn only_plain_plugin_ids_get_a_log() {
    let dir = Path::new("/nonexistent");
    assert!(PluginLog::new(dir, "fx-good-2").is_some());
    for id in ["", "../x", "a/b", "Up", "a.b", &"a".repeat(65)] {
        assert!(PluginLog::new(dir, id).is_none(), "{id}");
    }
}

#[tokio::test]
async fn copy_stderr_drains_then_stops_after_exit() {
    let dir = tempfile::tempdir().unwrap();
    let log = PluginLog::new(dir.path(), "fx").unwrap();
    // A descendant can keep the write end open after the child exited.
    let (reader, mut writer) = tokio::io::duplex(64);
    let (exit_tx, exit) = watch::channel(None);
    let copy = tokio::spawn(copy_stderr(reader, log, exit));
    tokio::io::AsyncWriteExt::write_all(&mut writer, b"before\npart")
        .await
        .unwrap();
    exit_tx.send_replace(Some("exited with code 0".into()));
    let stopped = tokio::time::timeout(DRAIN_AFTER_EXIT * 4, copy).await;
    assert!(stopped.is_ok(), "the reader outlived the child");
    for _ in 0..4 {
        let late = tokio::io::AsyncWriteExt::write_all(&mut writer, &[b'x'; 64]).await;
        assert!(late.is_ok(), "a late write fails once the reader stops");
    }
    drop(writer);
    assert_eq!(
        logged(&dir.path().join("fx.log")),
        ["[stderr] before", "[stderr] part"]
    );
}
