//! Strict archive inspection. Verification provenance is enforced by private fields.
#![allow(clippy::result_large_err)]
use crate::{
    ParsedManifest, parse_manifest,
    private::error,
    publishers::{PublisherTrust, key_bytes},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use pacer_foundation::{Ctx, api::CoreError};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::Path,
};
pub const MAX_ARCHIVE_BYTES: usize = 50 * 1024 * 1024;
pub const MAX_FILE_BYTES: usize = 200 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 10000;
pub const SIGNATURE_CONTEXT: &[u8] = b"pacer-plugin-archive/v1\0";
#[derive(Clone)]
struct FileEntry {
    path: String,
    bytes: Vec<u8>,
}
pub struct InspectedArchive {
    manifest: ParsedManifest,
    compressed: Vec<u8>,
    files: Vec<FileEntry>,
}
pub struct VerifiedArchive(InspectedArchive);
impl InspectedArchive {
    pub fn manifest(&self) -> &ParsedManifest {
        &self.manifest
    }
    pub fn entries(&self) -> Vec<(&str, usize)> {
        self.files
            .iter()
            .map(|f| (f.path.as_str(), f.bytes.len()))
            .collect()
    }
    pub fn verify(
        self,
        ctx: &Ctx,
        signature: &str,
        trust: &PublisherTrust,
    ) -> Result<VerifiedArchive, CoreError> {
        let publisher = trust
            .lookup(ctx, &self.manifest.publisher)?
            .ok_or_else(|| error("unknown publisher; no trusted key"))?;
        let key = key_bytes(
            publisher["key"]
                .as_str()
                .ok_or_else(|| error("invalid publisher key"))?,
        )?;
        let sig = STANDARD.decode(signature).map_err(|e| {
            error(
                if matches!(e, base64::DecodeError::InvalidLastSymbol(_, _)) {
                    "invalid signature or key length"
                } else {
                    "invalid signature or key encoding"
                },
            )
        })?;
        if sig.len() != 64 || STANDARD.encode(&sig) != signature {
            return Err(error("invalid signature or key length"));
        }
        let sig = ed25519_dalek::Signature::from_slice(&sig).map_err(error)?;
        let key = ed25519_dalek::VerifyingKey::from_bytes(&key).map_err(error)?;
        let message = [SIGNATURE_CONTEXT, self.compressed.as_slice()].concat();
        use ed25519_dalek::Verifier;
        key.verify(&message, &sig)
            .map_err(|_| error("archive signature invalid"))?;
        Ok(VerifiedArchive(self))
    }
}
fn field(h: &[u8], start: usize, width: usize) -> Result<&str, CoreError> {
    let bytes = &h[start..start + width];
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    if bytes[end..].iter().any(|b| *b != 0) {
        return Err(error("ambiguous tar header field"));
    }
    let text = std::str::from_utf8(&bytes[..end])
        .map_err(|_| error("The encoded data was not valid for encoding utf-8"))?;
    // TextDecoder's default BOM handling applies independently to each field.
    Ok(text.strip_prefix('\u{feff}').unwrap_or(text))
}
fn octal(h: &[u8], start: usize, width: usize) -> Result<usize, CoreError> {
    let s = crate::settings::js_trim(field(h, start, width)?);
    if s.is_empty() || !s.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
        return Err(error("invalid tar octal field"));
    }
    let n = u64::from_str_radix(s, 8).map_err(|_| error("tar number exceeds safe range"))?;
    if n > 9_007_199_254_740_991 {
        return Err(error("tar number exceeds safe range"));
    }
    usize::try_from(n).map_err(error)
}
fn valid_name(name: &str, directory: bool) -> Result<&str, CoreError> {
    if name.is_empty()
        || name.starts_with('/')
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/@+-".contains(&b))
    {
        return Err(error("absolute or invalid archive path"));
    }
    if directory && !name.ends_with('/') {
        return Err(error("directory must end in slash"));
    }
    if !directory && name.ends_with('/') {
        return Err(error("regular file cannot end in slash"));
    }
    let canonical = if directory {
        &name[..name.len() - 1]
    } else {
        name
    };
    if canonical
        .split('/')
        .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err(error("traversal or ambiguous archive path"));
    }
    Ok(canonical)
}
pub fn inspect(input: &[u8]) -> Result<InspectedArchive, CoreError> {
    if input.is_empty() || input.len() > MAX_ARCHIVE_BYTES {
        return Err(error("archive exceeds 50 MB compressed limit"));
    }
    let limit = MAX_FILE_BYTES + MAX_ENTRIES * 1024 + 1024;
    let mut tar = Vec::new();
    let mut remaining = input;
    loop {
        let mut member = flate2::bufread::GzDecoder::new(remaining);
        Read::by_ref(&mut member)
            .take((limit - tar.len()) as u64 + 1)
            .read_to_end(&mut tar)
            .map_err(|_| error("invalid or oversized gzip archive"))?;
        if tar.len() > limit {
            return Err(error("invalid or oversized gzip archive"));
        }
        let next = member.into_inner();
        if next.len() >= remaining.len() {
            return Err(error("invalid or oversized gzip archive"));
        }
        remaining = next;
        // zlib gunzip accepts concatenated members and ignores any suffix
        // beginning with a NUL after a complete, checksum-verified member.
        if remaining.is_empty() || remaining.first() == Some(&0) {
            break;
        }
    }
    let (mut cursor, mut count, mut expanded) = (0, 0, 0);
    let mut root = String::new();
    let mut seen = HashSet::new();
    let mut kinds = HashMap::new();
    let mut descendants = HashSet::new();
    let mut files = vec![];
    let mut ended = false;
    while cursor + 512 <= tar.len() {
        let h = &tar[cursor..cursor + 512];
        if h.iter().all(|b| *b == 0) {
            if cursor + 1024 > tar.len() || tar[cursor..].iter().any(|b| *b != 0) {
                return Err(error("trailing or truncated tar data"));
            }
            ended = true;
            break;
        }
        count += 1;
        if count > MAX_ENTRIES {
            return Err(error("archive entry count exceeds 10000"));
        }
        let sum = h
            .iter()
            .enumerate()
            .map(|(i, b)| {
                if (148..156).contains(&i) {
                    32
                } else {
                    *b as usize
                }
            })
            .sum::<usize>();
        if sum != octal(h, 148, 8)? {
            return Err(error("tar checksum mismatch"));
        }
        if field(h, 257, 6)? != "ustar" || field(h, 263, 2)? != "00" {
            return Err(error("unsupported tar header format"));
        }
        if h[345..].iter().chain(&h[157..257]).any(|b| *b != 0) {
            return Err(error("tar prefix, link target or extension unsupported"));
        }
        if h[265..345].iter().any(|b| *b != 0) {
            return Err(error("tar owner or device extension unsupported"));
        }
        if octal(h, 108, 8)? != 0 || octal(h, 116, 8)? != 0 || octal(h, 136, 12)? != 0 {
            return Err(error("tar owner or timestamp unsupported"));
        }
        let directory = h[156] == b'5';
        if !matches!(h[156], 0 | b'0' | b'5') {
            let kind = match h[156] {
                b'1' => "hardlink",
                b'2' => "link",
                b'3' | b'4' | b'6' => "device",
                b'L' => "gnu long name",
                b'K' => "gnu long link",
                b'S' => "sparse",
                b'x' | b'g' => "pax",
                _ => "extension",
            };
            return Err(error(format!("unsupported {kind} archive entry")));
        }
        let mode = octal(h, 100, 8)?;
        if if directory {
            mode != 0o700
        } else {
            mode != 0o600 && mode != 0o700
        } {
            return Err(error("unsafe tar mode"));
        }
        let name = valid_name(field(h, 0, 100)?, directory)?.to_owned();
        if !seen.insert(name.clone()) {
            return Err(error(if name.ends_with("/pacer-plugin.json") {
                "duplicate manifest"
            } else {
                "duplicate archive path"
            }));
        }
        let alias = name.to_ascii_lowercase();
        if kinds.contains_key(&alias) {
            return Err(error("case-colliding archive path"));
        }
        let parts: Vec<_> = alias.split('/').collect();
        for i in 1..parts.len() {
            let parent = parts[..i].join("/");
            if kinds.get(&parent) == Some(&false) {
                return Err(error("file/descendant archive path collision"));
            }
            descendants.insert(parent);
        }
        if !directory && descendants.contains(&alias) {
            return Err(error("file/descendant archive path collision"));
        }
        kinds.insert(alias, directory);
        if root.is_empty() {
            if !directory || !pacer_plugin_host::valid_plugin_id(&name) {
                return Err(error("archive must begin with one id root directory"));
            }
            root = name.clone();
        } else if !name.starts_with(&format!("{root}/")) {
            return Err(error("second root or root shadowing refused"));
        }
        let size = octal(h, 124, 12)?;
        if directory && size != 0 {
            return Err(error("directory has data"));
        }
        if size > MAX_FILE_BYTES || expanded + size > MAX_FILE_BYTES {
            return Err(error("oversized file or expanded bytes exceed 200 MB"));
        }
        let start = cursor + 512;
        let padded = size.div_ceil(512) * 512;
        if start + padded > tar.len() {
            return Err(error("truncated tar entry"));
        }
        if tar[start + size..start + padded].iter().any(|b| *b != 0) {
            return Err(error("nonzero tar padding"));
        }
        if !directory {
            files.push(FileEntry {
                path: name,
                bytes: tar[start..start + size].to_vec(),
            });
            expanded += size;
        }
        cursor = start + padded;
    }
    if !ended {
        return Err(error("truncated tar trailer"));
    }
    let manifest = files
        .iter()
        .find(|f| f.path == format!("{root}/pacer-plugin.json"))
        .ok_or_else(|| error("missing manifest or oversized manifest"))?;
    if manifest.bytes.len() > 1024 * 1024 {
        return Err(error("missing manifest or oversized manifest"));
    }
    let text = std::str::from_utf8(&manifest.bytes).map_err(|_| error("invalid manifest JSON"))?;
    let raw = crate::json::parse(text.strip_prefix('\u{feff}').unwrap_or(text).as_bytes())
        .map_err(|_| error("invalid manifest JSON"))?;
    // The generated manifest ABI has no Infinity. Preserve its numeric type for
    // validation by substituting null, never the codec's internal string marker.
    fn schema_value(value: serde_json::Value) -> serde_json::Value {
        if crate::json::nonfinite(&value) {
            return serde_json::Value::Null;
        }
        match value {
            serde_json::Value::Array(a) => {
                serde_json::Value::Array(a.into_iter().map(schema_value).collect())
            }
            serde_json::Value::Object(o) => serde_json::Value::Object(
                o.into_iter().map(|(k, v)| (k, schema_value(v))).collect(),
            ),
            value => value,
        }
    }
    let manifest =
        parse_manifest(schema_value(raw)).map_err(|_| error("manifest identity invalid"))?;
    if manifest.id.as_str() != root {
        return Err(error("manifest identity invalid"));
    }
    if let Some(entry) = manifest.entry.as_ref() {
        valid_name(entry, false)?;
        if !files
            .iter()
            .any(|f| f.path == format!("{root}/{}", entry.as_str()))
        {
            return Err(error("manifest entry missing from archive"));
        }
    }
    Ok(InspectedArchive {
        manifest,
        compressed: input.to_vec(),
        files,
    })
}
impl VerifiedArchive {
    pub fn manifest(&self) -> &ParsedManifest {
        &self.0.manifest
    }
    pub fn extract(&self, destination: &Path) -> Result<(), CoreError> {
        crate::private::parents(destination)?;
        let m = fs::symlink_metadata(destination).map_err(error)?;
        if !m.is_dir()
            || m.file_type().is_symlink()
            || m.mode() & 0o077 != 0
            || m.uid() != nix::unistd::geteuid().as_raw()
            || fs::read_dir(destination).map_err(error)?.next().is_some()
        {
            return Err(error(
                "destination must be an empty private owned directory",
            ));
        }
        let root = self.0.manifest.id.as_str();
        for f in &self.0.files {
            let path = destination.join(&f.path[root.len() + 1..]);
            let parent = path
                .parent()
                .ok_or_else(|| error("archive parent missing"))?;
            crate::private::parents(parent)?;
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)
                .map_err(error)?;
            let mode = if self
                .0
                .manifest
                .entry
                .as_ref()
                .is_some_and(|e| f.path == format!("{root}/{}", e.as_str()))
            {
                0o700
            } else {
                0o600
            };
            let mut out = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(mode)
                .custom_flags(libc::O_NOFOLLOW)
                .open(path)
                .map_err(error)?;
            out.write_all(&f.bytes).map_err(error)?;
        }
        Ok(())
    }
}
