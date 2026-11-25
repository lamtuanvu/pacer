//! Release manifest and `SHA256SUMS` parsing, mirroring `src/update/manifest.ts`.
//!
//! The TypeScript parser reports every problem it finds, in field order, before it
//! throws. This module keeps that contract: `parse_manifest` collects messages and
//! joins them with `"; "` under one `invalid manifest.json: ` prefix.
use crate::check::is_version;
use pacer_js_json::stringify;
use sha2::Digest;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// The error TypeScript throws for malformed or untrusted release metadata.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ReleaseError(pub String);

/// One of the four released `darwin|linux × arm64|x64` binaries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Platform {
    pub os: &'static str,
    pub arch: &'static str,
}

/// The host we are running on, or `None` on an unsupported platform.
pub fn host_platform() -> Option<Platform> {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return None;
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        return None;
    };
    Some(Platform { os, arch })
}

fn platform(os: &str, arch: &str) -> Option<Platform> {
    let os = match os {
        "darwin" => "darwin",
        "linux" => "linux",
        _ => return None,
    };
    let arch = match arch {
        "arm64" => "arm64",
        "x64" => "x64",
        _ => return None,
    };
    Some(Platform { os, arch })
}

/// `assetFile` in `src/update/manifest.ts`.
pub fn asset_file(p: Platform) -> String {
    format!("pacer-{}-{}", p.os, p.arch)
}

/// `companionFile` in `src/update/manifest.ts`.
pub fn companion_file(p: Platform) -> String {
    format!("pacer-core-{}-{}", p.os, p.arch)
}

/// The native core that travels with the front door.
#[derive(Clone, Debug, PartialEq)]
pub struct Companion {
    pub name: String,
    pub file: String,
    pub sha256: String,
    pub size: u64,
}

/// One release asset, with an optional paired core.
#[derive(Clone, Debug, PartialEq)]
pub struct ReleaseAsset {
    pub os: String,
    pub arch: String,
    pub file: String,
    pub sha256: String,
    pub size: u64,
    pub companions: Option<Vec<Companion>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Manifest {
    pub version: String,
    pub assets: Vec<ReleaseAsset>,
}

/// `String(x)` for the object fields TypeScript folds into its error messages.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map_or_else(|| "NaN".into(), pacer_js_json::number_string),
        // Not used by the release manifest, but keep the coercion total.
        Value::Array(_) | Value::Object(_) => "[object Object]".into(),
    }
}

fn hex64(value: &str, lowercase_only: bool) -> bool {
    value.len() == 64
        && value.bytes().all(|b| {
            b.is_ascii_digit()
                || if lowercase_only {
                    (b'a'..=b'f').contains(&b)
                } else {
                    b.is_ascii_hexdigit()
                }
        })
}

fn positive_integer(value: &Value, safe: bool) -> bool {
    let number = match value.as_i64() {
        Some(n) => n as f64,
        None => match value.as_u64() {
            Some(n) => n as f64,
            None => match value.as_f64() {
                Some(n) => n,
                None => return false,
            },
        },
    };
    number > 0.0
        && number.fract() == 0.0
        && (!safe || number <= 9_007_199_254_740_991.0)
}

/// `JSON.stringify(o.version ?? null)` uses JavaScript serialization, not serde's.
fn shown(value: Option<&Value>) -> String {
    stringify(value.unwrap_or(&Value::Null))
}

