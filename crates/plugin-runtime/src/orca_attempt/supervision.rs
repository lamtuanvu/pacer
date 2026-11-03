use super::*;
use std::{collections::HashSet, time::Duration};
fn regex(pattern: &str, text: &str) -> bool {
    regex::Regex::new(pattern).is_ok_and(|r| r.is_match(text))
}
fn transient(s: &str) -> bool {
    let s = tail(s, 8000);
    regex(
        "(?i)selected model is at capacity|(?:model|provider|server) (?:is )?(?:at capacity|overloaded|busy|temporarily unavailable)|overloaded_error|service unavailable",
        &s,
    )
}
// ECMAScript non-u /i folds these ASCII literals only; spell JS whitespace
// explicitly so FEFF is accepted and U+0085 is not. Prompt glyphs stay Unicode.
const JS_SPACE: &str = r"[\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
fn working(s: &str) -> bool {
    regex(
        &format!(
            r"(?i-u:esc){JS_SPACE}+(?i-u:to){JS_SPACE}+(?i-u:interrupt)|(?i-u:ctrl){JS_SPACE}*\+{JS_SPACE}*(?i-u:c){JS_SPACE}+(?i-u:to){JS_SPACE}+(?i-u:stop)"
        ),
        s,
    )
}
fn idle(s: &str) -> bool {
    regex(
        &format!(
            r"(?:^|\n){JS_SPACE}*(?:[›❯>]{JS_SPACE}*(?:\z|(?i-u:Try |Implement |Summarize |Find |Write |Run |Explain ))|(?i-u:(?:codex|claude|opencode)>|Ask (?:anything|a question)|What would you like|Type a message))"
        ),
        s,
    )
}
fn without_prompt(lines: &[&str], prompt: &str) -> String {
    let prompt = prompt
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .map(crate::js_semantics::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    lines
        .iter()
        .copied()
        .filter(|line| !prompt.iter().any(|p| line.contains(p)))
        .collect::<Vec<_>>()
        .join("\n")
}
fn wait_output(lines: &[&str], prompt: &str) -> (String, String) {
    (
        without_prompt(lines, prompt),
        without_prompt(&lines[lines.len().saturating_sub(15)..], prompt),
    )
}
pub(super) fn tail(s: &str, n: usize) -> String {
    slice(
        s,
        crate::js_semantics::utf16_len(s).saturating_sub(n),
        usize::MAX,
    )
}
pub fn map_wait(w: &Value) -> Result<Value, BrokerError> {
    Ok(match w["kind"].as_str() {
        Some("done") => {
            let outcome = w["outcome"].as_str().unwrap_or("unknown");
            let text = [
                w["subject"].as_str().unwrap_or(""),
                w["body"].as_str().unwrap_or(""),
            ]
            .into_iter()
            .filter(|s| !crate::js_semantics::trim(s).is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
            json!({"code":if outcome=="succeeded"{0}else{1},"timedOut":false,"settled":true,"summary":if text.is_empty(){format!("worker_done: {outcome}")}else{text}})
        }
        Some("settled") => {
            let state = w["state"].as_str().unwrap_or_default();
            let error = w["error"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| format!(" ({s})"))
                .unwrap_or_default();
            let mut value = json!({"code":if state=="succeeded"{0}else{1},"timedOut":false,"settled":w["needsStop"]!=true,"summary":format!("orca worker {state} without a worker_done report{error}")});
            if let Some(t) = w.get("tail") {
                value["tail"] = t.clone();
            }
            value
        }
        Some("timeout") => {
            json!({"code":1,"timedOut":true,"settled":false,"summary":"orca worker timed out at the task timeout; stopped it"})
        }
        Some("stopped") => {
            json!({"code":1,"timedOut":false,"settled":false,"summary":"stopped by the planner; stopped the orca worker"})
        }
        _ => return Err(denied()),
    })
}
pub fn map_failed_start(start: &Value) -> Value {
    let stage = start["failedStage"]
        .as_str()
        .or(start["stage"].as_str())
        .unwrap_or("an unknown stage");
    let error = start["lastError"].as_str().unwrap_or("no error given");
    let mut m = json!({"code":1,"timedOut":false,"settled":true,"summary":format!("orca worker failed to start at {stage}: {error}")});
    if regex(
        "(?i)agent[ _-]?launch|launch[ _-]?agent",
        start["failedStage"].as_str().unwrap_or_default(),
    ) {
        m["launchBroken"] = json!(format!("orca agent launch failed: {error}"));
    }
    m
}
impl OrcaAttempt {
    async fn process_batch(
        &mut self,
        batch: &Value,
        replied: &mut HashSet<String>,
    ) -> Result<Option<Value>, BrokerError> {
        let mut asked = false;
        let mut done = None;
        for message in batch["messages"].as_array().into_iter().flatten() {
            let payload: Value = message["payload"]
                .as_str()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(Value::Null);
            let dispatch = payload["dispatchId"].as_str().unwrap_or_default();
            if message["type"] == "worker_done" && !dispatch.is_empty() {
                let mail = json!({"kind":"done","outcome":payload["outcome"].as_str().unwrap_or("unknown"),"subject":message["subject"].as_str().unwrap_or(""),"body":message["body"].as_str().unwrap_or(""),"filesModified":payload["filesModified"].as_array().cloned().unwrap_or_default()});
                if Some(dispatch) == self.dispatch.as_deref() {
                    done = Some(mail);
                } else if super::safe_dispatch_id(dispatch) {
                    let path = PathBuf::from("orca/inbox").join(format!("{dispatch}.json"));
                    if !self.home.join(&path).exists() {
                        super::launch::write_private(
                            &self.home,
                            &path,
                            &serde_json::to_vec(&mail).map_err(|_| denied())?,
                        )?;
                    }
                }
            } else if ["question", "escalation"].contains(&message["type"].as_str().unwrap_or(""))
                && let Some(id) = message["id"].as_str()
                && replied.insert(id.into())
            {
                if dispatch.is_empty() || Some(dispatch) == self.dispatch.as_deref() {
                    let text = message["body"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .or(message["subject"].as_str().filter(|s| !s.is_empty()))
                        .unwrap_or("The executor needs a decision.");
                    let task = self.task()?;
                    if task.get("question").is_none() {
                        self.store.edit_with_strings(
                            &self.task_id,
                            crate::native_run::rev(&task)?,
                            now(),
                            |t| {
                                t.put(
                                    "/question",
                                    crate::WireReply::new(json!({"text":"","at":now()})),
                                )
                            },
                            &[(
                                "/question/text".into(),
                                crate::Utf16String::slice(text, 0, 1000),
                            )],
                        )?;
                    }
                    asked = true;
                }
                self.client.call(&["orchestration","reply","--id",id,"--body","Your question has been recorded. Stop work now and wait for the user's answer.","--run",&self.spec.run,"--from",&self.spec.coordinator],30000).await?;
            }
        }
        if asked {
            Ok(Some(
                json!({"kind":"settled","state":"needs_input","error":null,"needsStop":true}),
            ))
        } else {
            Ok(done)
        }
    }
    pub(super) async fn wait(&mut self) -> Result<Value, BrokerError> {
        self.expect(&[Phase::Started])?;
        if self.waited.is_some() || (!self.reattach && self.start["state"] != "ready") {
            return Err(denied());
        }
        let task = self.task()?;
        let timeout = task["timeoutS"].as_f64().unwrap_or(600.0).max(0.0);
        let end = Instant::now()
            .checked_add(Duration::try_from_secs_f64(timeout).map_err(|_| denied())?)
            .ok_or_else(denied)?
            .min(self.deadline);
        let dispatch = self.dispatch.clone().ok_or_else(denied)?;
        if !super::safe_dispatch_id(&dispatch) {
            return Err(denied());
        }
        let terminal = self.terminal.clone().ok_or_else(denied)?;
        let mut ack = None::<String>;
        let mut replied = HashSet::new();
        let mut nudged = false;
        let mut succeeded = 0;
        let mut busy_at = None::<Instant>;
        let mut resends = 0;
        let mut idle_at = None::<Instant>;
        let mut idle_nudged = false;
        let mut last_tail = String::new();
        let result = loop {
            let t = self.task()?;
            let inbox = self
                .home
                .join("orca/inbox")
                .join(format!("{dispatch}.json"));
            if let Ok(bytes) = std::fs::read(&inbox)
                && let Ok(mut mail) = serde_json::from_slice::<Value>(&bytes)
            {
                std::fs::remove_file(&inbox).map_err(|_| denied())?;
                mail["kind"] = json!("done");
                break mail;
            }
            if t["state"] == "stopped" {
                break json!({"kind":"stopped"});
            }
            if t.get("question").is_some() && t["question"].get("answer").is_none() {
                break json!({"kind":"settled","state":"needs_input","error":null,"needsStop":true});
            }
            if Instant::now() >= end {
                break json!({"kind":"timeout"});
            }
            if !nudged {
                let shown = self
                    .client
                    .call(&["terminal", "show", "--terminal", &terminal], 30000)
                    .await?;
                let preview = shown["result"]["terminal"]["preview"]
                    .as_str()
                    .unwrap_or("");
                if shown["ok"] == true
                    && preview.contains("Pasted text")
                    && !preview.contains("ctrl+c to stop")
                {
                    nudged = true;
                    self.client
                        .call(
                            &["terminal", "send", "--terminal", &terminal, "--enter"],
                            30000,
                        )
                        .await?;
                }
            }
            let ms = end
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(30000)
                .to_string();
            let mut args = vec!["orchestration", "check"];
            if let Some(a) = &ack {
                args.extend(["--ack", a]);
            }
            args.extend([
                "--wait",
                "--types",
                "worker_done,escalation,question",
                "--timeout-ms",
                &ms,
                "--terminal",
                &self.spec.coordinator,
                "--run",
                &self.spec.run,
            ]);
            let reply = self.client.call(&args, 60000).await?;
            ack = None;
            if reply["ok"] == true {
                ack = reply["result"]["deliveryId"].as_str().map(str::to_owned);
                if let Some(result) = self.process_batch(&reply["result"], &mut replied).await? {
                    break result;
                }
            } else {
                tokio::time::sleep(
                    Duration::from_secs(5).min(end.saturating_duration_since(Instant::now())),
                )
                .await;
            }
            let read = self
                .client
                .call(
                    &[
                        "orchestration",
                        "worker-read",
                        "--dispatch",
                        &dispatch,
                        "--limit",
                        "40",
                    ],
                    30000,
                )
                .await?;
            let lines = read["result"]["terminal"]["tail"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            let (text, recent) = wait_output(&lines, &self.spec.prompt);
            if !working(&text) && transient(&recent) {
                let at = *busy_at.get_or_insert_with(Instant::now);
                let backoff = [60, 120, 240, 60];
                if at.elapsed() >= Duration::from_secs(backoff[resends]) {
                    if resends >= 3 {
                        break json!({"kind":"settled","state":"failed","error":"transient provider busy after three retries","tail":recent,"needsStop":true});
                    }
                    self.client
                        .call(
                            &[
                                "terminal",
                                "send",
                                "--terminal",
                                &terminal,
                                "--text",
                                &format!("Continue the assigned task.\n{}", self.spec.prompt),
                                "--enter",
                            ],
                            30000,
                        )
                        .await?;
                    resends += 1;
                    busy_at = Some(Instant::now());
                }
            } else {
                busy_at = None;
                if text != last_tail || working(&text) || !idle(&text) {
                    idle_at = None;
                    idle_nudged = false;
                } else {
                    let at = *idle_at.get_or_insert_with(Instant::now);
                    if at.elapsed() >= Duration::from_secs(600) {
                        if idle_nudged {
                            break json!({"kind":"settled","state":"failed","error":"worker idle with no progress","tail":recent,"needsStop":true});
                        }
                        self.client
                            .call(
                                &[
                                    "terminal",
                                    "send",
                                    "--terminal",
                                    &terminal,
                                    "--text",
                                    "continue the assigned task; report when done",
                                    "--enter",
                                ],
                                30000,
                            )
                            .await?;
                        idle_nudged = true;
                        idle_at = Some(Instant::now());
                    }
                }
            }
            last_tail = text.clone();
            if !transient(&recent)
                && !working(&text)
                && evidence::detect_limit(&self.spec.executor, 1, false, &recent, "")
            {
                let shown = self
                    .client
                    .call(&["terminal", "show", "--terminal", &terminal], 30000)
                    .await?;
                let preview = shown["result"]["terminal"]["preview"]
                    .as_str()
                    .unwrap_or("")
                    .split('\n')
                    .map(|line| line.strip_suffix('\r').unwrap_or(line))
                    .collect::<Vec<_>>();
                if !working(&without_prompt(&preview, &self.spec.prompt)) {
                    break json!({"kind":"settled","state":"failed","error":"provider usage limit","tail":recent,"needsStop":true});
                }
            }
            let shown = self
                .client
                .call(
                    &["orchestration", "worker-show", "--dispatch", &dispatch],
                    30000,
                )
                .await?;
            let state = shown["result"]["worker"]["state"].as_str().unwrap_or("");
            if shown["ok"] == true
                && ["succeeded", "failed", "stopped"].contains(&state)
                && (state != "succeeded" || {
                    succeeded += 1;
                    succeeded > 2
                })
            {
                break json!({"kind":"settled","state":state,"error":shown["result"]["worker"]["lastError"]});
            }
        };
        if let Some(ack) = ack {
            let reply = self
                .client
                .call(
                    &[
                        "orchestration",
                        "check",
                        "--ack",
                        &ack,
                        "--terminal",
                        &self.spec.coordinator,
                        "--run",
                        &self.spec.run,
                    ],
                    30000,
                )
                .await?;
            if reply["ok"] == true {
                self.process_batch(&reply["result"], &mut replied).await?;
            }
        }
        self.waited = Some(result.clone());
        self.ended_at = Some(now());
        let mut wire = result;
        for (k, start, end) in [("outcome", 0, 256), ("state", 0, 256), ("error", 0, 4096)] {
            if let Some(s) = wire[k].as_str() {
                wire[k] = json!(slice(s, start, end));
            }
        }
        for (k, n) in [("subject", 32000), ("body", 32000), ("tail", 65536)] {
            if let Some(s) = wire[k].as_str() {
                wire[k] = json!(tail(s, n));
            }
        }
        Ok(wire)
    }
    pub(super) fn mapped(&self) -> Result<Value, BrokerError> {
        if !self.reattach && self.start["state"] != "ready" {
            Ok(map_failed_start(&self.start))
        } else {
            map_wait(self.waited.as_ref().ok_or_else(denied)?)
        }
    }
    pub(super) async fn settle(&mut self, settled: bool) -> Result<(), BrokerError> {
        self.expect(&[Phase::Started])?;
        let mapped = self.mapped()?;
        if mapped["settled"] != settled {
            return Err(BrokerError::Effect(
                "Orca provider settlement does not match the supervised worker".into(),
            ));
        }
        let dispatch = self.dispatch.as_deref().ok_or_else(denied)?;
        if mapped["code"] != 0 && mapped.get("tail").is_none() {
            let read = self
                .client
                .call(
                    &[
                        "orchestration",
                        "worker-read",
                        "--dispatch",
                        dispatch,
                        "--limit",
                        "60",
                    ],
                    30000,
                )
                .await?;
            let tail = read["result"]["terminal"]["tail"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n");
            if let Some(waited) = self.waited.as_mut() {
                waited["tail"] = json!(tail);
            }
        }
        let stop = if settled {
            let reply = self
                .client
                .call(
                    &["orchestration", "worker-release", "--dispatch", dispatch],
                    30000,
                )
                .await?;
            reply["ok"] == false && reply["error"]["code"] == "dispatch_inactive"
        } else {
            true
        };
        if stop {
            self.client
                .call(
                    &["orchestration", "worker-stop", "--dispatch", dispatch],
                    30000,
                )
                .await?;
        }
        self.phase = Phase::Settled;
        Ok(())
    }
    pub(super) async fn finish(&mut self, params: &Value) -> Result<Value, BrokerError> {
        self.expect(&[Phase::Started, Phase::Settled])?;
        let own = self.mapped()?;
        for key in ["code", "timedOut", "settled", "launchBroken"] {
            if !crate::js_semantics::json_equal(
                params.get(key).unwrap_or(&Value::Null),
                own.get(key).unwrap_or(&Value::Null),
            ) {
                return Err(BrokerError::Effect(
                    "Orca provider outcome does not match the supervised worker".into(),
                ));
            }
        }
        let task = self.task()?;
        let dispatch = self.dispatch.clone().ok_or_else(denied)?;
        let terminal = self.terminal.clone().ok_or_else(denied)?;
        let allowed = self
            .waited
            .as_ref()
            .is_some_and(|w| w["kind"] == "settled" && w["state"] == "needs_input")
            && (self.reattach
                || (task["interactive"] != false && task["live"]["worker"] == dispatch));
        let keep = params["keepAlive"] == true && self.phase == Phase::Started && allowed;
        // Resolve reattached lane ownership before removing its live record.
        let lane = if !keep && self.reattach {
            if let Some(git) = &self.git {
                super::lane::live_lane(
                    &self.client,
                    &self.journal,
                    git,
                    &task,
                    &task["live"],
                    self.deadline,
                )
                .await
                .ok()
                .flatten()
            } else {
                None
            }
        } else {
            self.created.clone()
        };
        if !keep {
            if self.phase == Phase::Started {
                self.settle(own["settled"] == true).await?;
            }
            if !self.client.close(&terminal).await? {
                self.record_unclosed(&terminal).await?;
            } else if let Some(lease) = &self.lease {
                lease.finish()?;
            }
            self.journal
                .mutate(|s| {
                    s["workers"].as_object_mut().map(|o| o.remove(&dispatch));
                    Ok(())
                })
                .await?;
            self.edit(|t| {
                if t.preview()["live"]["worker"] == dispatch {
                    t.remove("/live")?;
                }
                Ok(())
            })?;
        } else {
            if let Some(lease) = &self.lease {
                lease.finish()?;
            }
            self.edit(|t| {
                if t.preview()["live"]["worker"] == dispatch {
                    t.put("/live/since", crate::WireReply::new(json!(now())))?;
                }
                Ok(())
            })?;
        }
        let removed = if !keep {
            super::lane::release_lane(
                &self.home,
                &task,
                lane.as_ref(),
                &self.client,
                &mut self.journal,
                self.git.as_ref(),
                self.deadline,
                self.reattach && own["settled"] == true,
            )
            .await
            .unwrap_or(false)
        } else {
            false
        };
        self.ended_at.get_or_insert_with(now);
        let mut result = self.outcome(&own)?;
        if removed {
            result.as_object_mut().map(|o| o.remove("worktree"));
        }
        let after = self.fingerprint().await;
        let unchanged = if self.before.is_none() && after.is_none() {
            None
        } else {
            Some(self.before.is_some() && self.before == after)
        };
        let summary = own["summary"].as_str().unwrap_or("");
        let transient =
            !self.reattach && summary.contains("transient provider busy after three retries");
        let reason = if transient {
            Some("transient provider busy after three retries".to_owned())
        } else {
            own["launchBroken"].as_str().map(str::to_owned).or_else(|| {
                evidence::broken_reason(
                    crate::js_semantics::safe_i64(&own["code"]).unwrap_or(1),
                    own["timedOut"] == true,
                    self.ended_at.unwrap_or_else(now) - self.started_at,
                    unchanged,
                    own["tail"].as_str().unwrap_or(""),
                )
            })
        };
        result["attempt"]["limitHit"] = json!(
            (if self.reattach {
                reason.is_none()
            } else {
                !transient
            }) && evidence::detect_limit(
                &self.spec.executor,
                crate::js_semantics::safe_i64(&own["code"]).unwrap_or(1),
                own["timedOut"] == true,
                own["tail"].as_str().unwrap_or(""),
                summary,
            )
        );
        if let Some(reason) = reason {
            result["attempt"]["brokenReason"] = json!(reason);
        }
        self.phase = Phase::Done;
        self.outcome_cache = Some(result.clone());
        Ok(result)
    }
    /// Host rescue after a failed provider. Uncertain starts never authorize fallback.
    pub async fn rescue(&mut self, reason: &str) -> Result<Value, BrokerError> {
        self.client.cleanup_budget();
        if self.duplicate && self.phase == Phase::Terminal {
            self.abandon(reason).await?;
            return Err(BrokerError::Effect(
                "duplicate Orca start cannot authorize fallback".into(),
            ));
        }
        if self.phase == Phase::New {
            let task = self.task()?;
            let id = task["retryOf"].as_str().unwrap_or(&self.task_id).to_owned();
            if let Some(asked) = self.store.read(&id)?
                && asked["live"]["backend"] == "orca"
            {
                self.release_live(&id, &asked["live"]).await?;
            }
        }
        match self.phase {
            Phase::New | Phase::Checked | Phase::Fallback => {
                Ok(json!({"fallback":format!("the Orca executor plugin failed: {reason}")}))
            }
            Phase::Prepared | Phase::Placed | Phase::Terminal | Phase::Refused => self
                .abandon(reason)
                .await
                .map(|r| json!({"fallback":r["reason"]})),
            Phase::Uncertain => {
                if self.found["kind"] == "found" {
                    let start = json!({"dispatchId":self.found["dispatchId"],"state":"ready"});
                    self.bind(start).await?;
                    self.abort().await?;
                    Err(denied())
                } else {
                    self.unstarted().await.map(|o| json!({"outcome":o}))
                }
            }
            Phase::Started | Phase::Settled => {
                self.abort().await?;
                Err(denied())
            }
            Phase::Done => self
                .outcome_cache
                .clone()
                .map(|outcome| json!({"outcome":outcome}))
                .ok_or_else(denied),
        }
    }
    pub async fn abort(&mut self) -> Result<(), BrokerError> {
        self.client.cleanup_budget();
        if let (Some(dispatch), Some(terminal)) = (self.dispatch.clone(), self.terminal.clone()) {
            let stopped = self
                .client
                .call(
                    &["orchestration", "worker-stop", "--dispatch", &dispatch],
                    30000,
                )
                .await;
            if !self.client.close(&terminal).await? {
                self.record_unclosed(&terminal).await?;
            } else if let Some(lease) = &self.lease {
                lease.finish()?;
            }
            self.journal
                .mutate(|s| {
                    s["workers"].as_object_mut().map(|o| o.remove(&dispatch));
                    Ok(())
                })
                .await?;
            self.edit(|t| {
                if t.preview()["live"]["worker"] == dispatch {
                    t.remove("/live")?;
                }
                Ok(())
            })?;
            stopped?;
        }
        self.phase = Phase::Done;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
