//! Bounded plugin wire payloads: owner-local byte staging and UTF-16 JSON strings.
use base64::{Engine, engine::general_purpose::STANDARD};
pub use pacer_js_json::{Utf16String, WireReply, js_semantics};
use std::collections::HashSet;
use thiserror::Error;
use uuid::Uuid;

pub const MAX_TRANSFER: usize = 4 * 1024 * 1024;
pub const MAX_CHUNK: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferKind {
    FileWrite,
    HttpUpload,
    HttpResponse,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TransferError {
    #[error("transfer is not owned by this call")]
    Denied,
    #[error("transfer is incomplete or invalid")]
    Invalid,
    #[error("a transfer is already pending")]
    Conflict,
}

#[derive(Clone)]
struct Payload {
    handle: String,
    kind: TransferKind,
    bytes: Vec<u8>,
    offset: usize,
    read_offset: usize,
}
impl Drop for Payload {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}

#[derive(Default, Clone)]
pub struct Transfers {
    pending: Vec<Payload>,
    retired_http: HashSet<String>,
    retired_file: Option<String>,
}

impl Transfers {
    /// A delivery checkpoint restores only one staging direction. Consumed HTTP
    /// uploads must never become reusable after the network effect has run.
    pub fn restore_kind(&mut self, prior: &Self, kind: TransferKind) {
        self.pending.retain(|p| p.kind != kind);
        self.pending
            .extend(prior.pending.iter().filter(|p| p.kind == kind).cloned());
        if kind == TransferKind::FileWrite {
            self.retired_file = prior.retired_file.clone();
        }
    }
    pub fn has_pending(&self, kind: TransferKind) -> bool {
        self.pending.iter().any(|p| p.kind == kind)
    }
    pub fn consume_text(
        &mut self,
        kind: TransferKind,
        handle: &str,
    ) -> Result<String, TransferError> {
        let payload = self
            .pending
            .iter()
            .find(|p| p.kind == kind && p.handle == handle)
            .ok_or(TransferError::Denied)?;
        if payload.offset != payload.bytes.len() || std::str::from_utf8(&payload.bytes).is_err() {
            return Err(TransferError::Invalid);
        }
        String::from_utf8(self.consume(kind, handle)?).map_err(|_| TransferError::Invalid)
    }
    pub fn publish(&mut self, kind: TransferKind, bytes: &[u8]) -> Result<String, TransferError> {
        let handle = self.begin(kind, bytes.len())?;
        let payload = self
            .pending
            .iter_mut()
            .find(|p| p.handle == handle)
            .ok_or(TransferError::Denied)?;
        payload.bytes.copy_from_slice(bytes);
        payload.offset = bytes.len();
        Ok(handle)
    }
    pub fn begin(&mut self, kind: TransferKind, bytes: usize) -> Result<String, TransferError> {
        if bytes > MAX_TRANSFER {
            return Err(TransferError::Invalid);
        }
        if self.pending.iter().any(|p| p.kind == kind) {
            return Err(TransferError::Conflict);
        }
        let handle = Uuid::new_v4().to_string();
        self.pending.push(Payload {
            handle: handle.clone(),
            kind,
            bytes: vec![0; bytes],
            offset: 0,
            read_offset: 0,
        });
        Ok(handle)
    }
    pub fn append(
        &mut self,
        kind: TransferKind,
        handle: &str,
        offset: usize,
        encoded: &str,
    ) -> Result<usize, TransferError> {
        let payload = self
            .pending
            .iter_mut()
            .find(|p| p.kind == kind && p.handle == handle)
            .ok_or(TransferError::Denied)?;
        let chunk = STANDARD
            .decode(encoded)
            .map_err(|_| TransferError::Invalid)?;
        if (encoded.is_empty() && kind == TransferKind::FileWrite)
            || encoded.len() > 349_528
            || chunk.len() > MAX_CHUNK
            || STANDARD.encode(&chunk) != encoded
            || offset != payload.offset
            || offset
                .checked_add(chunk.len())
                .is_none_or(|end| end > payload.bytes.len())
        {
            return Err(TransferError::Invalid);
        }
        payload.bytes[offset..offset + chunk.len()].copy_from_slice(&chunk);
        payload.offset += chunk.len();
        Ok(payload.offset)
    }
    pub fn read(
        &mut self,
        kind: TransferKind,
        handle: &str,
        offset: usize,
        length: usize,
    ) -> Result<String, TransferError> {
        let payload = self
            .pending
            .iter_mut()
            .find(|p| p.kind == kind && p.handle == handle)
            .ok_or(TransferError::Denied)?;
        if length > MAX_CHUNK || offset != payload.read_offset || offset > payload.offset {
            return Err(TransferError::Invalid);
        }
        let end = payload.offset.min(offset.saturating_add(length));
        let encoded = STANDARD.encode(&payload.bytes[offset..end]);
        payload.read_offset = end;
        Ok(encoded)
    }
    pub fn consume(&mut self, kind: TransferKind, handle: &str) -> Result<Vec<u8>, TransferError> {
        let index = self
            .pending
            .iter()
            .position(|p| p.kind == kind && p.handle == handle)
            .ok_or(TransferError::Denied)?;
        if self.pending[index].offset != self.pending[index].bytes.len() {
            return Err(TransferError::Invalid);
        }
        let payload = self.pending.remove(index);
        self.retire(kind, handle);
        Ok(payload.bytes.clone())
    }
    pub fn release(&mut self, kind: TransferKind, handle: &str) -> Result<(), TransferError> {
        if (kind == TransferKind::FileWrite && self.retired_file.as_deref() == Some(handle))
            || (kind != TransferKind::FileWrite && self.retired_http.contains(handle))
        {
            return Ok(());
        }
        let index = self
            .pending
            .iter()
            .position(|p| p.kind == kind && p.handle == handle)
            .ok_or(TransferError::Denied)?;
        self.pending.remove(index);
        self.retire(kind, handle);
        Ok(())
    }
    fn retire(&mut self, kind: TransferKind, handle: &str) {
        if kind == TransferKind::FileWrite {
            self.retired_file = Some(handle.into());
        } else {
            self.retired_http.insert(handle.into());
        }
    }
    pub fn revoke(&mut self) {
        self.pending.clear();
        self.retired_file = None;
        self.retired_http.clear();
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn owner_handles_offsets_and_canonical_bytes() {
        let mut a = Transfers::default();
        let mut b = Transfers::default();
        let h = a.begin(TransferKind::FileWrite, 3).unwrap();
        assert_eq!(
            b.append(TransferKind::FileWrite, &h, 0, "YWJj"),
            Err(TransferError::Denied)
        );
        assert_eq!(
            a.append(TransferKind::FileWrite, &h, 1, "YWJj"),
            Err(TransferError::Invalid)
        );
        assert_eq!(a.append(TransferKind::FileWrite, &h, 0, "YWJj"), Ok(3));
        assert_eq!(a.consume(TransferKind::FileWrite, &h).unwrap(), b"abc");
        assert_eq!(a.release(TransferKind::FileWrite, &h), Ok(()));
        assert_eq!(
            a.append(TransferKind::FileWrite, &h, 3, "YQ=="),
            Err(TransferError::Denied)
        );
    }
    #[test]
    fn transfer_retirement_and_empty_chunks_match_typescript() {
        let mut transfers = Transfers::default();
        let file = transfers.begin(TransferKind::FileWrite, 0).unwrap();
        assert_eq!(
            transfers.append(TransferKind::FileWrite, &file, 0, ""),
            Err(TransferError::Invalid)
        );
        transfers.release(TransferKind::FileWrite, &file).unwrap();
        assert_eq!(
            transfers.release(TransferKind::HttpUpload, &file),
            Err(TransferError::Denied)
        );
        let next = transfers.begin(TransferKind::FileWrite, 0).unwrap();
        transfers.release(TransferKind::FileWrite, &next).unwrap();
        assert_eq!(
            transfers.release(TransferKind::FileWrite, &file),
            Err(TransferError::Denied)
        );
        let upload = transfers.begin(TransferKind::HttpUpload, 0).unwrap();
        assert_eq!(
            transfers.append(TransferKind::HttpUpload, &upload, 0, ""),
            Ok(0)
        );
    }
    #[test]
    fn response_reads_are_owner_local_and_sequential() {
        let mut owner = Transfers::default();
        let mut foreign = Transfers::default();
        let handle = owner.publish(TransferKind::HttpResponse, b"abcd").unwrap();
        assert_eq!(
            foreign.read(TransferKind::HttpResponse, &handle, 0, 2),
            Err(TransferError::Denied)
        );
        assert_eq!(
            owner.read(TransferKind::HttpResponse, &handle, 2, 2),
            Err(TransferError::Invalid)
        );
        assert_eq!(
            owner
                .read(TransferKind::HttpResponse, &handle, 0, 2)
                .unwrap(),
            "YWI="
        );
        assert_eq!(
            owner.read(TransferKind::HttpResponse, &handle, 0, 2),
            Err(TransferError::Invalid)
        );
        assert_eq!(
            owner
                .read(TransferKind::HttpResponse, &handle, 2, 2)
                .unwrap(),
            "Y2Q="
        );
    }
}
