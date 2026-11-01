//! Bounded, owner-local byte staging for file and HTTP chunk protocols.
use base64::{Engine, engine::general_purpose::STANDARD};
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

struct Payload {
    handle: String,
    kind: TransferKind,
    bytes: Vec<u8>,
    offset: usize,
}
impl Drop for Payload {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}

#[derive(Default)]
pub struct Transfers {
    pending: Vec<Payload>,
    retired: HashSet<String>,
}

impl Transfers {
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
        if encoded.is_empty()
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
        &self,
        kind: TransferKind,
        handle: &str,
        offset: usize,
        length: usize,
    ) -> Result<String, TransferError> {
        let payload = self
            .pending
            .iter()
            .find(|p| p.kind == kind && p.handle == handle)
            .ok_or(TransferError::Denied)?;
        if length > MAX_CHUNK || offset > payload.offset {
            return Err(TransferError::Invalid);
        }
        Ok(STANDARD
            .encode(&payload.bytes[offset..payload.offset.min(offset.saturating_add(length))]))
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
        self.retired.insert(handle.into());
        Ok(payload.bytes.clone())
    }
    pub fn release(&mut self, kind: TransferKind, handle: &str) -> Result<(), TransferError> {
        if self.retired.contains(handle) {
            return Ok(());
        }
        let index = self
            .pending
            .iter()
            .position(|p| p.kind == kind && p.handle == handle)
            .ok_or(TransferError::Denied)?;
        self.pending.remove(index);
        self.retired.insert(handle.into());
        Ok(())
    }
    pub fn revoke(&mut self) {
        self.pending.clear();
        self.retired.clear();
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
}
