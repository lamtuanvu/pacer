use crate::task::{
    StoreError, TaskFilter, TaskStore, archive_month, is_task_id, private_dir, retention_eligible,
    revision,
};
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use pacer_foundation::{
    Ctx,
    lock::{LockError, LockOptions, with_lock},
};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

type Result<T> = std::result::Result<T, StoreError>;

#[derive(Debug, Default)]
pub struct PruneResult {
    pub dry_run: bool,
    pub tasks: Vec<PrunedTask>,
    pub bytes_saved: i64,
    pub working_set_bytes: u64,
}

#[derive(Debug)]
pub struct PrunedTask {
    pub id: String,
    pub archive_path: PathBuf,
    pub files: Vec<PathBuf>,
    pub bytes: u64,
    pub bytes_saved: i64,
}

fn artifact_name(id: &str, name: &str) -> bool {
    name.starts_with(&format!("{id}."))
        && [".log", ".md", ".bundle", ".json"]
            .iter()
            .any(|ext| name.ends_with(ext))
}

fn artifacts(dir: &Path, id: &str, archived: bool) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        let base = if archived {
            name.strip_suffix(".gz").unwrap_or(&name)
        } else {
            &name
        };
        if artifact_name(id, base) {
            names.push(name);
        }
    }
    Ok(names)
}

#[cfg(unix)]
fn signature(path: &Path) -> Result<(u64, u64, i64, i64)> {
    use std::os::unix::fs::MetadataExt;
    let m = fs::symlink_metadata(path)?;
    if !m.is_file() {
        return Err(StoreError::Conflict);
    }
    Ok((
        m.ino(),
        m.size(),
        m.mtime() * 1_000_000_000 + m.mtime_nsec(),
        m.ctime() * 1_000_000_000 + m.ctime_nsec(),
    ))
}

#[cfg(not(unix))]
fn signature(path: &Path) -> Result<(u64, u64, i64, i64)> {
    let m = fs::symlink_metadata(path)?;
    if !m.is_file() {
        return Err(StoreError::Conflict);
    }
    Ok((0, m.len(), 0, 0))
}

fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

