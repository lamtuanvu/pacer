//! Process-owner gate. Serve must keep [`Ownership::TypeScript`] until P4d.

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum OwnerError {
    #[error("TypeScript currently owns plugin processes")]
    TypeScriptOwnsHost,
    #[error("native process ownership is not activated in serve")]
    NativeNotActivated,
}

/// Who supervises plugin child processes for a serve generation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ownership {
    /// Production default: TypeScript registry via generation-private IPC.
    TypeScript,
    /// Reserved for the P4d single-owner cutover. Not constructible from serve.
    #[allow(dead_code)]
    Native {
        _private: (),
    },
}

impl Ownership {
    pub fn typescript() -> Self {
        Self::TypeScript
    }

    /// Test-only native token. Production serve must not call this.
    pub fn native_for_tests() -> Self {
        Self::Native { _private: () }
    }

    pub fn is_native(&self) -> bool {
        matches!(self, Self::Native { .. })
    }
}

/// Shell that will hold live plugin children after P4d. Today it only records
/// ownership and refuses native claims under the TypeScript default.
#[derive(Debug)]
pub struct ProcessOwner {
    ownership: Ownership,
}

impl ProcessOwner {
    /// Production serve constructor: TypeScript remains the process owner.
    pub fn typescript() -> Self {
        Self {
            ownership: Ownership::typescript(),
        }
    }

    /// Test harness that pretends native ownership without activating serve.
    pub fn native_for_tests() -> Self {
        Self {
            ownership: Ownership::native_for_tests(),
        }
    }

    pub fn ownership(&self) -> &Ownership {
        &self.ownership
    }

    /// Claiming native supervision fails while TypeScript owns the host.
    pub fn claim_native_supervision(&self) -> Result<(), OwnerError> {
        match self.ownership {
            Ownership::TypeScript => Err(OwnerError::TypeScriptOwnsHost),
            Ownership::Native { .. } => Err(OwnerError::NativeNotActivated),
        }
    }
}

impl Default for ProcessOwner {
    fn default() -> Self {
        Self::typescript()
    }
}
