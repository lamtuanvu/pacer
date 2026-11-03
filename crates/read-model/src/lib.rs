//! Read-model composition over the shared fixture/state homes. No operations are
//! registered: TypeScript remains the runtime owner. External probes are explicit
//! inputs, so reading a snapshot never spawns an agent or reads its credentials.
mod attention;
pub mod capacity;
mod consoles;
pub mod events;
pub mod js;
mod snapshot;
mod summary;
pub mod tasks;
pub mod wire;
use pacer_foundation::Ctx;
use serde_json::Value;
pub use snapshot::{Probes, ReadModel, SnapshotInput, SnapshotResult, StatusInput};
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Store(#[from] pacer_store::StoreError),
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("since must be a non-negative integer")]
    Cursor,
}
pub(crate) fn read(ctx: &Ctx, path: &str) -> Value {
    pacer_foundation::fsutil::read_json(&ctx.pacer_home.join(path)).unwrap_or(Value::Null)
}
