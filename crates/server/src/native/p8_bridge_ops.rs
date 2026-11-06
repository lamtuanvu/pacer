//! P8/P9 ops validated in Rust and executed via the TypeScript core bridge.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{CoreError, OpFuture},
};
use serde_json::Value;

use super::lifecycle_ops::{invalid, object, type_name};

pub fn needs_core_bridge(op: &str) -> bool {
    matches!(
        op,
        "machine.get" | "machine.set" | "machine.rotate" | "files.search" | "setup.check"
    )
}

pub(super) fn bridge_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(pacer_foundation::api::CoreError::new(
            pacer_foundation::api::Code::Unavailable,
            "core bridge unavailable",
        ))
    })
}

fn empty_object(params: &Value) -> Result<(), CoreError> {
    let map = object(params)?;
    if !map.is_empty() {
        return Err(invalid("params: Unrecognized key(s) in object"));
    }
    Ok(())
}

fn parse_machine_set(params: &Value) -> Result<Value, CoreError> {
    let map = object(params)?;
    for key in map.keys() {
        if key != "name" && key != "expect_rev" {
            return Err(invalid("params: Unrecognized key(s) in object"));
        }
    }
    let name = map.get("name").ok_or_else(|| {
        invalid("name: Invalid input: expected string, received undefined")
    })?;
    let text = name.as_str().ok_or_else(|| {
        invalid(format!(
            "name: Invalid input: expected string, received {}",
            type_name(name)
        ))
    })?;
    if text.is_empty() {
        return Err(invalid(
            "name: Too small: expected string to have >=1 character",
        ));
    }
    if text.encode_utf16().count() > 256 {
        return Err(invalid(
            "name: Too big: expected string to have <=256 characters",
        ));
    }
    let expect = map.get("expect_rev").ok_or_else(|| {
        invalid("expect_rev: Invalid input: expected number, received undefined")
    })?;
    let rev = expect.as_i64().ok_or_else(|| {
        invalid(format!(
            "expect_rev: Invalid input: expected number, received {}",
            type_name(expect)
        ))
    })?;
    if rev <= 0 {
        return Err(invalid(
            "expect_rev: Invalid input: expected positive integer",
        ));
    }
    Ok(serde_json::json!({"name": text, "expect_rev": rev}))
}

fn parse_files_search(params: &Value) -> Result<Value, CoreError> {
    let map = object(params)?;
    for key in map.keys() {
        if key != "query" && key != "repo" && key != "limit" {
            return Err(invalid("params: Unrecognized key(s) in object"));
        }
    }
    let query = map.get("query").ok_or_else(|| {
        invalid("query: Invalid input: expected string, received undefined")
    })?;
    let text = query.as_str().ok_or_else(|| {
        invalid(format!(
            "query: Invalid input: expected string, received {}",
            type_name(query)
        ))
    })?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(invalid(
            "query: Too small: expected string to have >=1 character",
        ));
    }
    if trimmed.encode_utf16().count() > 200 {
        return Err(invalid(
            "query: Too big: expected string to have <=200 characters",
        ));
    }
    let mut out = serde_json::Map::new();
    out.insert("query".into(), Value::String(trimmed.into()));
    if let Some(repo) = map.get("repo") {
        let repo_text = repo.as_str().ok_or_else(|| {
            invalid(format!(
                "repo: Invalid input: expected string, received {}",
                type_name(repo)
            ))
        })?;
        if repo_text.is_empty() {
            return Err(invalid(
                "repo: Too small: expected string to have >=1 character",
            ));
        }
        if repo_text.encode_utf16().count() > 512 {
            return Err(invalid(
                "repo: Too big: expected string to have <=512 characters",
            ));
        }
        out.insert("repo".into(), Value::String(repo_text.to_owned()));
    }
    if let Some(limit) = map.get("limit") {
        let n = limit.as_i64().ok_or_else(|| {
            invalid(format!(
                "limit: Invalid input: expected number, received {}",
                type_name(limit)
            ))
        })?;
        if !(1..=50).contains(&n) {
            return Err(invalid(
                "limit: Invalid input: expected integer in range 1..50",
            ));
        }
        out.insert("limit".into(), Value::from(n));
    }
    Ok(Value::Object(out))
}

pub(crate) fn bridge_params(op: &str, params: &Value) -> Result<Value, CoreError> {
    match op {
        "machine.get" | "machine.rotate" | "setup.check" => {
            empty_object(params)?;
            Ok(params.clone())
        }
        "machine.set" => parse_machine_set(params),
        "files.search" => parse_files_search(params),
        _ => Err(invalid("unknown core bridge op")),
    }
}
