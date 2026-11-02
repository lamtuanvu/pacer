use crate::AdmissionError;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

/// Trusted operation lifetime. Client fields cannot construct this through the
/// brief parser. Cancellation and deadlines may only tighten a parent's bounds.
#[derive(Clone, Default)]
pub struct AdmissionLifetime {
    pub cancelled: Vec<Arc<AtomicBool>>,
    pub deadline: Option<Instant>,
}
impl AdmissionLifetime {
    pub fn tighten(&self, child: &Self) -> Self {
        Self {
            cancelled: self
                .cancelled
                .iter()
                .chain(&child.cancelled)
                .cloned()
                .collect(),
            deadline: self.deadline.into_iter().chain(child.deadline).min(),
        }
    }
    pub fn check(&self) -> Result<(), AdmissionError> {
        if self
            .cancelled
            .iter()
            .any(|flag| flag.load(Ordering::Acquire))
            || self
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(AdmissionError(
                "Admission cancelled or deadline expired".into(),
            ));
        }
        Ok(())
    }
}
#[derive(PartialEq, Eq)]
struct DirectoryIdentity {
    device: u64,
    inode: u64,
}
fn identity(path: &Path) -> Result<DirectoryIdentity, AdmissionError> {
    let meta = fs::metadata(path)?;
    if !meta.is_dir() {
        return Err(AdmissionError(
            "Admission checkout is not a directory".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(DirectoryIdentity {
            device: meta.dev(),
            inode: meta.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        compile_error!("Admission identity requires Unix filesystem identity");
    }
}

/// Policy has completed before this receipt is returned. The host supplies a
/// snapshot of strategy, project revisions, repository identity, parent/root,
/// running revisions, exclusions and policy registry; it is checked again at
/// consumption. The authorized input is private and cannot be amended later.
pub struct PreparedAdmission {
    input: Value,
    context: Value,
    directories: Vec<(PathBuf, DirectoryIdentity)>,
    used: bool,
    lifetime: AdmissionLifetime,
    delegate: bool,
}
impl PreparedAdmission {
    pub fn prepare(
        input: Value,
        paths: &[PathBuf],
        lifetime: Option<AdmissionLifetime>,
        mut context: impl FnMut() -> Result<Value, AdmissionError>,
        mut validate: impl FnMut(&Value) -> Result<(), AdmissionError>,
        policy: impl FnOnce(&Value) -> Result<Value, AdmissionError>,
    ) -> Result<Self, AdmissionError> {
        let lifetime = lifetime.unwrap_or_default();
        lifetime.check()?;
        validate(&input)?;
        let mut directories = Vec::new();
        for path in paths {
            if !directories.iter().any(|(p, _)| p == path) {
                directories.push((path.clone(), identity(path)?));
            }
        }
        let snapshot = crate::semantics::js_numbers(&context()?);
        let authorized = policy(&input)?;
        let receipt = Self {
            input: authorized,
            context: snapshot,
            directories,
            used: false,
            lifetime,
            delegate: false,
        };
        receipt.revalidate(&mut context, &mut validate)?;
        Ok(receipt)
    }
    /// Full delegation preparation. `snapshot` is host-owned and includes
    /// strategy, projects, repo, exclusions, parent/root and policy revisions.
    pub fn prepare_delegate(
        mut input: Value,
        paths: &[PathBuf],
        lifetime: Option<AdmissionLifetime>,
        mut snapshot: impl FnMut() -> Result<Value, AdmissionError>,
        policy: impl FnOnce(&Value) -> Result<Value, AdmissionError>,
    ) -> Result<Self, AdmissionError> {
        let initial = crate::semantics::js_numbers(&snapshot()?);
        validate_delegate(&initial, &input)?;
        if let Some(runner) = input["executor"]
            .as_str()
            .and_then(|id| crate::resolve_runner(&initial["strategy"], id))
        {
            input["executor"] = runner["id"].clone();
        }
        let mut all_paths = paths.to_vec();
        if let Some(repo) = input.pointer("/brief/repo").and_then(Value::as_str) {
            all_paths.push(PathBuf::from(repo));
        }
        if let Some(reuse) = input["reuseWorktree"].as_str() {
            all_paths.push(PathBuf::from(reuse));
        }
        let original = input.clone();
        let mut receipt = Self::prepare(
            input,
            &all_paths,
            lifetime,
            || {
                let current = crate::semantics::js_numbers(&snapshot()?);
                if !same_context(&current, &initial)? {
                    return Err(AdmissionError::conflict("Admission context changed"));
                }
                Ok(current)
            },
            |candidate| validate_delegate(&initial, candidate),
            |candidate| {
                let authorized = policy(candidate)?;
                validate_amendment(&initial, &original, &authorized)?;
                Ok(authorized)
            },
        )?;
        receipt.delegate = true;
        Ok(receipt)
    }
    pub(crate) fn work_options(&self) -> Option<Value> {
        self.input
            .get("dispatch")
            .filter(|value| crate::strategy::truthy(value))
            .cloned()
            .or_else(|| {
                crate::strategy::truthy(&self.context["strategy"]["dispatch"])
                    .then(|| serde_json::json!({}))
            })
    }
    pub fn input(&self) -> Value {
        self.input.clone()
    }
    fn revalidate(
        &self,
        context: &mut impl FnMut() -> Result<Value, AdmissionError>,
        validate: &mut impl FnMut(&Value) -> Result<(), AdmissionError>,
    ) -> Result<(), AdmissionError> {
        self.lifetime.check()?;
        for (path, original) in &self.directories {
            let current = identity(path).map_err(|_| {
                AdmissionError::conflict(
                    "Repository became unavailable during delegation admission",
                )
            })?;
            if &current != original {
                return Err(AdmissionError::conflict(
                    "Repository changed during delegation admission",
                ));
            }
        }
        let current = crate::semantics::js_numbers(&context()?);
        if !same_context(&current, &self.context)? {
            return Err(AdmissionError::conflict("Admission context changed"));
        }
        if self.delegate {
            validate_delegate(&current, &self.input)?;
        }
        validate(&self.input)?;
        self.lifetime.check()
    }
    /// Rust effects are synchronous. The permit borrows the receipt, so neither
    /// its input nor its guard can escape the active consumption scope.
    pub fn consume<T>(
        &mut self,
        mut context: impl FnMut() -> Result<Value, AdmissionError>,
        mut validate: impl FnMut(&Value) -> Result<(), AdmissionError>,
        effect: impl FnOnce(&Value) -> Result<T, AdmissionError>,
    ) -> Result<T, AdmissionError> {
        self.consume_checked(&mut context, &mut validate, |input, _| effect(input))
    }
    pub fn consume_checked<T>(
        &mut self,
        mut context: impl FnMut() -> Result<Value, AdmissionError>,
        mut validate: impl FnMut(&Value) -> Result<(), AdmissionError>,
        effect: impl FnOnce(
            &Value,
            &mut dyn FnMut() -> Result<(), AdmissionError>,
        ) -> Result<T, AdmissionError>,
    ) -> Result<T, AdmissionError> {
        if self.used {
            return Err(AdmissionError::conflict(
                "Delegation admission was already consumed",
            ));
        }
        self.used = true;
        self.revalidate(&mut context, &mut validate)?;
        let mut guard = || self.revalidate(&mut context, &mut validate);
        guard()?;
        effect(&self.input, &mut guard)
    }
}

fn validate_delegate(snapshot: &Value, input: &Value) -> Result<(), AdmissionError> {
    let repo = snapshot.get("repo").filter(|v| !v.is_null());
    crate::validate_current(
        &snapshot["strategy"],
        input,
        &snapshot["projects"],
        repo,
        &snapshot["exclusions"],
    )
}
fn validate_amendment(
    snapshot: &Value,
    original: &Value,
    authorized: &Value,
) -> Result<(), AdmissionError> {
    let mut allowed = original.clone();
    for key in ["kind", "executor", "worktree"] {
        if let Some(value) = authorized.get(key) {
            allowed[key] = value.clone();
        } else if let Some(map) = allowed.as_object_mut() {
            map.remove(key);
        }
    }
    if let Some(kind) = authorized.pointer("/dispatch/kind") {
        allowed["dispatch"]["kind"] = kind.clone();
    } else if let Some(dispatch) = allowed.get_mut("dispatch").and_then(Value::as_object_mut) {
        dispatch.remove("kind");
    }
    if &allowed != authorized {
        return Err(AdmissionError(
            "Policy cannot amend immutable delegation fields".into(),
        ));
    }
    if authorized["executor"] != original["executor"] {
        return Err(AdmissionError(
            "Executor amendments are refused: the host chooses the executor".into(),
        ));
    }
    if let Some(id) = authorized["executor"].as_str()
        && !snapshot["strategy"]["runners"]
            .as_object()
            .is_some_and(|r| r.contains_key(id))
    {
        return Err(AdmissionError(
            "Policy selected an ineligible executor".into(),
        ));
    }
    let placement = authorized["worktree"].as_str().unwrap_or("auto");
    let original_placement = original["worktree"].as_str().unwrap_or("auto");
    if !["auto", "current", "new"].contains(&placement)
        || (placement != original_placement && placement != "new")
        || ((original.get("workParent").is_some() || original.get("reuseWorktree").is_some())
            && placement != original_placement)
    {
        return Err(AdmissionError(
            "Policy selected an invalid placement".into(),
        ));
    }
    validate_delegate(snapshot, authorized)
}

// TS receipts compare JSON.stringify snapshots: object insertion order matters
// (runner/project order affects routing), while all numbers are binary64.
fn same_context(a: &Value, b: &Value) -> Result<bool, AdmissionError> {
    Ok(crate::semantics::stringify(a)? == crate::semantics::stringify(b)?)
}
