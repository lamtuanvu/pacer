//! Runner-check decisions over detection/sign-in/usage/test-task results.
use crate::{Error, a, event, js, n, now, s, truth};
use serde_json::{Value, json};
pub fn usage_detail(row: &Value, usage: &str) -> String {
    if usage == "unmetered" {
        return "unmetered".into();
    }
    if row["usedPct"].is_null() {
        return "no limit reported".into();
    }
    let window = row["window"].as_str().unwrap_or("usage");
    let mut chars = window.chars();
    let first = chars
        .next()
        .map(|c| {
            if c.len_utf16() == 1 {
                c.to_uppercase().collect::<String>()
            } else {
                c.to_string()
            }
        })
        .unwrap_or_default();
    format!(
        "{first}{} window · {}% used",
        chars.as_str(),
        js::number(n(&row["usedPct"]))
    )
}
fn perform(steps: &mut Vec<Value>, current: &mut String, name: &str, detail: &str) {
    *current = name.into();
    event(steps, "start", name, Some(detail));
}
fn passed(steps: &mut Vec<Value>, current: &str, detail: &str) {
    event(steps, "pass", current, Some(detail));
}
pub fn check(c: &Value) -> Value {
    let runner = &c["runner"];
    if runner.is_null() {
        return Error::new(
            "unknown_executor",
            format!("unknown runner {}", s(&c["id"])),
        )
        .value();
    }
    let account = &c["account"];
    let name = s(&account["name"]);
    let usage = s(&account["usage"]);
    let local = runner["host"].is_null();
    let mut steps = vec![];
    let mut current = String::from("CLI found");
    let result = (|| -> Result<(), Error> {
        let agent = match s(&runner["agent"]) {
            "agy" => "Antigravity",
            "codex" => "Codex",
            "claude-code" => "Claude Code",
            "cursor" => "Cursor",
            "opencode" => "OpenCode",
            _ => "undefined",
        };
        let detail = format!(
            "{agent} on {}",
            if local {
                "this Mac"
            } else {
                s(&runner["host"])
            }
        );
        perform(&mut steps, &mut current, "CLI found", &detail);
        if !truth(&c["found"]["found"]) {
            return Err(Error::new(
                "failed",
                c["found"]["install_hint"]
                    .as_str()
                    .unwrap_or("Agent CLI not found"),
            ));
        }
        passed(&mut steps, &current, &detail);
        let detail = if local {
            format!("Account {name}")
        } else {
            format!(
                "Account {name} · checked by the test task on {}",
                s(&runner["host"])
            )
        };
        perform(&mut steps, &mut current, "Signed in", &detail);
        if local {
            if c["status"].is_null() {
                return Err(Error::new("failed", format!("Sign in to account {name}")));
            }
            if c["status"]["signedIn"] == false {
                return Err(Error::new(
                    "failed",
                    format!(
                        "Sign in to account {name}{}",
                        if truth(&c["signInReason"]) {
                            format!(" ({})", s(&c["signInReason"]))
                        } else {
                            String::new()
                        }
                    ),
                ));
            }
        }
        passed(&mut steps, &current, &detail);
        let row = &c["row"];
        let collect = local
            && account["kind"] == "claude"
            && usage == "quota"
            && (row["usedPct"].is_null() || truth(&row["stale"]));
        let native = ["claude", "codex"].contains(&s(&account["kind"]));
        if collect {
            event(
                &mut steps,
                "start",
                "Usage readable",
                Some("Collecting account usage from the test task"),
            );
        } else if native
            && !row.is_null()
            && row.get("capturedAt") == Some(&Value::Null)
            && row.get("usedPct") == Some(&Value::Null)
        {
            event(&mut steps, "start", "Usage readable", None);
            let detail = format!(
                "No usage reading yet{}{}",
                if truth(&row["error"]) {
                    format!(" · {}", s(&row["error"]))
                } else {
                    String::new()
                },
                if truth(&row["hint"]) {
                    format!(" · {}", s(&row["hint"]))
                } else {
                    String::new()
                }
            );
            event(&mut steps, "skip", "Usage readable", Some(&detail));
        } else {
            let detail = usage_detail(row, usage);
            perform(&mut steps, &mut current, "Usage readable", &detail);
            if truth(&row["error"]) {
                return Err(Error::new("failed", s(&row["error"])));
            }
            if ["quota", "metered"].contains(&usage) && row.is_null() {
                return Err(Error::new("failed", "Usage reading unavailable"));
            }
            passed(&mut steps, &current, &detail);
        }
        // Model offered: the runner's model must still be listed by the
        // provider before the test task runs. The case snapshot supplies the
        // listing the TS adapter fetches with availableModels/isOffered:
        // absent models or source "none" means no adapter, offered null an
        // unknown listing, offered false with an empty closest an empty
        // listing (sign-in dropped, provider renamed), and closest the
        // nearest offered ids.
        let listing = c.get("models").filter(|v| !v.is_null());
        let source = listing.map(|m| s(&m["source"])).unwrap_or("none");
        let model = s(&runner["model"]);
        let provider = account["provider"].as_str().unwrap_or(name);
        current = "Model offered".into();
        event(&mut steps, "start", &current, None);
        let decision: Result<(), String> = if source == "none" {
            event(
                &mut steps,
                "skip",
                &current,
                Some("No model list for this agent"),
            );
            Ok(())
        } else if model.is_empty() {
            event(
                &mut steps,
                "skip",
                &current,
                Some("Uses the agent's default model"),
            );
            Ok(())
        } else if listing.map(|m| m["offered"].is_null()).unwrap_or(true) {
            let note = listing
                .and_then(|m| m["note"].as_str())
                .unwrap_or("unknown");
            event(
                &mut steps,
                "skip",
                &current,
                Some(&format!("Could not check: {note}")),
            );
            Ok(())
        } else if !truth(&c["models"]["offered"]) && a(&c["models"]["closest"]).is_empty() {
            // An empty listing is unknown (sign-in dropped, provider renamed),
            // never "no models".
            let note = c["models"]["note"].as_str().unwrap_or("unknown");
            event(
                &mut steps,
                "skip",
                &current,
                Some(&format!("Could not check: {note}")),
            );
            Ok(())
        } else {
            let closest: Vec<&str> = a(&c["models"]["closest"]).iter().map(s).collect();
            if truth(&c["models"]["offered"]) {
                event(
                    &mut steps,
                    "pass",
                    &current,
                    Some(&format!("{model} is offered")),
                );
                Ok(())
            } else {
                Err(format!(
                    "{model} is no longer offered by {provider}{}",
                    if closest.is_empty() {
                        String::new()
                    } else {
                        format!("; try {}", closest[0])
                    }
                ))
            }
        };
        if let Err(fail) = decision {
            return Err(Error::new("failed", fail));
        }
        let detail = "Write and run a one-line test in a scratch worktree";
        perform(&mut steps, &mut current, "Test task", detail);
        if truth(&c["testError"]) {
            return Err(Error::new("failed", s(&c["testError"])));
        }
        passed(&mut steps, &current, detail);
        if collect {
            current = "Usage readable".into();
            event(
                &mut steps,
                "start",
                &current,
                Some("Verifying account usage collected by the test task"),
            );
            let row = c.get("refreshed").filter(|v| !v.is_null()).unwrap_or(row);
            let detail = usage_detail(row, usage);
            perform(&mut steps, &mut current, "Usage readable", &detail);
            if row["usedPct"].is_null() || truth(&row["stale"]) || truth(&row["error"]) {
                return Err(Error::new(
                    "failed",
                    "Claude Code did not report current account usage after the test task. Update Claude Code and check that this account has a Pro or Max subscription.",
                ));
            }
            passed(&mut steps, &current, &detail);
        }
        Ok(())
    })();
    let result = result.map_err(
        |e| match crate::diagnostics::redact(&e.message, &c["env"]) {
            Ok(message) => Error::new("failed", message),
            Err(error) => error,
        },
    );
    let (ok, detail) = match &result {
        Ok(()) => (true, "Executor is ready"),
        Err(e) => {
            event(&mut steps, "fail", &current, Some(&e.message));
            (false, e.message.as_str())
        }
    };
    let mut stored = c["raw"].as_object().cloned().unwrap_or_default();
    stored.insert(
        s(&runner["id"]).into(),
        json!({"at":now(c),"passed":ok,"detail":detail}),
    );
    let mut out = json!({"kind":"runner.check","target":runner["id"],"names":["CLI found","Signed in","Usage readable","Model offered","Test task"],"steps":steps,"stored":stored});
    if let Err(e) = result {
        out["error"] = json!(e);
    }
    out
}
