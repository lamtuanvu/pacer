//! OpenCode discovery (`opencodeModels` in `src/models/available.ts` and
//! `opencodeModelIds` in `src/endpoints/detect.ts`): `opencode models` run as
//! Core's `ctx.run` runs it, the `<provider>/` lines, catalog facts, and the
//! best-effort listing cache.
use crate::{
    AvailableModel, Discovery, Listing,
    available::cache_file,
    catalog::{self, Entry},
};
use pacer_js_json::{js_semantics::trim, quoted};
use std::{
    ffi::OsString,
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::{io::AsyncReadExt, task::JoinHandle};

/// `ctx.run(["opencode", "models"], 90000)`.
pub const TIMEOUT: Duration = Duration::from_secs(90);
/// After a timeout kill, `execProcess` waits this long for the streams.
const GRACE: Duration = Duration::from_secs(2);

/// What Core's `defaultRun` gives a subprocess: Core's `process.env` and
/// `process.cwd()`. The front door records it when it starts the core child.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreProcess {
    pub env: Vec<(OsString, OsString)>,
    pub cwd: PathBuf,
}

static CORE_PROCESS: RwLock<Option<Arc<CoreProcess>>> = RwLock::new(None);

/// Record (or clear) the core child's environment and working directory.
/// Without a record, discovery stays with TypeScript.
pub fn set_core_process(process: Option<CoreProcess>) {
    if let Ok(mut slot) = CORE_PROCESS.write() {
        *slot = process.map(Arc::new);
    }
}

pub fn core_process() -> Option<Arc<CoreProcess>> {
    CORE_PROCESS.read().ok().and_then(|slot| slot.clone())
}

/// Kills the process group unless the run finished; a dropped request must not leave OpenCode running.
struct Group(Option<u32>);
impl Group {
    fn kill(&self) {
        if let Some(pid) = self
            .0
            .and_then(|p| rustix::process::Pid::from_raw(p as i32))
        {
            let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
        }
    }
}
impl Drop for Group {
    fn drop(&mut self) {
        self.kill();
    }
}

async fn drain<R: AsyncReadExt + Unpin>(reader: Option<R>) -> Vec<u8> {
    let mut bytes = Vec::new();
    if let Some(mut reader) = reader {
        let _ = reader.read_to_end(&mut bytes).await;
    }
    bytes
}

/// The exit status and stdout; a descendant holding a pipe keeps this pending.
async fn finish(
    child: &mut tokio::process::Child,
    out: &mut JoinHandle<Vec<u8>>,
    err: &mut JoinHandle<Vec<u8>>,
) -> (Option<std::process::ExitStatus>, Vec<u8>) {
    let status = child.wait().await.ok();
    let stdout = out.await.unwrap_or_default();
    let _ = err.await;
    (status, stdout)
}

/// `execProcess` for `opencode models` in a new process group: stdout when it
/// exits 0 within `timeout`. A spawn failure, a nonzero exit or a timeout
/// (which kills the group) is `None`. Like TypeScript, stdout is not capped.
pub async fn run_models(process: &CoreProcess, timeout: Duration) -> Option<Vec<u8>> {
    use std::os::unix::process::CommandExt as _;
    let mut command = std::process::Command::new("opencode");
    command
        .arg("models")
        .env_clear()
        .envs(process.env.iter().map(|(k, v)| (k, v)))
        // Tools that resolve paths from $PWD (OpenCode does) must see the child's directory.
        .env("PWD", &process.cwd)
        .current_dir(&process.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    let mut child = command.spawn().ok()?;
    let mut group = Group(child.id());
    let mut out = tokio::spawn(drain(child.stdout.take()));
    let mut err = tokio::spawn(drain(child.stderr.take()));
    let finished = tokio::time::timeout(timeout, finish(&mut child, &mut out, &mut err)).await;
    if finished.is_err() {
        group.kill();
        let _ = tokio::time::timeout(GRACE, finish(&mut child, &mut out, &mut err)).await;
        out.abort();
        err.abort();
    }
    group.0 = None;
    let (status, stdout) = finished.ok()?;
    status.filter(|s| s.success()).map(|_| stdout)
}

/// The `<provider>/` lines of the listing, without the prefix, as
/// TextDecoder, `split(/\r?\n/)` and `trim` read them.
pub fn model_ids(stdout: &[u8], provider: &str) -> Vec<String> {
    let bytes = stdout.strip_prefix(b"\xef\xbb\xbf").unwrap_or(stdout);
    let text = String::from_utf8_lossy(bytes);
    let prefix = format!("{provider}/");
    text.split('\n')
        .map(trim)
        .filter_map(|line| line.strip_prefix(&prefix))
        .map(str::to_owned)
        .collect()
}

/// A unique `<cache>.<uuid>.tmp` name, as `randomUUID()` spells it.
fn temp_name(path: &Path) -> PathBuf {
    let b: [u8; 16] = rand::random();
    let hex = |range: std::ops::Range<usize>| -> String {
        b[range].iter().map(|x| format!("{x:02x}")).collect()
    };
    let mut name = path.as_os_str().to_owned();
    name.push(format!(
        ".{}-{}-4{}-{:x}{}-{}.tmp",
        hex(0..4),
        hex(4..6),
        &hex(6..8)[1..],
        8 | (b[8] & 3),
        &hex(8..10)[2..],
        hex(10..16)
    ));
    PathBuf::from(name)
}

/// `writeCache`: best effort, `wx` temp file (0600) then rename, in a 0700
/// directory; a failure never fails the listing.
fn write_cache(path: &Path, text: &str) {
    let Some(dir) = path.parent() else {
        return;
    };
    if fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .is_err()
    {
        return;
    }
    let temp = temp_name(path);
    let Ok(mut file) = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
    else {
        return;
    };
    let written = file.write_all(text.as_bytes()).is_ok();
    drop(file);
    if !written || fs::rename(&temp, path).is_err() {
        let _ = fs::remove_file(&temp);
    }
}

/// `opencodeModels` after a cache miss: run the CLI, keep the provider's
/// lines, attach catalog facts and cache a non-empty listing. `Unsupported`
/// is a catalog TypeScript would throw on while matching ids.
pub async fn discover(home: &Path, discovery: Discovery, process: &CoreProcess) -> Listing {
    let Discovery { mut base, provider } = discovery;
    let Some(stdout) = run_models(process, TIMEOUT).await else {
        base.note = Some(format!("opencode could not list models for {provider}"));
        return Listing::Known(base);
    };
    let ids = model_ids(&stdout, &provider);
    // An empty listing means sign-in dropped or the provider was renamed: unknown, never "no models".
    if ids.is_empty() {
        base.note = Some(format!(
            "opencode lists no models for {provider}; check opencode auth list"
        ));
        return Listing::Known(base);
    }
    let entry = catalog::entry(home, &provider);
    let mut models = Vec::with_capacity(ids.len());
    for id in ids {
        let mut model = AvailableModel::new(format!("{provider}/{id}"));
        match &entry {
            Entry::Throws => return Listing::Unsupported,
            Entry::Absent => {}
            Entry::Models(items) => match catalog::find(items, &id) {
                Err(()) => return Listing::Unsupported,
                Ok(Some(found)) => catalog::facts(found, &mut model),
                Ok(None) => {}
            },
        }
        models.push(model);
    }
    base.models = Some(models);
    write_cache(
        &cache_file(home, &base.runner),
        &quoted::stringify(&base.to_json()),
    );
    Listing::Known(base)
}
