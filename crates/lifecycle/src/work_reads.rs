//! Read projections of the managed work graph: `workTree`/`scopedWorkTree`,
//! `scopedWorkEvents` and `listWork` (`src/dispatch/work.ts`, `src/core/work.ts`).
//! These are the projections for callers without a work grant; scoped grants
//! stay on the TypeScript reference.
use crate::js;
use rusqlite::{Connection, OptionalExtension, Row, params, types::ValueRef};
use serde_json::{Map, Value, json};
use std::collections::HashSet;

#[derive(Debug, thiserror::Error)]
pub enum WorkReadError {
    #[error("Unknown work")]
    UnknownWork,
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

/// `listWork` filters after parameter validation; empty strings mean "no filter".
pub struct WorkListFilter<'a> {
    pub relation: &'a str,
    pub state: &'a str,
    pub repo: &'a str,
    pub before: &'a str,
    pub limit: i64,
}

/// One read session over the shared task database with the dispatch schema applied.
pub struct WorkReads<'a> {
    pub db: &'a Connection,
    /// Seconds since the epoch, as the TypeScript `ctx.now`.
    pub now: f64,
    /// `pidAlive` for a truthy `runnerPid` / `childPid` record value.
    pub pid_alive: &'a dyn Fn(&Value) -> bool,
}

struct NodeRow {
    task_id: String,
    parent_id: Value,
    root_id: String,
    depth: Value,
    options: String,
    dependencies: String,
}

struct TokenItem {
    executor: Value,
    account: Value,
    model: Value,
    tokens: Value,
}

struct Waits {
    queue: f64,
    dependency: Option<f64>,
    child: f64,
    capacity: Option<f64>,
    provisional: u64,
}

const AGENTS: &[&str] = &["claude-code", "codex", "cursor", "agy", "opencode"];
const RESTARTABLE: &[&str] = &[
    "failed",
    "partial",
    "limit",
    "needs_input",
    "stopped",
    "done",
];
const TOKEN_FIELDS: [&str; 4] = ["input", "output", "cacheRead", "cacheWrite"];