/// `parseManifest`: validate every asset and companion, then report all problems at once.
pub fn parse_manifest(raw: &Value) -> Result<Manifest, ReleaseError> {
    let mut problems: Vec<String> = Vec::new();
    let object = raw.as_object();
    let field = |key: &str| -> Option<&Value> { object.and_then(|o| o.get(key)) };

    let version = field("version")
        .and_then(Value::as_str)
        .filter(|v| is_version(v));
    if version.is_none() {
        problems.push(format!(
            "version must be MAJOR.MINOR.PATCH (got {})",
            shown(field("version"))
        ));
    }

    let mut assets = Vec::new();
    match field("assets").and_then(Value::as_array) {
        Some(list) if !list.is_empty() => {
            let mut platforms = BTreeSet::new();
            for (i, value) in list.iter().enumerate() {
                let entry = value.as_object();
                let field = |key: &str| -> Option<&Value> { entry.and_then(|o| o.get(key)) };
                let os = field("os").map_or_else(|| "undefined".into(), js_string);
                let arch = field("arch").map_or_else(|| "undefined".into(), js_string);
                let Some(p) = platform(&os, &arch) else {
                    problems.push(format!("assets[{i}]: unsupported os/arch {os}-{arch}"));
                    continue;
                };
                let file = asset_file(p);
                let key = format!("{}-{}", p.os, p.arch);
                if !platforms.insert(key.clone()) {
                    problems.push(format!("assets[{i}]: duplicate platform {key}"));
                }
                let sha_ok = field("sha256")
                    .and_then(Value::as_str)
                    .is_some_and(|v| hex64(v, true));
                let size_ok = field("size").is_some_and(|v| positive_integer(v, false));
                if field("file").and_then(Value::as_str) != Some(file.as_str()) {
                    problems.push(format!(
                        "assets[{i}]: file must be \"{file}\" (got {})",
                        shown(field("file"))
                    ));
                }
                if !sha_ok {
                    problems.push(format!(
                        "assets[{i}]: sha256 must be 64 lowercase hex characters"
                    ));
                }
                if !size_ok {
                    problems.push(format!("assets[{i}]: size must be a positive integer"));
                }

                let companions = match field("companions") {
                    None => None,
                    Some(Value::Array(values)) => {
                        let mut found = Vec::new();
                        for (j, value) in values.iter().enumerate() {
                            let entry = value.as_object();
                            let field = |key: &str| -> Option<&Value> {
                                entry.and_then(|o| o.get(key))
                            };
                            let location = format!("assets[{i}].companions[{j}]");
                            if field("name").and_then(Value::as_str) != Some("pacer-core") {
                                problems.push(format!("{location}: unknown companion name"));
                            }
                            let expected = companion_file(p);
                            if field("file").and_then(Value::as_str) != Some(expected.as_str()) {
                                problems.push(format!("{location}: file must be \"{expected}\""));
                            }
                            if !field("sha256")
                                .and_then(Value::as_str)
                                .is_some_and(|v| hex64(v, true))
                            {
                                problems.push(format!(
                                    "{location}: sha256 must be 64 lowercase hex characters"
                                ));
                            }
                            if !field("size").is_some_and(|v| positive_integer(v, true)) {
                                problems.push(format!("{location}: size must be a positive integer"));
                            }
                            if j > 0 {
                                problems.push(format!("{location}: duplicate companion"));
                            }
                            found.push(Companion {
                                name: field("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_owned(),
                                file: field("file")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_owned(),
                                sha256: field("sha256")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_owned(),
                                size: field("size").and_then(Value::as_u64).unwrap_or_default(),
                            });
                        }
                        Some(found)
                    }
                    Some(_) => {
                        problems.push(format!("assets[{i}].companions must be a list"));
                        None
                    }
                };

                if field("file").and_then(Value::as_str) == Some(file.as_str()) && sha_ok && size_ok
                {
                    assets.push(ReleaseAsset {
                        os: p.os.to_owned(),
                        arch: p.arch.to_owned(),
                        file,
                        sha256: field("sha256")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        size: field("size").and_then(Value::as_u64).unwrap_or_default(),
                        companions,
                    });
                }
            }
        }
        _ => problems.push("assets must be a non-empty list".into()),
    }

    if !problems.is_empty() {
        return Err(ReleaseError(format!(
            "invalid manifest.json: {}",
            problems.join("; ")
        )));
    }
    Ok(Manifest {
        version: version.unwrap_or_default().to_owned(),
        assets,
    })
}

/// `parseSha256Sums`: `"<hex>  <file>"` or `"<hex> *<file>"`; other lines are ignored.
pub fn parse_sha256_sums(text: &str) -> Result<BTreeMap<String, String>, ReleaseError> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        let Some((hash, rest)) = line.split_once(' ') else {
            continue;
        };
        if !hex64(hash, false) {
            continue;
        }
        let Some(file) = rest.strip_prefix(' ').or_else(|| rest.strip_prefix('*')) else {
            continue;
        };
        if file.is_empty() {
            continue;
        }
        let hash = hash.to_ascii_lowercase();
        if let Some(previous) = out.get(file)
            && previous != &hash
        {
            return Err(ReleaseError(format!(
                "SHA256SUMS has conflicting hashes for {file}"
            )));
        }
        out.insert(file.to_owned(), hash);
    }
    Ok(out)
}

/// `releaseUrl`: GitHub on the default channel, `<base>/<version>/<file>` otherwise.
pub fn release_url(base: Option<&str>, version: &str, file: &str) -> String {
    match base {
        None => format!(
            "https://github.com/lamtuanvu/pacer/releases/download/v{version}/{file}"
        ),
        Some(base) => format!("{base}/{version}/{file}"),
    }
}

/// Lowercase hex SHA-256, the bytes `parseSha256Sums` compares against.
pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", sha2::Sha256::digest(bytes))
}
