//! Call-issued root snapshots for the shadow host's exact-file read methods.
//! Each request opens a no-follow descriptor and checks the observed file identity.
use crate::{BrokerError, ReadResource};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    fs::{self, Metadata, OpenOptions},
    io::{Read, Seek, SeekFrom},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const CHUNK: u64 = 256 * 1024;

struct Image {
    path: String,
    logical_parent: PathBuf,
    parent: Option<PathBuf>,
    parent_identity: Option<Metadata>,
}

/// Prepare exact file resources at call issuance, before any plugin RPC.
pub struct NativeRead {
    images: Vec<Image>,
}

impl NativeRead {
    pub fn prepare(resources: &[ReadResource]) -> Result<Self, BrokerError> {
        let mut images = Vec::new();
        for resource in resources.iter().filter(|r| r.kind == "file") {
            crate::authority::valid_path(&resource.path)?;
            let path = Path::new(&resource.path);
            let logical_parent = path.parent().ok_or(BrokerError::Invalid("read parent"))?;
            let (parent, parent_identity) = match fs::canonicalize(logical_parent) {
                Ok(parent) => {
                    let identity = fs::symlink_metadata(&parent)
                        .map_err(|_| BrokerError::Invalid("read root unavailable"))?;
                    if !identity.is_dir() || identity.file_type().is_symlink() {
                        return Err(BrokerError::Invalid("read root is not a directory"));
                    }
                    (Some(parent), Some(identity))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (None, None),
                Err(_) => return Err(BrokerError::Invalid("read root unavailable")),
            };
            images.push(Image {
                path: resource.path.clone(),
                logical_parent: logical_parent.to_path_buf(),
                parent,
                parent_identity,
            });
        }
        Ok(Self { images })
    }

    pub fn answer(&mut self, method: &str, params: &Value) -> Result<Value, BrokerError> {
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .ok_or(BrokerError::Invalid("path"))?;
        let image = self
            .images
            .iter_mut()
            .find(|i| i.path == path)
            .ok_or(BrokerError::Invalid("read path was not issued"))?;
        let Some(parent) = image.parent.as_ref() else {
            return Ok(json!({"missing":true}));
        };
        if fs::canonicalize(&image.logical_parent).ok().as_deref() != Some(parent.as_path())
            || !fs::symlink_metadata(parent).is_ok_and(|m| {
                image
                    .parent_identity
                    .as_ref()
                    .is_some_and(|old| same_root(&m, old))
            })
        {
            return Err(BrokerError::Invalid("read root changed"));
        }
        let named = Path::new(path);
        let current = match fs::symlink_metadata(named) {
            Ok(current) => current,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(json!({"missing":true}));
            }
            Err(_) => return Err(BrokerError::Invalid("read target unavailable")),
        };
        if !current.is_file() || current.file_type().is_symlink() {
            return Err(BrokerError::Invalid("read target is not a regular file"));
        }
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(named)
            .map_err(|_| BrokerError::Invalid("read file unavailable"))?;
        let before = file
            .metadata()
            .map_err(|_| BrokerError::Invalid("read descriptor unavailable"))?;
        if !same(&before, &current) {
            return Err(BrokerError::Invalid("read contents changed"));
        }
        let info = info(path, &before);
        if method == "capability.fs.stat" {
            return Ok(json!({"info":info}));
        }
        if method == "capability.fs.read" && before.len() > CHUNK {
            return Ok(json!({"ranged":info}));
        }
        let (offset, length) = if method == "capability.fs.readRange" {
            let offset = params
                .get("offset")
                .and_then(Value::as_u64)
                .ok_or(BrokerError::Invalid("offset"))?;
            let length = params
                .get("length")
                .and_then(Value::as_u64)
                .filter(|n| *n <= CHUNK)
                .ok_or(BrokerError::Invalid("length"))?;
            let expected = params
                .get("expected")
                .ok_or(BrokerError::Invalid("expected"))?;
            if !expected_identity(expected, &before) {
                return Err(BrokerError::Invalid("expected file identity changed"));
            }
            (offset, length.min(before.len().saturating_sub(offset)))
        } else if method == "capability.fs.read" {
            (0, before.len())
        } else {
            return Err(BrokerError::Invalid("unsupported read method"));
        };
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| BrokerError::Invalid("read seek"))?;
        let mut bytes = vec![0; length as usize];
        file.read_exact(&mut bytes)
            .map_err(|_| BrokerError::Invalid("read changed"))?;
        let after = file
            .metadata()
            .map_err(|_| BrokerError::Invalid("read descriptor unavailable"))?;
        let named_after = fs::symlink_metadata(named)
            .map_err(|_| BrokerError::Invalid("read target disappeared"))?;
        if !same(&after, &before) || !same(&named_after, &before) {
            return Err(BrokerError::Invalid("read changed"));
        }
        if method == "capability.fs.readRange" {
            Ok(json!({"base64":STANDARD.encode(bytes),"info":info}))
        } else {
            let text = String::from_utf8_lossy(&bytes);
            let result = json!({"text":text,"mtime": before.mtime() as f64 + before.mtime_nsec() as f64 / 1e9,"mode":before.mode()});
            if serde_json::to_vec(&result).is_ok_and(|v| v.len() > 768 * 1024) {
                Ok(json!({"ranged":info}))
            } else {
                Ok(result)
            }
        }
    }
}

fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.mode() == b.mode()
}

fn same_root(a: &Metadata, b: &Metadata) -> bool {
    a.is_dir() && !a.file_type().is_symlink() && a.dev() == b.dev() && a.ino() == b.ino()
}

fn info(path: &str, meta: &Metadata) -> Value {
    json!({"path":path,"size":meta.len(),"mtimeMs":meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1e6,
        "inode":meta.ino(),"device":meta.dev(),"mode":meta.mode()})
}

fn expected_identity(value: &Value, meta: &Metadata) -> bool {
    value.get("size").and_then(Value::as_u64) == Some(meta.len())
        && value.get("inode").and_then(Value::as_u64) == Some(meta.ino())
        && value.get("device").and_then(Value::as_u64) == Some(meta.dev())
        && value.get("mtimeMs").and_then(Value::as_f64)
            == Some(meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1e6)
        && value
            .get("mode")
            .is_none_or(|v| v.as_u64() == Some(meta.mode() as u64))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn exact_file_range_and_changed_name() {
        let root = std::env::temp_dir().join(format!("pacer-native-read-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("telemetry.json");
        fs::write(&path, b"abc\xff").unwrap();
        let resource = ReadResource {
            path: path.to_str().unwrap().into(),
            kind: "file".into(),
        };
        let mut reader = NativeRead::prepare(&[resource]).unwrap();
        let stat = reader
            .answer("capability.fs.stat", &json!({"path":path}))
            .unwrap();
        let expected = stat["info"].clone();
        let ranged = reader
            .answer(
                "capability.fs.readRange",
                &json!({"path":path,"offset":1,"length":3,"expected":expected}),
            )
            .unwrap();
        assert_eq!(ranged["base64"], "YmP/");
        assert!(
            reader
                .answer(
                    "capability.fs.readRange",
                    &json!({"path":path,"offset":0,"length":1,"expected":{"size":0}})
                )
                .is_err()
        );
        fs::rename(&path, root.join("old")).unwrap();
        symlink(root.join("old"), &path).unwrap();
        assert!(
            reader
                .answer("capability.fs.read", &json!({"path":path}))
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn new_file_under_issued_root_is_readable_but_new_root_is_not() {
        let root = std::env::temp_dir().join(format!("pacer-native-read-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("later");
        let resource = ReadResource {
            path: path.to_str().unwrap().into(),
            kind: "file".into(),
        };
        let mut reader = NativeRead::prepare(&[resource]).unwrap();
        assert_eq!(
            reader
                .answer("capability.fs.read", &json!({"path":path}))
                .unwrap(),
            json!({"missing":true})
        );
        fs::write(&path, "created").unwrap();
        assert_eq!(
            reader
                .answer("capability.fs.read", &json!({"path":path}))
                .unwrap()["text"],
            "created"
        );
        let absent = root.join("new-root").join("later");
        let mut missing_root = NativeRead::prepare(&[ReadResource {
            path: absent.to_str().unwrap().into(),
            kind: "file".into(),
        }])
        .unwrap();
        fs::create_dir(root.join("new-root")).unwrap();
        fs::write(&absent, "new content").unwrap();
        assert_eq!(
            missing_root
                .answer("capability.fs.read", &json!({"path":absent}))
                .unwrap(),
            json!({"missing":true})
        );
        fs::remove_dir_all(root).unwrap();
    }
}
