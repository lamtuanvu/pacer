//! Workspace dependency policy (CRATE-2, CRATE-4, CRATE-5, CRATE-6).
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    process::Command,
};

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum Layer {
    Number(u32),
    Named(String),
}
impl std::fmt::Display for Layer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Number(n) => write!(f, "{n}"),
            Self::Named(s) => write!(f, "{s}"),
        }
    }
}
#[derive(Debug, Deserialize)]
pub struct CratePolicy {
    pub layer: Layer,
    #[serde(default)]
    pub generated: bool,
    #[serde(default)]
    pub binary: bool,
    #[serde(default)]
    pub heavy: Vec<String>,
}
#[derive(Debug, Deserialize)]
pub struct Limits {
    pub target: usize,
    pub warn: usize,
    pub max: usize,
    pub foundation_max: usize,
    pub binary_max: usize,
    pub generated_max: usize,
}
#[derive(Debug, Deserialize)]
pub struct Heavy {
    pub names: Vec<String>,
}
#[derive(Debug, Deserialize)]
pub struct Policy {
    pub limits: Limits,
    pub heavy: Heavy,
    pub crates: BTreeMap<String, CratePolicy>,
}
impl Policy {
    pub fn from_toml(source: &str) -> Result<Self, toml::de::Error> {
        toml::from_str(source)
    }
}
#[derive(Debug)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub internal: bool,
    pub dev: bool,
}
impl Edge {
    pub fn internal(from: &str, to: &str) -> Self {
        Self {
            from: from.into(),
            to: to.into(),
            internal: true,
            dev: false,
        }
    }
    pub fn external(from: &str, to: &str) -> Self {
        Self {
            internal: false,
            ..Self::internal(from, to)
        }
    }
}

pub fn check(policy: &Policy, edges: &[Edge]) -> Vec<String> {
    let mut errors = Vec::new();
    for edge in edges {
        let Some(from) = policy.crates.get(&edge.from) else {
            errors.push(format!("CRATE-4: unknown workspace crate {}", edge.from));
            continue;
        };
        if edge.internal {
            let Some(to) = policy.crates.get(&edge.to) else {
                errors.push(format!("CRATE-4: unknown workspace crate {}", edge.to));
                continue;
            };
            // The M1 composition chain is explicitly required by Task 1 and its tests.
            let composition = matches!(
                (edge.from.as_str(), edge.to.as_str()),
                ("pacer", "pacer-cli") | ("pacer-cli", "pacer-server")
            );
            if matches!(
                edge.to.as_str(),
                "pacer" | "pacer-cli" | "pacer-server" | "pacer-tui"
            ) && !composition
            {
                errors.push(format!(
                    "CRATE-4: {} depends on composition crate {}",
                    edge.from, edge.to
                ));
            }
            if !edge.dev {
                let allowed = match (&from.layer, &to.layer) {
                    (Layer::Named(s), _) if s == "tool" => true,
                    (Layer::Named(s), Layer::Named(t)) if s == "sdk" => t == "sdk",
                    (Layer::Named(s), Layer::Number(n)) if s == "sdk" => *n == 0,
                    (Layer::Named(s), Layer::Named(t)) if s == "plugin" => t == "sdk",
                    (Layer::Number(a), Layer::Number(b)) => b < a,
                    _ => false,
                };
                if !allowed {
                    errors.push(format!(
                        "CRATE-4: {} (layer {}) depends on {} (layer {})",
                        edge.from, from.layer, edge.to, to.layer
                    ));
                }
            }
        } else if !edge.dev
            && policy.heavy.names.contains(&edge.to)
            && !from.heavy.contains(&edge.to)
        {
            errors.push(format!(
                "CRATE-5: {} may not depend on heavy crate {}",
                edge.from, edge.to
            ));
        }
        if edge.from == "pacer-foundation"
            && !edge.dev
            && !matches!(
                edge.to.as_str(),
                "pacer-client-protocol" | "serde" | "serde_json" | "thiserror" | "tokio"
            )
        {
            errors.push(format!("CRATE-2: foundation may not depend on {}", edge.to));
        }
    }
    errors
}

#[derive(Debug, Deserialize)]
pub struct Metadata {
    pub packages: Vec<Package>,
    pub workspace_members: Vec<String>,
}
#[derive(Debug, Deserialize)]
pub struct Package {
    pub id: String,
    pub name: String,
    pub manifest_path: String,
    pub dependencies: Vec<Dependency>,
    pub features: BTreeMap<String, Vec<String>>,
}
#[derive(Debug, Deserialize)]
pub struct Dependency {
    pub name: String,
    pub rename: Option<String>,
    pub kind: Option<String>,
    pub optional: bool,
    pub path: Option<String>,
}

pub fn metadata(root: &Path) -> Result<Metadata, Box<dyn std::error::Error>> {
    let output = Command::new("cargo")
        .current_dir(root)
        .args(["metadata", "--format-version", "1", "--no-deps"])
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "cargo metadata failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

pub fn check_metadata(policy: &Policy, metadata: &Metadata) -> Vec<String> {
    let members: Vec<_> = metadata
        .packages
        .iter()
        .filter(|p| metadata.workspace_members.contains(&p.id))
        .collect();
    let mut errors = Vec::new();
    let mut edges = Vec::new();
    for package in &members {
        if !policy.crates.contains_key(&package.name) {
            errors.push(format!("CRATE-4: unknown workspace crate {}", package.name));
        }
        let defaults = default_features(&package.features);
        if defaults.contains("wasm") {
            errors.push(format!("CRATE-6: {} enables wasm by default", package.name));
        }
        for dep in &package.dependencies {
            let internal = dep.path.as_ref().is_some_and(|path| {
                members
                    .iter()
                    .any(|p| Path::new(&p.manifest_path).parent() == Some(Path::new(path)))
            });
            let dev = dep.kind.as_deref() == Some("dev");
            edges.push(Edge {
                from: package.name.clone(),
                to: dep.name.clone(),
                internal,
                dev,
            });
            let alias = dep.rename.as_ref().unwrap_or(&dep.name);
            let enabled = defaults.contains(alias)
                || defaults.contains(&format!("dep:{alias}"))
                || defaults.iter().any(|f| f.starts_with(&format!("{alias}/")));
            if !dev
                && dep.optional
                && enabled
                && (policy.heavy.names.contains(&dep.name) || dep.name == "pacer-wasm-host")
            {
                errors.push(format!(
                    "CRATE-6: {} enables optional subsystem {} by default",
                    package.name, dep.name
                ));
            }
            if package.name == "pacer-foundation"
                && dep.name == "tokio"
                && !dev
                && (!dep.optional || enabled)
            {
                errors.push("CRATE-2: foundation tokio must be optional and off by default".into());
            }
        }
    }
    errors.extend(check(policy, &edges));
    errors
}

fn default_features(features: &BTreeMap<String, Vec<String>>) -> BTreeSet<String> {
    let mut visited = BTreeSet::new();
    let mut pending = vec!["default".to_owned()];
    while let Some(feature) = pending.pop() {
        if visited.insert(feature.clone())
            && let Some(children) = features.get(&feature)
        {
            pending.extend(children.iter().cloned());
        }
    }
    visited
}