fn stage(parent: &Path, prefix: &str) -> Result<PathBuf> {
    for n in 0..64 {
        let candidate = parent.join(format!("{prefix}{}-{n}", std::process::id()));
        #[cfg(unix)]
        let created = {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(&candidate)
        };
        #[cfg(not(unix))]
        let created = fs::create_dir(&candidate);
        match created {
            Ok(()) => {
                private_dir(&candidate)?;
                return Ok(candidate);
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(StoreError::Collision)
}

fn copy_private(from: &Path, to: &Path) -> Result<u64> {
    let mut input = File::open(from)?;
    let mut output = create_private(to)?;
    Ok(io::copy(&mut input, &mut output)?)
}

fn create_private(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}

fn gzip(from: &Path, to: Option<&Path>) -> Result<u64> {
    let mut source = File::open(from)?;
    struct Counted {
        writer: Box<dyn Write>,
        bytes: u64,
    }
    impl Write for Counted {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let written = self.writer.write(bytes)?;
            self.bytes += written as u64;
            Ok(written)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.writer.flush()
        }
    }
    let writer: Box<dyn Write> = match to {
        Some(path) => Box::new(create_private(path)?),
        None => Box::new(io::sink()),
    };
    let mut encoder = GzEncoder::new(Counted { writer, bytes: 0 }, Compression::default());
    // Match createReadStream's 64 KiB chunks: zlib output can vary with the
    // size of each write even when the level and input bytes are identical.
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = source.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        encoder.write_all(&chunk[..read])?;
    }
    Ok(encoder.finish()?.bytes)
}

fn gunzip(from: &Path, to: &Path) -> Result<()> {
    let mut decoder = GzDecoder::new(File::open(from)?);
    let mut output = create_private(to)?;
    io::copy(&mut decoder, &mut output)?;
    Ok(())
}

impl TaskStore {
    fn archive_path(&self, task: &Value) -> Result<PathBuf> {
        let id = task
            .get("id")
            .and_then(Value::as_str)
            .ok_or(StoreError::InvalidRecord)?;
        let created = task
            .get("createdAt")
            .and_then(Value::as_f64)
            .ok_or(StoreError::InvalidRecord)?;
        Ok(self
            .home()
            .join("archive")
            .join(archive_month(created)?)
            .join(id))
    }

    pub fn prune(&mut self, days: i64, dry_run: bool, now: f64) -> Result<PruneResult> {
        if !(0..=9_007_199_254_740_991).contains(&days) {
            return Err(StoreError::InvalidRecord);
        }
        let mut result = PruneResult {
            dry_run,
            ..Default::default()
        };
        if days == 0 {
            return Ok(result);
        }
        let ctx = Ctx::with(
            self.home().into(),
            self.home().into(),
            Default::default(),
            now,
        );
        let lock = LockOptions {
            timeout: Duration::ZERO,
            stale: Duration::from_secs(86_400),
        };
        with_lock(&ctx, "task-retention", lock, || {
            let mut before: Option<String> = None;
            loop {
                let page = self.list(&TaskFilter {
                    states: Some(&[
                        "done",
                        "partial",
                        "failed",
                        "limit",
                        "stopped",
                        "needs_input",
                    ]),
                    settled_before: Some(now - days as f64 * 86_400.0),
                    before: before.as_deref(),
                    limit: Some(25),
                    ..Default::default()
                })?;
                if page.is_empty() {
                    break;
                }
                for task in page {
                    let id = task
                        .get("id")
                        .and_then(Value::as_str)
                        .ok_or(StoreError::InvalidRecord)?;
                    before = Some(id.to_owned());
                    if !retention_eligible(&task, days, now) {
                        continue;
                    }
                    if let Some(entry) = self.prune_one(&task, days, dry_run, now)? {
                        result.bytes_saved += entry.bytes_saved;
                        result.working_set_bytes += entry.bytes;
                        result.tasks.push(entry);
                    }
                }
            }
            Ok(result)
        })
        .map_err(retention_lock_error)?
    }

    fn prune_one(
        &mut self,
        task: &Value,
        days: i64,
        dry_run: bool,
        now: f64,
    ) -> Result<Option<PrunedTask>> {
        let id = task
            .get("id")
            .and_then(Value::as_str)
            .ok_or(StoreError::InvalidRecord)?;
        let id = id.to_owned();
        let task_dir = self.home().join("tasks");
        let names = artifacts(&task_dir, &id, false)?;
        let archive = self.archive_path(task)?;
        let mut stage_dir = None;
        if !dry_run {
            let parent = archive.parent().ok_or(StoreError::InvalidRecord)?;
            private_dir(&self.home().join("archive"))?;
            private_dir(parent)?;
            stage_dir = Some(stage(parent, ".staging-")?);
        }
        let outcome = (|| -> Result<Option<PrunedTask>> {
            let mut sigs = Vec::new();
            let mut bytes = 0;
            let mut archived_bytes = 0;
            for name in &names {
                let source = task_dir.join(name);
                let sig = signature(&source)?;
                bytes += sig.1;
                sigs.push((name.clone(), sig));
                if name.ends_with(".log") {
                    let target = stage_dir.as_ref().map(|dir| dir.join(format!("{name}.gz")));
                    archived_bytes += gzip(&source, target.as_deref())?;
                } else {
                    archived_bytes += sig.1;
                    if let Some(dir) = &stage_dir {
                        copy_private(&source, &dir.join(name))?;
                    }
                }
            }
            let ctx = Ctx::with(
                self.home().into(),
                self.home().into(),
                Default::default(),
                now,
            );
            let applied = with_lock(
                &ctx,
                &format!("task-{id}"),
                LockOptions::default(),
                || -> Result<bool> {
                    let Some(current) = self.read(&id)? else {
                        return Ok(false);
                    };
                    if revision(&current) != revision(task)
                        || !retention_eligible(&current, days, now)
                    {
                        return Ok(false);
                    }
                    for (name, expected) in &sigs {
                        if signature(&task_dir.join(name))? != *expected {
                            return Err(StoreError::Conflict);
                        }
                    }
                    if dry_run {
                        return Ok(true);
                    }
                    if exists(&archive)? {
                        return Err(StoreError::Conflict);
                    }
                    fs::rename(
                        stage_dir.as_ref().ok_or(StoreError::InvalidRecord)?,
                        &archive,
                    )?;
                    stage_dir = None;
                    let path = archive.to_string_lossy().into_owned();
                    self.update_locked(
                        &id,
                        revision(task).ok_or(StoreError::InvalidRecord)?,
                        now,
                        |t| {
                            t["archived"] = json!(true);
                            t["archivePath"] = json!(path);
                        },
                    )?;
                    for name in &names {
                        fs::remove_file(task_dir.join(name))?;
                    }
                    Ok(true)
                },
            )??;
            if !applied {
                return Ok(None);
            }
            Ok(Some(PrunedTask {
                id: id.clone(),
                archive_path: archive,
                files: names.iter().map(|n| task_dir.join(n)).collect(),
                bytes,
                bytes_saved: bytes as i64 - archived_bytes as i64,
            }))
        })();
        if let Some(dir) = stage_dir {
            let _ = fs::remove_dir_all(dir);
        }
        outcome
    }

    pub fn restore(&mut self, id: &str, now: f64) -> Result<Value> {
        if !is_task_id(id) {
            return Err(StoreError::UnknownTask(id.into()));
        }
        let ctx = Ctx::with(
            self.home().into(),
            self.home().into(),
            Default::default(),
            now,
        );
        let lock = LockOptions {
            timeout: Duration::ZERO,
            stale: Duration::from_secs(86_400),
        };
        with_lock(&ctx, "task-retention", lock, || -> Result<Value> {
            let task = self
                .read(id)?
                .ok_or_else(|| StoreError::UnknownTask(id.into()))?;
            if !crate::task::truthy(task.get("archived")) {
                return Ok(task);
            }
            let archive = self.archive_path(&task)?;
            let names = artifacts(&archive, id, true)?;
            let task_dir = self.home().join("tasks");
            private_dir(&task_dir)?;
            let stage_dir = stage(&task_dir, ".restore-")?;
            let outcome = (|| -> Result<Value> {
                let mut sigs = Vec::new();
                let mut files = Vec::new();
                for name in &names {
                    sigs.push((name.clone(), signature(&archive.join(name))?));
                    if name == &format!("{id}.json") {
                        continue;
                    }
                    let target_name = name.strip_suffix(".gz").unwrap_or(name);
                    let target = stage_dir.join(target_name);
                    if name.ends_with(".log.gz") {
                        gunzip(&archive.join(name), &target)?;
                    } else {
                        copy_private(&archive.join(name), &target)?;
                    }
                    files.push(target_name.to_owned());
                }
                with_lock(
                    &ctx,
                    &format!("task-{id}"),
                    LockOptions::default(),
                    || -> Result<Value> {
                        if self.read(id)?.and_then(|v| revision(&v)) != revision(&task) {
                            return Err(StoreError::Conflict);
                        }
                        for (name, expected) in &sigs {
                            if signature(&archive.join(name))? != *expected {
                                return Err(StoreError::Conflict);
                            }
                        }
                        for name in files.iter().chain(std::iter::once(&format!("{id}.json"))) {
                            if exists(&task_dir.join(name))? {
                                return Err(StoreError::Conflict);
                            }
                        }
                        for name in &files {
                            fs::rename(stage_dir.join(name), task_dir.join(name))?;
                        }
                        let restored = self.update_locked(
                            id,
                            revision(&task).ok_or(StoreError::InvalidRecord)?,
                            now,
                            |t| {
                                if let Some(obj) = t.as_object_mut() {
                                    obj.remove("archived");
                                    obj.remove("archivePath");
                                }
                            },
                        )?;
                        for name in &names {
                            fs::remove_file(archive.join(name))?;
                        }
                        if fs::read_dir(&archive)?.next().is_none() {
                            fs::remove_dir(&archive)?;
                        }
                        Ok(restored)
                    },
                )?
            })();
            let _ = fs::remove_dir_all(stage_dir);
            outcome
        })
        .map_err(retention_lock_error)?
    }
}

fn retention_lock_error(error: LockError) -> StoreError {
    match error {
        // Match the TypeScript CoreError message/hint contract for an active retention lock.
        LockError::Timeout(_) => StoreError::Admission("task retention is already running".into()),
        other => StoreError::Lock(other),
    }
}
