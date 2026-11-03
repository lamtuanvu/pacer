use crate::{
    BrokerError,
    native_command::{self, denied},
    native_process::Image,
};
use serde_json::{Value, json};
use std::{collections::HashMap, time::Instant};
pub struct OrcaClient {
    image: Image,
    env: HashMap<String, String>,
    deadline: Instant,
}
pub fn clean_environment(mut env: HashMap<String, String>) -> HashMap<String, String> {
    let named = env.get("ORCA_AGENT_SESSION_ID_ENV").cloned();
    env.retain(|key, _| {
        ![
            "ORCA_AGENT_SESSION_ID",
            "ORCA_AGENT_SESSION_ID_ENV",
            "ORCA_TERMINAL_HANDLE",
            "ORCA_PANE_KEY",
            "ORCA_TAB_ID",
            "ORCA_WORKTREE_ID",
            "ORCA_AGENT_LAUNCH_TOKEN",
        ]
        .contains(&key.as_str())
            && named.as_ref() != Some(key)
            && !key.starts_with("ORCA_AGENT_HOOK_")
            && !key.starts_with("ORCA_SESSION_")
    });
    env
}
fn drop_keepalive(s: &str) -> String {
    crate::js_semantics::trim(
        &s.split('\n')
            .filter(|s| {
                !s.trim_start_matches(|c: char| {
                    crate::js_semantics::trim(&c.to_string()).is_empty()
                })
                .starts_with("{\"_keepalive\"")
            })
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .into()
}
impl OrcaClient {
    pub fn cleanup_budget(&mut self) {
        self.deadline = Instant::now() + std::time::Duration::from_secs(30);
    }

    pub fn new(
        executable: &str,
        env: HashMap<String, String>,
        deadline: Instant,
    ) -> Result<Self, BrokerError> {
        Ok(Self {
            image: Image::pin(executable, true)?,
            env: clean_environment(env),
            deadline,
        })
    }
    pub async fn call(&self, args: &[&str], timeout: u64) -> Result<Value, BrokerError> {
        let argv = args
            .iter()
            .map(|s| (*s).into())
            .chain(["--json".into()])
            .collect::<Vec<_>>();
        let out = native_command::run(
            &self.image,
            &argv,
            &self.env,
            &[],
            timeout,
            8 * 1024 * 1024,
            self.deadline,
        )
        .await?;
        let text = String::from_utf8_lossy(&out.stdout);
        let reply: Value = serde_json::from_str(&drop_keepalive(&text)).unwrap_or(Value::Null);
        if (reply["ok"] == true && reply["result"].is_object())
            || (reply["ok"] == false && reply["error"].is_object())
        {
            return Ok(reply);
        }
        let detail = drop_keepalive(&String::from_utf8_lossy(&out.stderr));
        let detail = if detail.is_empty() {
            crate::js_semantics::trim(&text).to_owned()
        } else {
            detail
        };
        Ok(
            json!({"ok":false,"error":{"code":if out.code==127{"not_installed"}else{"bad_output"},"message":if detail.is_empty(){format!("orca exited with code {}",out.code)}else{super::slice(&detail,0,500)}}}),
        )
    }
    pub async fn close(&self, terminal: &str) -> Result<bool, BrokerError> {
        for _ in 0..2 {
            let reply = self
                .call(&["terminal", "close", "--terminal", terminal], 30000)
                .await?;
            if reply["ok"] == true
                && reply["result"]["close"]["handle"] == terminal
                && reply["result"]["close"]["ptyKilled"] == true
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub async fn lookup(&self, run: &str, terminal: &str) -> Result<Value, BrokerError> {
        let mut cursor = String::new();
        for _ in 0..50 {
            let mut args = vec!["orchestration", "worker-list", "--run", run];
            if !cursor.is_empty() {
                args.extend(["--cursor", &cursor]);
            }
            let reply = self.call(&args, 30000).await?;
            let r = &reply["result"];
            if reply["ok"] != true {
                return Ok(
                    json!({"kind":"unknown","reason":format!("orca worker-list failed: {} {}",reply["error"]["code"].as_str().unwrap_or("error"),reply["error"]["message"].as_str().unwrap_or(""))}),
                );
            }
            let Some(rows) = r["workers"].as_array() else {
                return Ok(
                    json!({"kind":"unknown","reason":"orca worker-list returned no workers"}),
                );
            };
            if r["scope"].get("run").is_some_and(|v| v != run) {
                return Ok(
                    json!({"kind":"unknown","reason":"orca worker-list is incomplete for the run"}),
                );
            }
            if let Some(w) = rows.iter().find(|w| {
                w["agentTerminalHandle"] == terminal || w["resource"]["terminalHandle"] == terminal
            }) {
                return Ok(
                    if let Some(dispatch) = w["dispatchId"].as_str().filter(|s| !s.is_empty()) {
                        json!({"kind":"found","dispatchId":dispatch,"state":w["workerState"].as_str().unwrap_or("")})
                    } else {
                        json!({"kind":"unknown","reason":"orca worker-list row has no dispatch id"})
                    },
                );
            }
            if r["page"]["hasMore"] == false {
                return Ok(json!({"kind":"none"}));
            }
            let next = r["page"]["nextCursor"].as_str().unwrap_or_default();
            if r["page"]["hasMore"] != true || next.is_empty() || next == cursor {
                return Ok(
                    json!({"kind":"unknown","reason":"orca worker-list is incomplete for the run"}),
                );
            }
            cursor = next.into();
        }
        Ok(json!({"kind":"unknown","reason":"orca worker-list has more than 50 pages"}))
    }
    pub async fn live_problem(&self, live: &Value) -> Result<Option<String>, BrokerError> {
        let worker = live["worker"].as_str().ok_or_else(denied)?;
        let terminal = live["terminal"].as_str().ok_or_else(denied)?;
        let shown = self
            .call(
                &["orchestration", "worker-show", "--dispatch", worker],
                30000,
            )
            .await?;
        if shown["ok"] != true {
            return Ok(Some(format!(
                "worker-show failed: {}",
                shown["error"]["code"].as_str().unwrap_or("error")
            )));
        }
        let state = shown["result"]["worker"]["state"]
            .as_str()
            .unwrap_or("gone");
        if state.is_empty() || ["gone", "succeeded", "failed", "stopped"].contains(&state) {
            return Ok(Some(format!("the worker is {state}")));
        }
        let shown = self
            .call(&["terminal", "show", "--terminal", terminal], 30000)
            .await?;
        let row = &shown["result"]["terminal"];
        if shown["ok"] != true {
            return Ok(Some(format!(
                "terminal show failed: {}",
                shown["error"]["code"].as_str().unwrap_or("error")
            )));
        }
        if row["handle"] != terminal {
            return Ok(Some("the terminal is gone".into()));
        }
        if live["incarnation"].as_str().is_some_and(|s| !s.is_empty())
            && row["incarnationId"].as_str().is_some_and(|s| !s.is_empty())
            && live["incarnation"] != row["incarnationId"]
        {
            return Ok(Some("the terminal was restarted".into()));
        }
        if row["connected"] == false || row["writable"] == false {
            return Ok(Some("the terminal is not writable".into()));
        }
        if row["agentIdentity"] != live["agent"] {
            return Ok(Some(
                match row["agentIdentity"].as_str().filter(|s| !s.is_empty()) {
                    Some(a) => format!(
                        "{a}, not {}, is in the foreground",
                        live["agent"].as_str().unwrap_or_default()
                    ),
                    None => format!(
                        "{} is not in the foreground (a shell may be)",
                        live["agent"].as_str().unwrap_or_default()
                    ),
                },
            ));
        }
        Ok(None)
    }
}
