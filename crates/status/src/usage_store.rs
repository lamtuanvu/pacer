//! The usage store (`src/usage/store.ts`): per-identity usage readings on disk.

use pacer_foundation::Ctx;
use serde_json::Value;

/// `readUsageEntry` (store.ts:20-23).
pub fn read_usage_entry(_ctx: &Ctx, _identity: &str, _key: &str) -> Option<Value> {
    None
}

/// `writeUsageEntry` (store.ts:31-45); lock `usage-store:<identity>`.
pub fn write_usage_entry(
    _ctx: &Ctx,
    _identity: &str,
    _key: &str,
    _reading: &Value,
    _read_only: bool,
) -> Result<(), pacer_foundation::api::CoreError> {
    Ok(())
}