impl WorkReads<'_> {
    /// `scopedWorkTree` without a work grant: the node and its descendants.
    pub fn scoped_tree(&self, id: &str) -> Result<Value, WorkReadError> {
        let root = self.work(id)?.ok_or(WorkReadError::UnknownWork)?;
        let rows = self.root_rows(&root.root_id)?;
        let visible = visible(id, &rows);
        let mut nodes = Vec::new();
        let mut attempts = Vec::new();
        let mut items = Vec::new();
        for row in rows.iter().filter(|r| visible.contains(&r.task_id)) {
            let (node, node_attempts, node_items) = self.tree_node(row)?;
            nodes.push(node);
            attempts.extend(node_attempts);
            items.extend(node_items);
        }
        let ids: Vec<&str> = rows
            .iter()
            .filter(|r| visible.contains(&r.task_id))
            .map(|r| r.task_id.as_str())
            .collect();
        let waits = self.wait_totals(&ids)?;
        let totals = self.totals(&nodes, &attempts, &items, &waits);
        let mut out = json!({"rootId": root.root_id, "nodes": nodes, "totals": totals});
        js_numbers(&mut out);
        Ok(out)
    }

    /// `scopedWorkEvents` without a work grant.
    pub fn scoped_events(&self, id: &str, after: i64) -> Result<Value, WorkReadError> {
        let root = self.work(id)?.ok_or(WorkReadError::UnknownWork)?;
        let visible = visible(id, &self.root_rows(&root.root_id)?);
        let mut statement = self.db.prepare(
            "SELECT seq,task_id,at,kind,data FROM work_events WHERE root_id=? AND seq>? ORDER BY seq LIMIT 500",
        )?;
        let rows = statement
            .query_map(params![root.root_id, after], |r| {
                Ok((
                    sql_json(r.get_ref(0)?),
                    r.get::<_, String>(1)?,
                    sql_json(r.get_ref(2)?),
                    sql_json(r.get_ref(3)?),
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let next = rows.last().map_or_else(|| json!(after), |r| r.0.clone());
        let has_more = rows.len() == 500;
        let mut events = Vec::new();
        for (seq, task_id, at, kind, data) in rows {
            if visible.contains(&task_id) {
                let data: Value = serde_json::from_str(&data)?;
                events.push(
                    json!({"seq": seq, "task_id": task_id, "at": at, "kind": kind, "data": data}),
                );
            }
        }
        let mut out = json!({"events": events, "next": next, "hasMore": has_more});
        js_numbers(&mut out);
        Ok(out)
    }

    /// `listWork`: a page of work roots or children, newest id first.
    pub fn list(&self, filter: &WorkListFilter<'_>) -> Result<Value, WorkReadError> {
        let limit = filter.limit.clamp(1, 100);
        let mut statement = self.db.prepare(
            "SELECT n.* FROM work_nodes n JOIN tasks t ON t.id=n.task_id WHERE (?='all' OR (?='roots' AND n.parent_id IS NULL) OR (?='children' AND n.parent_id IS NOT NULL)) AND (?='' OR (CASE WHEN t.state='running' AND json_extract(t.record,'$.question.text') IS NOT NULL AND json_extract(t.record,'$.question.answer') IS NULL THEN 'needs_input' ELSE t.state END)=?) AND (?='' OR json_extract(t.record,'$.repo.key')=?) AND (?='' OR n.task_id<?) ORDER BY n.task_id DESC LIMIT ?",
        )?;
        let rows = statement
            .query_map(
                params![
                    filter.relation,
                    filter.relation,
                    filter.relation,
                    filter.state,
                    filter.state,
                    filter.repo,
                    filter.repo,
                    filter.before,
                    filter.before,
                    limit + 1
                ],
                node_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let page = &rows[..rows.len().min(limit as usize)];
        let mut tasks = Vec::new();
        for row in page {
            let Some(task) = self.task(&row.task_id)? else {
                continue;
            };
            let mut item = Map::new();
            put(&mut item, "id", task.get("id"));
            item.insert("parentId".into(), row.parent_id.clone());
            item.insert("rootId".into(), json!(row.root_id));
            item.insert("depth".into(), row.depth.clone());
            put(&mut item, "title", title(&task));
            put(&mut item, "state", visible_state(&task).as_ref());
            put(&mut item, "rev", task.get("rev"));
            put(
                &mut item,
                "executor",
                coalesce(task.get("executor"), task.get("requestedExecutor")),
            );
            put(&mut item, "createdAt", task.get("createdAt"));
            item.insert("review".into(), or_null(task.get("review")));
            item.insert("branch".into(), list_branch(&task));
            item.insert(
                "tokens".into(),
                self.list_tokens(&row.task_id, attempts_of(&task))?,
            );
            tasks.push(Value::Object(item));
        }
        let next = if rows.len() as i64 > limit {
            page.last().map_or(Value::Null, |r| json!(r.task_id))
        } else {
            Value::Null
        };
        let mut out = json!({"tasks": tasks, "next": next});
        js_numbers(&mut out);
        Ok(out)
    }

    fn work(&self, id: &str) -> Result<Option<NodeRow>, WorkReadError> {
        Ok(self
            .db
            .query_row("SELECT * FROM work_nodes WHERE task_id=?", [id], node_row)
            .optional()?)
    }

    fn root_rows(&self, root: &str) -> Result<Vec<NodeRow>, WorkReadError> {
        let mut statement = self
            .db
            .prepare("SELECT * FROM work_nodes WHERE root_id=? ORDER BY depth,task_id")?;
        let rows = statement
            .query_map([root], node_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    fn task(&self, id: &str) -> Result<Option<Value>, WorkReadError> {
        if !pacer_store::is_task_id(id) {
            return Ok(None);
        }
        let text: Option<String> = self
            .db
            .query_row("SELECT record FROM tasks WHERE id = ?", [id], |r| r.get(0))
            .optional()?;
        let Some(text) = text else { return Ok(None) };
        let mut task: Value = serde_json::from_str(&text)?;
        if let Some(map) = task.as_object_mut()
            && nullish(map.get("rev"))
        {
            map.insert("rev".into(), json!(1));
        }
        Ok(Some(task))
    }

    fn tree_node(
        &self,
        row: &NodeRow,
    ) -> Result<(Value, Vec<Value>, Vec<TokenItem>), WorkReadError> {
        let work = node_json(row)?;
        let decisions = self.decisions(&row.task_id)?;
        let waived = self.column(
            "SELECT dependency_id FROM work_dependency_waivers WHERE task_id=?",
            &row.task_id,
        )?;
        let mut node = work.clone();
        node.insert("waivedChildren".into(), Value::Array(waived));
        let Some(task) = self.task(&row.task_id)? else {
            for (key, value) in [
                ("title", json!("Archived work")),
                ("state", json!("archived")),
                ("rev", json!(0)),
                ("review", Value::Null),
                ("question", Value::Null),
                (
                    "retryEligibility",
                    json!({"allowed": false, "reason": "Archived work"}),
                ),
                ("executor", Value::Null),
                ("model", Value::Null),
                ("actualModel", Value::Null),
                ("decisions", Value::Array(decisions)),
                ("attempts", json!([])),
                ("createdAt", Value::Null),
                ("settledAt", Value::Null),
            ] {
                node.insert(key.into(), value);
            }
            let items = self.items_from_index(&row.task_id)?;
            return Ok((Value::Object(node), Vec::new(), items));
        };
        let attempts: Vec<Value> = self
            .attempts_with_tokens(&row.task_id, attempts_of(&task))?
            .iter()
            .map(tree_attempt)
            .collect();
        let last = attempts_of(&task).last();
        put(&mut node, "title", title(&task));
        put(&mut node, "state", visible_state(&task).as_ref());
        put(&mut node, "rev", task.get("rev"));
        node.insert("review".into(), or_null(task.get("review")));
        node.insert("question".into(), or_null(task.get("question")));
        node.insert(
            "retryEligibility".into(),
            self.restart_eligibility(&task, &row.task_id, &work)?,
        );
        put(
            &mut node,
            "executor",
            coalesce(task.get("executor"), task.get("requestedExecutor")),
        );
        node.insert(
            "model".into(),
            or_null(coalesce(
                field(task.get("result"), "model"),
                field(last, "model"),
            )),
        );
        node.insert("actualModel".into(), or_null(field(last, "actualModel")));
        node.insert("decisions".into(), Value::Array(decisions));
        node.insert("attempts".into(), Value::Array(attempts.clone()));
        put(&mut node, "createdAt", task.get("createdAt"));
        node.insert("settledAt".into(), or_null(task.get("settledAt")));
        let items = attempts
            .iter()
            .map(|a| {
                let executor = if nullish(a.get("executor")) {
                    json!("unknown")
                } else {
                    a["executor"].clone()
                };
                item_of(
                    executor,
                    a.get("model"),
                    a.get("actualModel"),
                    a.get("usageAtStart"),
                    a.get("tokens").cloned().unwrap_or(Value::Null),
                )
            })
            .collect();
        Ok((Value::Object(node), attempts, items))
    }

    fn decisions(&self, id: &str) -> Result<Vec<Value>, WorkReadError> {
        let mut statement = self
            .db
            .prepare("SELECT attempt,data FROM work_decisions WHERE task_id=? ORDER BY attempt")?;
        let rows = statement
            .query_map([id], |r| {
                Ok((sql_json(r.get_ref(0)?), r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::new();
        for (attempt, data) in rows {
            let p: Value = serde_json::from_str(&data)?;
            let mut decision = Map::new();
            decision.insert("attempt".into(), attempt);
            for key in [
                "engine",
                "proposal",
                "validation",
                "recommendedAction",
                "uncertainty",
                "selectedCandidateId",
                "inputHash",
                "outputHash",
                "fallback",
            ] {
                put(&mut decision, key, p.get(key));
            }
            if truthy(p.get("enforcement")) {
                decision.insert("enforcement".into(), p["enforcement"].clone());
            }
            out.push(Value::Object(decision));
        }
        Ok(out)
    }

    fn column(&self, sql: &str, id: &str) -> Result<Vec<Value>, WorkReadError> {
        let mut statement = self.db.prepare(sql)?;
        let rows = statement
            .query_map([id], |r| Ok(sql_json(r.get_ref(0)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    fn usage_rows(&self, id: &str) -> Result<Vec<Map<String, Value>>, WorkReadError> {
        let mut statement = self
            .db
            .prepare("SELECT * FROM attempt_usage WHERE task_id=? ORDER BY attempt")?;
        let names: Vec<String> = statement.column_names().map(str::to_owned).collect();
        let rows = statement
            .query_map([id], |r| {
                let mut row = Map::new();
                for (index, name) in names.iter().enumerate() {
                    row.insert(name.clone(), sql_json(r.get_ref(index)?));
                }
                Ok(row)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// `attemptsWithTokens`: the record's tokens, else the index row, else unknown.
    fn attempts_with_tokens(
        &self,
        id: &str,
        attempts: &[Value],
    ) -> Result<Vec<Value>, WorkReadError> {
        let indexed = if attempts.iter().any(|a| !truthy(a.get("tokens"))) {
            self.usage_rows(id)?
        } else {
            Vec::new()
        };
        Ok(attempts
            .iter()
            .enumerate()
            .map(|(index, attempt)| {
                let mut out = attempt.as_object().cloned().unwrap_or_default();
                let tokens = if !nullish(attempt.get("tokens")) {
                    attempt["tokens"].clone()
                } else if let Some(row) = indexed.iter().rev().find(|row| {
                    row.get("attempt").and_then(Value::as_f64) == Some((index + 1) as f64)
                }) {
                    tokens_from_row(row)
                } else {
                    self.unknown_tokens("no usage record for this attempt")
                };
                out.insert("tokens".into(), tokens);
                Value::Object(out)
            })
            .collect())
    }

    /// `itemsFromIndex`: a node whose record is gone still contributes its index rows.
    fn items_from_index(&self, id: &str) -> Result<Vec<TokenItem>, WorkReadError> {
        let rows = self.usage_rows(id)?;
        if rows.is_empty() {
            return Ok(vec![TokenItem {
                executor: json!("unknown"),
                account: Value::Null,
                model: Value::Null,
                tokens: self.unknown_tokens("task record is unavailable and has no usage rows"),
            }]);
        }
        Ok(rows
            .iter()
            .map(|row| {
                let executor = row.get("executor").cloned().unwrap_or(Value::Null);
                let account = or_null(coalesce(
                    row.get("account"),
                    runner_account(&executor).as_ref(),
                ));
                TokenItem {
                    executor,
                    account,
                    model: row.get("model").cloned().unwrap_or(Value::Null),
                    tokens: tokens_from_row(row),
                }
            })
            .collect())
    }

    fn unknown_tokens(&self, note: &str) -> Value {
        json!({"input": null, "cacheRead": null, "cacheWrite": null, "output": null, "reasoning": null,
            "total": null, "turns": null, "selfReported": false, "extractor": "rollup@1",
            "capturedAt": self.now, "coverage": "unknown", "source": "executor-text", "note": note})
    }

    /// `listTokens`: the compact roll-up a list row shows, or null without any reading.
    fn list_tokens(&self, id: &str, attempts: &[Value]) -> Result<Value, WorkReadError> {
        let items: Vec<TokenItem> = self
            .attempts_with_tokens(id, attempts)?
            .iter()
            .map(|a| {
                item_of(
                    a.get("executor").cloned().unwrap_or(Value::Null),
                    a.get("model"),
                    a.get("actualModel"),
                    a.get("usageAtStart"),
                    a.get("tokens").cloned().unwrap_or(Value::Null),
                )
            })
            .collect();
        let rollup = rollup_tokens(&items);
        let measured = rollup["measuredAttempts"].as_u64().unwrap_or(0);
        let partial = rollup["partialAttempts"].as_u64().unwrap_or(0);
        Ok(if measured + partial > 0 {
            json!({"total": rollup["total"], "lowerBound": rollup["lowerBound"],
                "measuredAttempts": measured, "partialAttempts": partial})
        } else {
            Value::Null
        })
    }

    /// `workRestartEligibility` for an ungranted caller.
    fn restart_eligibility(
        &self,
        task: &Value,
        id: &str,
        work: &Map<String, Value>,
    ) -> Result<Value, WorkReadError> {
        let question = task.get("question");
        if !truthy(task.get("archived"))
            && !truthy(task.get("review"))
            && !truthy(task.get("dismissed"))
            && task.get("state") == Some(&json!("running"))
            && truthy(question)
            && field(question, "answer").is_none()
        {
            return Ok(json!({"allowed": true}));
        }
        let state = task.get("state").and_then(Value::as_str);
        let review = task.get("review");
        let options = work.get("options");
        let reason = if truthy(task.get("archived"))
            || !state.is_some_and(|s| RESTARTABLE.contains(&s))
            || truthy(field(review, "accepted"))
            || state == Some("done") && field(review, "accepted") != Some(&Value::Bool(false))
        {
            Some("Work is not eligible for another attempt")
        } else if truthy(task.get("runnerPid")) && (self.pid_alive)(&task["runnerPid"])
            || truthy(task.get("childPid")) && (self.pid_alive)(&task["childPid"])
        {
            Some("Previous executor is still active")
        } else if truthy(task.get("worktree"))
            && !task["worktree"]
                .as_str()
                .is_some_and(|path| std::path::Path::new(path).exists())
        {
            Some("Task worktree is unavailable")
        } else if field(options, "expiresAt")
            .is_some_and(|expires| to_number(Some(expires)) <= self.now)
        {
            Some("Work deadline has expired")
        } else if attempts_of(task).len() as f64
            >= field(options, "maxAttempts")
                .filter(|v| !v.is_null())
                .map_or(3.0, |v| to_number(Some(v)))
        {
            Some("Managed work attempt limit reached")
        } else if !crate::state::dependencies(self.db, id)
            .map_err(|e| WorkReadError::Other(e.0))?
            .is_empty()
        {
            Some("Required dependencies have not been reviewed")
        } else {
            self.stopped_ancestor(work)?
                .then_some("A stopped ancestor cannot resume child work")
        };
        Ok(reason.map_or_else(
            || json!({"allowed": true}),
            |reason| json!({"allowed": false, "reason": reason}),
        ))
    }

    fn stopped_ancestor(&self, work: &Map<String, Value>) -> Result<bool, WorkReadError> {
        let mut seen = HashSet::new();
        let mut parent = work.get("parentId").cloned();
        while let Some(Value::String(id)) = parent.filter(|p| truthy(Some(p))) {
            if !seen.insert(id.clone()) {
                break;
            }
            let Some(ancestor) = self.work(&id)? else {
                break;
            };
            if self
                .task(&ancestor.task_id)?
                .is_some_and(|t| t.get("state") == Some(&json!("stopped")))
            {
                return Ok(true);
            }
            parent = Some(ancestor.parent_id);
        }
        Ok(false)
    }

    /// `workWaitTotals`.
    fn wait_totals(&self, ids: &[&str]) -> Result<Waits, WorkReadError> {
        let (mut queue, mut dependency, mut child, mut capacity) = (0.0, 0.0, 0.0, 0.0);
        let (mut provisional, mut unknown_dependency, mut measured_capacity) = (0, 0, 0);
        let mut rows_for = self
            .db
            .prepare("SELECT kind,started_at,total_seconds FROM work_waits WHERE task_id=?")?;
        let mut changed = self.db.prepare(
            "SELECT 1 FROM work_events WHERE task_id=? AND kind='dependencies.changed' LIMIT 1",
        )?;
        for id in ids {
            let rows = rows_for
                .query_map([id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<f64>>(1)?,
                        r.get::<_, f64>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if !rows.iter().any(|(kind, _, _)| kind == "dependency") && changed.exists([id])? {
                unknown_dependency += 1;
            }
            for (kind, started_at, total) in rows {
                let seconds = total + started_at.map_or(0.0, |at| js_max0(self.now - at));
                match kind.as_str() {
                    "queue" => queue += seconds,
                    "dependency" => dependency += seconds,
                    "child" => child += seconds,
                    "capacity" => {
                        capacity += seconds;
                        measured_capacity += 1;
                    }
                    _ => {}
                }
                if started_at.is_some() {
                    provisional += 1;
                }
            }
        }
        Ok(Waits {
            queue,
            dependency: (unknown_dependency == 0).then_some(dependency),
            child,
            capacity: (measured_capacity > 0).then_some(capacity),
            provisional,
        })
    }

    /// `workTotals` with measured waits.
    fn totals(
        &self,
        nodes: &[Value],
        attempts: &[Value],
        items: &[TokenItem],
        waits: &Waits,
    ) -> Value {
        let count = |state: &str| {
            nodes
                .iter()
                .filter(|n| n.get("state") == Some(&json!(state)))
                .count()
        };
        let execution = attempts.iter().fold(0.0, |sum, a| {
            sum + js_max0(to_number(a.get("endedAt")) - to_number(a.get("startedAt")))
        });
        let pools = usage_pools(attempts);
        let unknown: u64 = pools
            .iter()
            .map(|p| p["unknownAttempts"].as_u64().unwrap_or(0))
            .sum();
        json!({
            "tasks": nodes.len(),
            "running": count("running"),
            "queued": count("queued"),
            "executionSeconds": js_value(execution),
            "queueWaitSeconds": js_value(waits.queue),
            "dependencyWaitSeconds": waits.dependency.map(js_value),
            "childWaitSeconds": js_value(waits.child),
            "capacityWaitSeconds": waits.capacity.map(js_value),
            "provisionalWaits": waits.provisional,
            "waitAsOf": js_value(self.now),
            "tokens": rollup_tokens(items),
            "usagePools": pools,
            "usageMeasuredAttempts": attempts.len() as i64 - unknown as i64,
            "usageUnknownAttempts": unknown,
        })
    }
}

fn node_row(r: &Row<'_>) -> rusqlite::Result<NodeRow> {
    Ok(NodeRow {
        task_id: r.get("task_id")?,
        parent_id: sql_json(r.get_ref("parent_id")?),
        root_id: r.get("root_id")?,
        depth: sql_json(r.get_ref("depth")?),
        options: r.get("options")?,
        dependencies: r.get("dependencies")?,
    })
}

/// `node(r)`: stored options default to cooperative enforcement.
fn node_json(row: &NodeRow) -> Result<Map<String, Value>, WorkReadError> {
    let stored: Value = serde_json::from_str(&row.options)?;
    let mut options = stored.as_object().cloned().unwrap_or_default();
    if nullish(options.get("delegationEnforcement")) {
        options.insert("delegationEnforcement".into(), json!("cooperative"));
    }
    let mut node = Map::new();
    node.insert("taskId".into(), json!(row.task_id));
    node.insert("parentId".into(), row.parent_id.clone());
    node.insert("rootId".into(), json!(row.root_id));
    node.insert("depth".into(), row.depth.clone());
    node.insert("options".into(), Value::Object(options));
    node.insert(
        "dependencies".into(),
        serde_json::from_str(&row.dependencies)?,
    );
    Ok(node)
}

/// The requested node and every descendant; rows arrive parents first (by depth).
fn visible(id: &str, rows: &[NodeRow]) -> HashSet<String> {
    let mut visible = HashSet::from([id.to_owned()]);
    for row in rows {
        if let Value::String(parent) = &row.parent_id
            && !parent.is_empty()
            && visible.contains(parent)
        {
            visible.insert(row.task_id.clone());
        }
    }
    visible
}

fn tree_attempt(a: &Value) -> Value {
    let mut out = Map::new();
    out.insert(
        "tokens".into(),
        a.get("tokens").cloned().unwrap_or(Value::Null),
    );
    put(&mut out, "executor", a.get("executor"));
    out.insert("model".into(), or_null(a.get("model")));
    out.insert("actualModel".into(), or_null(a.get("actualModel")));
    for key in ["startedAt", "endedAt", "exitCode", "timedOut", "limitHit"] {
        put(&mut out, key, a.get(key));
    }
    out.insert("usageAtStart".into(), or_null(a.get("usageAtStart")));
    out.insert("usageAtEnd".into(), or_null(a.get("usageAtEnd")));
    Value::Object(out)
}

/// `itemsOf` for one attempt.
fn item_of(
    executor: Value,
    model: Option<&Value>,
    actual_model: Option<&Value>,
    usage_at_start: Option<&Value>,
    tokens: Value,
) -> TokenItem {
    let account = or_null(coalesce(
        field(usage_at_start, "account"),
        runner_account(&executor).as_ref(),
    ));
    TokenItem {
        model: or_null(coalesce(actual_model, model)),
        executor,
        account,
        tokens,
    }
}

/// `attemptTokensFromRow`.
fn tokens_from_row(row: &Map<String, Value>) -> Value {
    let get = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    let mut out = json!({"coverage": get("coverage"), "input": get("input"), "cacheRead": get("cache_read"),
        "cacheWrite": get("cache_write"), "output": get("output"), "reasoning": get("reasoning"),
        "total": get("total"), "turns": get("turns"), "source": get("source"),
        "selfReported": row.get("self_reported").and_then(Value::as_f64) == Some(1.0),
        "extractor": get("extractor"), "capturedAt": get("captured_at")});
    if truthy(row.get("note")) {
        out["note"] = get("note");
    }
    out
}

/// `parseRunnerId`: agent, account.
fn parse_runner_id(id: &str) -> Option<(&str, Option<&str>)> {
    let segment = |s: &str| {
        s.as_bytes()
            .first()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && s.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    };
    let (main, host) = id.split_once('@').map_or((id, None), |(m, h)| (m, Some(h)));
    let (agent, account) = main
        .split_once('#')
        .map_or((main, None), |(a, b)| (a, Some(b)));
    (segment(agent)
        && account.is_none_or(segment)
        && host.is_none_or(segment)
        && AGENTS.contains(&agent))
    .then_some((agent, account))
}

fn runner_account(executor: &Value) -> Option<Value> {
    let (_, account) = parse_runner_id(executor.as_str()?)?;
    account.map(|a| json!(a))
}

#[derive(Default)]
struct Sums {
    sums: [f64; 5],
    reported: [bool; 4],
    complete: [bool; 4],
    measured: u64,
    partial: u64,
    unknown: u64,
}
impl Sums {
    fn add(&mut self, tokens: &Value) {
        let first = self.measured + self.partial + self.unknown == 0;
        for (index, key) in TOKEN_FIELDS.iter().enumerate() {
            let reported = tokens.get(*key) != Some(&Value::Null);
            self.complete[index] = (first || self.complete[index]) && reported;
            self.reported[index] |= reported;
        }
        for (index, key) in ["total", "input", "cacheRead", "cacheWrite", "output"]
            .iter()
            .enumerate()
        {
            let value = tokens.get(*key);
            self.sums[index] += if nullish(value) {
                0.0
            } else {
                to_number(value)
            };
        }
        match tokens.get("coverage").and_then(Value::as_str) {
            Some("measured") => self.measured += 1,
            Some("partial") => self.partial += 1,
            _ => self.unknown += 1,
        }
    }
    fn write(&self, out: &mut Map<String, Value>) {
        for (index, key) in ["total", "input", "cacheRead", "cacheWrite", "output"]
            .iter()
            .enumerate()
        {
            out.insert((*key).into(), js_value(self.sums[index]));
        }
        let flags = |values: &[bool; 4]| {
            Value::Object(
                TOKEN_FIELDS
                    .iter()
                    .zip(values)
                    .map(|(k, v)| ((*k).to_owned(), json!(v)))
                    .collect(),
            )
        };
        out.insert("reported".into(), flags(&self.reported));
        out.insert("complete".into(), flags(&self.complete));
        out.insert("measuredAttempts".into(), json!(self.measured));
        out.insert("partialAttempts".into(), json!(self.partial));
        out.insert("unknownAttempts".into(), json!(self.unknown));
    }
}

/// `rollupTokens`.
fn rollup_tokens(items: &[TokenItem]) -> Value {
    let mut all = Sums::default();
    let mut groups: Vec<(String, Value, &TokenItem, u64, Sums)> = Vec::new();
    for item in items {
        all.add(&item.tokens);
        let agent = item
            .executor
            .as_str()
            .and_then(parse_runner_id)
            .map_or_else(|| item.executor.clone(), |(agent, _)| json!(agent));
        let key =
            serde_json::to_string(&json!([agent, item.account, item.model])).unwrap_or_default();
        let index = match groups.iter().position(|g| g.0 == key) {
            Some(index) => index,
            None => {
                groups.push((key, agent, item, 0, Sums::default()));
                groups.len() - 1
            }
        };
        groups[index].3 += 1;
        groups[index].4.add(&item.tokens);
    }
    groups.sort_by(|a, b| {
        let diff = b.4.sums[0] - a.4.sums[0];
        if diff != 0.0 && !diff.is_nan() {
            diff.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
        } else {
            js::compare(a.1.as_str().unwrap_or(""), b.1.as_str().unwrap_or(""))
        }
    });
    let by_executor: Vec<Value> = groups
        .iter()
        .map(|(_, agent, item, attempts, sums)| {
            let mut out = Map::new();
            out.insert("agent".into(), agent.clone());
            out.insert("account".into(), item.account.clone());
            out.insert("model".into(), item.model.clone());
            out.insert("attempts".into(), json!(attempts));
            sums.write(&mut out);
            Value::Object(out)
        })
        .collect();
    let mut out = Map::new();
    all.write(&mut out);
    out.insert(
        "lowerBound".into(),
        json!(all.unknown > 0 || all.partial > 0),
    );
    out.insert("byExecutor".into(), Value::Array(by_executor));
    out.insert("planner".into(), json!({"coverage": "unknown"}));
    out.insert("decision".into(), json!({"coverage": "unknown"}));
    Value::Object(out)
}

/// `observedUsageDelta` != null.
fn observed_usage(a: Option<&Value>, b: Option<&Value>) -> bool {
    let finite = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|n| n.is_finite());
    if !truthy(a) || !truthy(b) {
        return false;
    }
    let (a_at, b_at) = (field(a, "capturedAt"), field(b, "capturedAt"));
    let (a_pct, b_pct) = (field(a, "usedPct"), field(b, "usedPct"));
    let ordered = matches!((finite(a_at), finite(b_at)), (Some(x), Some(y)) if y > x);
    let pct = matches!((finite(a_pct), finite(b_pct)), (Some(x), Some(y)) if x >= 0.0 && y <= 100.0 && y >= x);
    truthy(field(a, "poolId"))
        && strict_eq(field(a, "poolId"), field(b, "poolId"))
        && !nullish(field(a, "resetEpoch"))
        && strict_eq(field(a, "resetEpoch"), field(b, "resetEpoch"))
        && strict_eq(field(a, "account"), field(b, "account"))
        && strict_eq(field(a, "window"), field(b, "window"))
        && field(a, "stale") == Some(&Value::Bool(false))
        && field(b, "stale") == Some(&Value::Bool(false))
        && truthy(field(a, "observationId"))
        && truthy(field(b, "observationId"))
        && !strict_eq(field(a, "observationId"), field(b, "observationId"))
        && ordered
        && pct
}

#[derive(Clone, Copy)]
struct Interval {
    start: f64,
    end: f64,
    start_pct: f64,
    end_pct: f64,
}

/// `usagePools`: shared-account observations grouped by account, pool and reset epoch.
fn usage_pools(attempts: &[Value]) -> Vec<Value> {
    struct Group {
        key: String,
        account: Value,
        pool: Value,
        reset: Value,
        intervals: Vec<Interval>,
        unknown: u64,
    }
    let mut groups: Vec<Group> = Vec::new();
    for attempt in attempts {
        let (a, b) = (
            attempt.get("usageAtStart").filter(|v| !v.is_null()),
            attempt.get("usageAtEnd").filter(|v| !v.is_null()),
        );
        let account = coalesce(field(a, "account"), field(b, "account"))
            .cloned()
            .unwrap_or_else(|| json!("unknown"));
        let pool =
            if truthy(field(a, "poolId")) && strict_eq(field(a, "poolId"), field(b, "poolId")) {
                a.and_then(|a| a.get("poolId"))
                    .cloned()
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            };
        let reset = if field(a, "resetEpoch").is_some()
            && strict_eq(field(a, "resetEpoch"), field(b, "resetEpoch"))
        {
            or_null(field(a, "resetEpoch"))
        } else {
            Value::Null
        };
        let key = stringify(&json!([account, pool, reset]));
        let index = match groups.iter().position(|g| g.key == key) {
            Some(index) => index,
            None => {
                groups.push(Group {
                    key,
                    account,
                    pool,
                    reset,
                    intervals: Vec::new(),
                    unknown: 0,
                });
                groups.len() - 1
            }
        };
        let group = &mut groups[index];
        if observed_usage(a, b) {
            let n = |v: Option<&Value>, k: &str| to_number(field(v, k));
            group.intervals.push(Interval {
                start: n(a, "capturedAt"),
                end: n(b, "capturedAt"),
                start_pct: n(a, "usedPct"),
                end_pct: n(b, "usedPct"),
            });
        } else {
            group.unknown += 1;
        }
    }
    let mut out: Vec<(String, Value)> = groups
        .into_iter()
        .map(|mut group| {
            let order = |a: f64, b: f64| a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal);
            group.intervals.sort_by(|a, b| order(a.start, b.start));
            let mut observations: Vec<(f64, f64)> = group
                .intervals
                .iter()
                .flat_map(|i| [(i.start, i.start_pct), (i.end, i.end_pct)])
                .collect();
            observations.sort_by(|a, b| order(a.0, b.0).then(order(a.1, b.1)));
            let inconsistent_observations = observations.windows(2).any(|w| {
                w[1].1 < w[0].1 || w[1].0 == w[0].0 && w[1].1 != w[0].1
            });
            let mut merged: Vec<Interval> = Vec::new();
            for interval in &group.intervals {
                match merged.last_mut() {
                    Some(last) if interval.start <= last.end => {
                        if interval.end > last.end {
                            last.end = interval.end;
                            last.end_pct = interval.end_pct;
                        } else if interval.end == last.end {
                            last.end_pct = last.end_pct.max(interval.end_pct);
                        }
                    }
                    _ => merged.push(*interval),
                }
            }
            let inconsistent =
                inconsistent_observations || merged.iter().any(|i| i.end_pct < i.start_pct);
            let delta = if group.unknown > 0 || inconsistent {
                Value::Null
            } else {
                js_value(merged.iter().fold(0.0, |sum, i| sum + i.end_pct - i.start_pct))
            };
            let value = json!({"account": group.account, "poolId": group.pool, "resetEpoch": group.reset,
                "observedDeltaPct": delta, "measuredIntervals": merged.len(),
                "unknownAttempts": group.unknown + u64::from(inconsistent),
                "attribution": "shared-account-observation"});
            (group.key, value)
        })
        .collect();
    out.sort_by(|a, b| js::compare(&a.0, &b.0));
    out.into_iter().map(|(_, value)| value).collect()
}

/// `listBranch`: the branch a list row shows without spawning git.
fn list_branch(task: &Value) -> Value {
    let run = task.get("run");
    let known = match field(run, "remoteBranch") {
        Some(branch) if !branch.is_null() => branch.clone(),
        _ if field(run, "mode") == Some(&json!("new")) => {
            json!(format!(
                "pacer/{}",
                task.get("id").map_or_else(|| "undefined".into(), display)
            ))
        }
        _ => Value::Null,
    };
    if truthy(Some(&known)) || truthy(field(run, "host")) {
        return known;
    }
    let worktree = coalesce(
        coalesce(field(run, "workdir"), task.get("worktree")),
        field(task.get("result"), "worktree"),
    );
    head_branch(worktree).map_or(Value::Null, Value::String)
}

fn display(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(_) => stringify(value),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

/// `headBranch`: the checked-out branch read from the worktree's HEAD file.
fn head_branch(worktree: Option<&Value>) -> Option<String> {
    if !truthy(worktree) {
        return None;
    }
    let worktree = worktree?.as_str()?;
    let dot = path_join(&[worktree, ".git"]);
    let dir = if std::fs::metadata(&dot).ok()?.is_dir() {
        dot.clone()
    } else {
        let text = String::from_utf8_lossy(&std::fs::read(&dot).ok()?).into_owned();
        let target = line_capture(&text, "gitdir:", "")
            .map(|t| js::trim(&t).to_owned())
            .unwrap_or_default();
        if target.is_empty() {
            String::new()
        } else if target.starts_with('/') {
            target
        } else {
            path_resolve(&path_dirname(&dot), &target)
        }
    };
    let head =
        String::from_utf8_lossy(&std::fs::read(path_join(&[&dir, "HEAD"])).ok()?).into_owned();
    let branch = line_capture(&head, "ref:", "refs/heads/")?;
    let branch = js::trim(&branch);
    (!branch.is_empty()).then(|| branch.to_owned())
}

fn line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// The multiline JavaScript match `/^<prefix>\s*<literal>(.+)$/m`, returning group 1.
fn line_capture(text: &str, prefix: &str, literal: &str) -> Option<String> {
    let starts = std::iter::once(0).chain(
        text.char_indices()
            .filter(|(_, c)| line_terminator(*c))
            .map(|(i, c)| i + c.len_utf8()),
    );
    for start in starts {
        let Some(rest) = text[start..].strip_prefix(prefix) else {
            continue;
        };
        let spaces: Vec<usize> = std::iter::once(0)
            .chain(
                rest.char_indices()
                    .take_while(|(_, c)| js_space(*c))
                    .map(|(i, c)| i + c.len_utf8()),
            )
            .collect();
        for offset in spaces.iter().rev() {
            let Some(tail) = rest[*offset..].strip_prefix(literal) else {
                continue;
            };
            let end = tail.find(line_terminator).unwrap_or(tail.len());
            if end > 0 {
                return Some(tail[..end].to_owned());
            }
        }
    }
    None
}

/// POSIX `path.normalize` without the trailing-separator case.
fn path_normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|p| *p != "..") => {
                parts.pop();
            }
            ".." if absolute => {}
            _ => parts.push(part),
        }
    }
    let joined = parts.join("/");
    match (absolute, joined.is_empty()) {
        (true, _) => format!("/{joined}"),
        (false, true) => ".".into(),
        (false, false) => joined,
    }
}

fn path_join(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        ".".into()
    } else {
        path_normalize(&joined)
    }
}

fn path_dirname(path: &str) -> String {
    match path.rfind('/') {
        Some(0) => "/".into(),
        Some(index) => path[..index].to_owned(),
        None => ".".into(),
    }
}

fn path_resolve(base: &str, target: &str) -> String {
    let joined = if target.starts_with('/') {
        target.to_owned()
    } else if base.starts_with('/') {
        format!("{base}/{target}")
    } else {
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "/".into());
        format!("{cwd}/{base}/{target}")
    };
    path_normalize(&joined)
}

fn attempts_of(task: &Value) -> &[Value] {
    task.get("attempts")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn title(task: &Value) -> Option<&Value> {
    coalesce(task.get("title"), field(task.get("brief"), "goal"))
}

/// `visibleTaskState`.
fn visible_state(task: &Value) -> Option<Value> {
    let question = task.get("question");
    if task.get("state") == Some(&json!("running"))
        && truthy(question)
        && field(question, "answer").is_none()
    {
        Some(json!("needs_input"))
    } else {
        task.get("state").cloned()
    }
}

fn field<'v>(value: Option<&'v Value>, key: &str) -> Option<&'v Value> {
    value?.as_object()?.get(key)
}

fn nullish(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

/// `a ?? b`.
fn coalesce<'v>(a: Option<&'v Value>, b: Option<&'v Value>) -> Option<&'v Value> {
    if nullish(a) { b } else { a }
}

fn or_null(value: Option<&Value>) -> Value {
    if nullish(value) {
        Value::Null
    } else {
        value.cloned().unwrap_or(Value::Null)
    }
}

/// Copy a defined value; `JSON.stringify` omits undefined properties.
fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// JavaScript `===` between two parsed JSON values (objects are distinct references).
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// JavaScript `Number(value)` for arithmetic on record fields.
fn to_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let s = js::trim(s);
            if s.is_empty() {
                0.0
            } else {
                s.parse().unwrap_or(f64::NAN)
            }
        }
        Some(_) => f64::NAN,
    }
}

/// `Math.max(0, x)`, which propagates NaN.
fn js_max0(x: f64) -> f64 {
    if x.is_nan() { x } else { x.max(0.0) }
}

/// A JavaScript number as `JSON.stringify` writes it; non-finite values become null.
fn js_value(n: f64) -> Value {
    if !n.is_finite() {
        Value::Null
    } else if n == 0.0 {
        json!(0)
    } else if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        json!(n as i64)
    } else {
        // `Number#toString` text; it survives verbatim when serde_json keeps number text.
        serde_json::from_str(&js::number(n)).unwrap_or_else(|_| json!(n))
    }
}

/// Every number crossed the binary64 boundary in TypeScript; write it the same way.
fn js_numbers(value: &mut Value) {
    match value {
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                *value = js_value(f);
            }
        }
        Value::Array(values) => values.iter_mut().for_each(js_numbers),
        Value::Object(map) => map.values_mut().for_each(js_numbers),
        _ => {}
    }
}

/// `JSON.stringify` for the scalar keys used in sort comparisons.
fn stringify(value: &Value) -> String {
    match value {
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if !f.is_finite() {
                "null".into()
            } else if f == 0.0 {
                "0".into()
            } else {
                js::number(f)
            }
        }
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(stringify).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(k, v)| format!("{}:{}", Value::String(k.clone()), stringify(v)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => other.to_string(),
    }
}

/// Bun's SQLite value for a column.
fn sql_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null | ValueRef::Blob(_) => Value::Null,
        ValueRef::Integer(n) => json!(n),
        ValueRef::Real(f) => js_value(f),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
    }
}

#[cfg(test)]
#[path = "work_reads/tests.rs"]
mod tests;
