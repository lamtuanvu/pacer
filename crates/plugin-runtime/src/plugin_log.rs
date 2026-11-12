//! The plugin log the TypeScript host keeps (`appendPluginLog` in
//! `src/plugins/host.ts`, `readLines` in `src/plugins/lines.ts`). Each stderr
//! line of an owned child goes to `$PACER_HOME/logs/plugins/<id>.log` as
//! `<ISO time> [stderr] <line cut to 4096 UTF-16 units>`. The file is rotated
//! to `.1` once it reaches 1 MiB, and a line over 1 MiB is dropped with a note.
//! Core appends to the same file, both with `O_APPEND`.

use std::{
    borrow::Cow,
    fs,
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::watch,
    time::{Instant, timeout_at},
};

/// A log at least this long is rotated before the next line (`PLUGIN_LOG_MAX_BYTES`).
const PLUGIN_LOG_MAX_BYTES: u64 = 1024 * 1024;
/// A longer stderr line is dropped (`MAX_LINE_BYTES` in `lines.ts`).
const MAX_STDERR_LINE: usize = 1024 * 1024;
const DROP_NOTE: &str = "dropped a line over 1 MiB";
/// UTF-16 units of a line written (`line.slice(0, 4096)`).
const LINE_UNITS: usize = 4096;
/// Bytes of a line held in memory: more than 4096 UTF-16 units of any UTF-8.
const KEPT_BYTES: usize = 4 * LINE_UNITS;
/// How long stderr is still read after the child exited, for a descendant
/// that inherited the pipe.
pub(crate) const DRAIN_AFTER_EXIT: Duration = Duration::from_millis(250);

/// One plugin's log file.
#[derive(Clone, Debug)]
pub(crate) struct PluginLog {
    dir: PathBuf,
    path: PathBuf,
}

impl PluginLog {
    /// `<dir>/<id>.log`, or `None` for an id that is not a plain plugin id.
    pub(crate) fn new(dir: &Path, id: &str) -> Option<Self> {
        let plain = (1..=64).contains(&id.len())
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        plain.then(|| Self {
            dir: dir.to_path_buf(),
            path: dir.join(format!("{id}.log")),
        })
    }

    /// Append `<ISO time> [<tag>] <line>` as `appendPluginLog` does.
    pub(crate) fn append(&self, tag: &str, line: &str) -> io::Result<()> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.dir)?;
        if fs::metadata(&self.path).is_ok_and(|meta| meta.len() >= PLUGIN_LOG_MAX_BYTES) {
            let mut rotated = self.path.clone().into_os_string();
            rotated.push(".1");
            let _ = fs::rename(&self.path, rotated);
        }
        let text = format!("{} [{tag}] {}\n", iso_time(SystemTime::now()), cut(line));
        fs::OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .open(&self.path)?
            .write_all(text.as_bytes())
    }
}

/// `Date.prototype.toISOString`: UTC with milliseconds.
fn iso_time(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let (days, secs) = (since.as_secs() / 86_400, since.as_secs() % 86_400);
    // Civil date from days since 1970-01-01 (Hinnant's `civil_from_days`).
    let z = days + 719_468;
    let (era, doe) = (z / 146_097, z % 146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        secs / 3600,
        secs / 60 % 60,
        secs % 60,
        since.subsec_millis()
    )
}

/// The first 4096 UTF-16 units. A surrogate pair cut in half leaves a lone
/// surrogate in JavaScript, which is written as U+FFFD.
fn cut(line: &str) -> Cow<'_, str> {
    let mut units = 0;
    for (at, c) in line.char_indices() {
        units += c.len_utf16();
        if units > LINE_UNITS {
            let mut kept = line[..at].to_owned();
            if units == LINE_UNITS + 1 && c.len_utf16() == 2 {
                kept.push('\u{FFFD}');
            }
            return kept.into();
        }
    }
    line.into()
}

/// `readLines` over raw bytes: split on `\n`, strip one `\r` from a complete
/// line, drop a line over 1 MiB with a note, and keep only the bytes a line
/// can still show after the cut.
#[derive(Default)]
pub(crate) struct Lines {
    kept: Vec<u8>,
    len: usize,
    dropping: bool,
}

impl Lines {
    pub(crate) fn push(&mut self, bytes: &[u8], out: &mut Vec<String>) {
        for part in bytes.split_inclusive(|byte| *byte == b'\n') {
            let (body, ended) = part
                .strip_suffix(b"\n")
                .map_or((part, false), |body| (body, true));
            if !self.dropping {
                if self.len + body.len() > MAX_STDERR_LINE {
                    self.reset();
                    self.dropping = true;
                    out.push(DROP_NOTE.into());
                } else {
                    let room = KEPT_BYTES.saturating_sub(self.kept.len());
                    self.kept.extend_from_slice(&body[..body.len().min(room)]);
                    self.len += body.len();
                }
            }
            if ended {
                if !self.dropping {
                    if self.len == self.kept.len() && self.kept.last() == Some(&b'\r') {
                        self.kept.pop();
                    }
                    out.push(String::from_utf8_lossy(&self.kept).into_owned());
                }
                self.reset();
                self.dropping = false;
            }
        }
    }

    /// The unterminated last line at end of stream, without stripping `\r`.
    pub(crate) fn finish(&mut self, out: &mut Vec<String>) {
        if !self.dropping && !self.kept.is_empty() {
            out.push(String::from_utf8_lossy(&self.kept).into_owned());
        }
        self.reset();
    }

    fn reset(&mut self) {
        self.kept.clear();
        self.len = 0;
    }
}

/// Append `stderr`'s lines to `log` until the pipe closes, or until
/// [`DRAIN_AFTER_EXIT`] after `exit` publishes the child's exit. The pipe is
/// always read, so the child never blocks on it; dropping the task closes it.
pub(crate) async fn copy_stderr(
    mut stderr: impl AsyncRead + Unpin,
    log: PluginLog,
    mut exit: watch::Receiver<Option<String>>,
) {
    let (mut lines, mut chunk, mut drain) = (Lines::default(), vec![0; 8192], None);
    loop {
        let read = match drain {
            Some(until) => timeout_at(until, stderr.read(&mut chunk)).await.ok(),
            None => tokio::select! {
                read = stderr.read(&mut chunk) => Some(read),
                _ = exit.wait_for(Option::is_some) => {
                    drain = Some(Instant::now() + DRAIN_AFTER_EXIT);
                    continue;
                }
            },
        };
        let mut out = Vec::new();
        let more = match read {
            Some(Ok(read @ 1..)) => {
                lines.push(&chunk[..read], &mut out);
                true
            }
            _ => {
                lines.finish(&mut out);
                false
            }
        };
        if !out.is_empty() {
            let log = log.clone();
            let _ = tokio::task::spawn_blocking(move || {
                for line in out {
                    let _ = log.append("stderr", &line);
                }
            })
            .await;
        }
        if !more {
            return;
        }
    }
}

#[cfg(test)]
mod tests;
