//! Native `workOptionsSchema` (`src/dispatch/work.ts:17-26`): the nested
//! `dispatch.submit`/`dispatch.child` work options are validated here so B2-9 no
//! longer forwards every request that carries `options`, `difficulty` or `model`.
//! Issue text and key order mirror zod v4 exactly, matching the existing
//! `requirementsSchema`/`preferencesSchema` ports in `preview_ops`.
#![allow(clippy::result_large_err)]
use crate::preview_ops::{issue_bool, issue_enum, issue_string, preferences, requirements, zod_type};
use serde_json::Value;
use std::collections::BTreeMap;

/// `z.number().int().min(min).max(max)` issues, followed by the safe-int bounds.
fn int_range(name: &str, value: &Value, min: i64, max: i64, issues: &mut Vec<String>) {
    let Some(n) = value.as_f64() else {
        issues.push(format!(
            "{name}: Invalid input: expected number, received {}",
            zod_type(value)
        ));
        return;
    };
    if n.fract() != 0.0 {
        issues.push(format!("{name}: Invalid input: expected int, received number"));
        return;
    }
    if n < min as f64 {
        issues.push(format!("{name}: Too small: expected number to be >={min}"));
    } else if n > max as f64 {
        issues.push(format!("{name}: Too big: expected number to be <={max}"));
    }
}

/// `z.number().positive()` (optional, so a missing value is fine).
fn positive_number(name: &str, value: &Value, issues: &mut Vec<String>) {
    let Some(n) = value.as_f64() else {
        issues.push(format!(
            "{name}: Invalid input: expected number, received {}",
            zod_type(value)
        ));
        return;
    };
    if n <= 0.0 {
        issues.push(format!("{name}: Too small: expected number to be >0"));
    }
}

/// `workOptionsSchema` in zod's key order; `.strict()` rejects unknown keys.
/// `value` is the caller-supplied work-options object; `name` is the JSON key
/// the caller used (usually `"options"`, or `"difficulty"`/`"model"` when a
/// `dispatch.child` passes those fields directly).
pub(crate) fn work_options_issues(issues: &mut Vec<String>, name: &str, value: &Value) -> bool {
    let Some(given) = value.as_object() else {
        issues.push(format!(
            "{name}: Invalid input: expected object, received {}",
            zod_type(value)
        ));
        return false;
    };
    // `workOptionsSchema` allows exactly these keys; `.strict()` rejects others.
    const KEYS: &[&str] = &[
        "requirements",
        "preferences",
        "model",
        "kind",
        "difficulty",
        "delegationEnforcement",
        "allowDelegation",
        "maxDepth",
        "maxDescendants",
        "maxConcurrent",
        "maxAttempts",
        "priority",
        "expiresAt",
        "estimatePct",
    ];
    let mut given_sorted: BTreeMap<&str, &Value> = BTreeMap::new();
    for (key, v) in given {
        if !KEYS.contains(&key.as_str()) {
            issues.push(format!("{name}: Unrecognized key: \"{key}\""));
        } else {
            given_sorted.insert(key.as_str(), v);
        }
    }
    for field in KEYS {
        let Some(v) = given_sorted.get(field) else { continue };
        let fname = format!("{name}.{field}");
        match *field {
            "requirements" => {
                requirements(issues, &fname, v);
            }
            "preferences" => {
                preferences(issues, &fname, v);
            }
            "model" => issues.extend(issue_string(&fname, v, 1, 256)),
            "kind" => issues.extend(issue_string(&fname, v, 1, 128)),
            "difficulty" => issues.extend(issue_enum(&fname, v, &["simple", "standard", "complex"])),
            "delegationEnforcement" => {
                issues.extend(issue_enum(&fname, v, &["strict", "cooperative"]));
            }
            "allowDelegation" => issues.extend(issue_bool(&fname, v)),
            "maxDepth" => int_range(&fname, v, 1, 10, issues),
            "maxDescendants" => int_range(&fname, v, 1, 1000, issues),
            "maxConcurrent" => int_range(&fname, v, 1, 64, issues),
            "maxAttempts" => int_range(&fname, v, 1, 20, issues),
            "priority" => int_range(&fname, v, -100, 100, issues),
            "expiresAt" => positive_number(&fname, v, issues),
            "estimatePct" => {
                let Some(n) = v.as_f64() else {
                    issues.push(format!(
                        "{fname}: Invalid input: expected number, received {}",
                        zod_type(v)
                    ));
                    continue;
                };
                if n < 0.0 {
                    issues.push(format!("{fname}: Too small: expected number to be >=0"));
                } else if n > 100.0 {
                    issues.push(format!("{fname}: Too big: expected number to be <=100"));
                }
            }
            _ => unreachable!(),
        }
    }
    true
}