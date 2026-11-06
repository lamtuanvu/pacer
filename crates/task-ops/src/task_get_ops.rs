#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_read_model::task_detail::task_detail_by_id;
use pacer_store::TaskStore;
use serde_json::{Map, Value};

use super::session_ops::{SessionProbeParts, parse_probe_parts};

pub fn needs_task_read_bridge(op: &str) -> bool {
    matches!(op, "task.get")
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn parse_id(params: &Value) -> Result<&str, CoreError> {
    let map = params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })?;
    let value = map.get("id").ok_or_else(|| invalid("id: Required"))?;
    let text = value.as_str().ok_or_else(|| {
        invalid(format!(
            "id: Invalid input: expected string, received {}",
            type_name(value)
        ))
    })?;
    if text.is_empty() {
        return Err(invalid(
            "id: Too small: expected string to have >=1 characters",
        ));
    }
    if text.encode_utf16().count() > 128 {
        return Err(invalid(
            "id: Too big: expected string to have <=128 characters",
        ));
    }
    Ok(text)
}

fn merge_enrichment(detail: &mut Map<String, Value>, enrichment: &Value) {
    let Some(enrich) = enrichment.as_object() else {
        return;
    };
    for (key, value) in enrich {
        if key == "omitResultAcceptance" {
            continue;
        }
        detail.insert(key.clone(), value.clone());
    }
}

pub fn task_get_stub(_: &Ctx, _: Value) -> pacer_foundation::api::OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "task.get requires the task read bridge",
        ))
    })
}

pub async fn task_get(ctx: &Ctx, params: Value, read_parts: Value) -> Result<Value, CoreError> {
    let id = parse_id(&params)?;
    let probe = parse_probe_parts(read_parts.clone())?;
    let enrichment = read_parts.get("enrichment").cloned().unwrap_or(Value::Null);
    let omit = enrichment
        .get("omitResultAcceptance")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    task_get_with_probe(ctx, id, probe, enrichment, omit).await
}

async fn task_get_with_probe(
    ctx: &Ctx,
    id: &str,
    probe: SessionProbeParts,
    enrichment: Value,
    omit_result_acceptance: bool,
) -> Result<Value, CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home)
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    let alive_pids = probe.alive_pids;
    let alive = move |pid: i64| alive_pids.contains(&pid);
    let mut detail = task_detail_by_id(
        ctx,
        &probe.active,
        &mut store,
        id,
        &alive,
        omit_result_acceptance,
    )
    .map_err(|error| match error {
        pacer_read_model::Error::Store(pacer_store::StoreError::UnknownTask(_)) => {
            CoreError::new(Code::NotFound, format!("task \"{id}\" not found"))
        }
        other => CoreError::new(Code::Internal, other.to_string()),
    })?;
    if let Value::Object(map) = &mut detail {
        merge_enrichment(map, &enrichment);
    }
    Ok(detail)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use serde_json::json;

    #[test]
    fn merge_enrichment_overlays_git_and_tokens() {
        let mut detail = json!({"id": "t-1", "files": []})
            .as_object()
            .unwrap()
            .clone();
        merge_enrichment(
            &mut detail,
            &json!({
                "files": [{"path": "a.ts", "status": "modified"}],
                "tokens": {"total": 1},
                "omitResultAcceptance": true,
            }),
        );
        assert_eq!(detail["files"].as_array().unwrap().len(), 1);
        assert_eq!(detail["tokens"]["total"], 1);
    }
}
