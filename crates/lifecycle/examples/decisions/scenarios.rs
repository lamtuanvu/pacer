use pacer_lifecycle::{Error, attention::Item, clients, jobs, notify};
use serde_json::{Value, json};
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn n(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}
fn a(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn now(c: &Value) -> f64 {
    c["now"].as_f64().unwrap_or(100.0)
}
fn truth(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(_) => n(v) != 0.0,
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub fn clients(c: &Value) -> Value {
    use clients::*;
    let mut raw = c["raw"].clone();
    let mut time = now(c);
    let mut results = vec![];
    for action in a(&c["actions"]) {
        if let Some(t) = action["now"].as_f64() {
            time = t;
        }
        let mut rows = read(&raw);
        let result = match s(&action["type"]) {
            "register" => {
                let result = register(&mut rows, &action["options"], s(&action["id"]), time);
                raw = json!(rows);
                result
            }
            "heartbeat" => match heartbeat(&mut rows, s(&action["id"]), time) {
                Ok(result) => {
                    raw = json!(rows);
                    result
                }
                Err(e) => e.value(),
            },
            "active" => active(&rows, time),
            _ => json!(list(&rows, time)),
        };
        results.push(result);
    }
    json!({"results":results,"state":raw})
}

pub fn jobs(c: &Value) -> Value {
    use jobs::*;
    let time = now(c);
    let job = &c["job"];
    match s(&c["op"]) {
        "job.cancel" => cancel(job, time).unwrap_or_else(|e| e.value()),
        "job.list" => json!(list(
            std::slice::from_ref(job),
            time,
            c["filter"]["target"].as_str()
        )),
        "job.recover" => {
            let (job, recovery) = recover(
                job,
                time,
                c["version"].as_str().unwrap_or("1.0"),
                truth(&c["alive"]),
                truth(&c["afterRestart"]),
            );
            json!({"job":job,"handover":recovery==Recovery::Handover})
        }
        "job.finishRestart" => {
            let failed = truth(&c["failed"]);
            let detail = if failed {
                format!(
                    "{} · running work was not handed over: {}",
                    c["version"].as_str().unwrap_or("1.0"),
                    s(&c["detail"])
                )
            } else {
                s(&c["detail"]).into()
            };
            finish_restart(c.get("latest").unwrap_or(job), 20.0, &detail, failed)
        }
        "job.run" => {
            let mut out = create(
                "new-job",
                c["kind"].as_str().unwrap_or("host.check"),
                "new",
                a(&c["steps"]),
                time,
                42.0,
                truth(&c["cancellable"]),
            );
            let mut stored = out.clone();
            let mut error = None;
            for action in a(&c["actions"]) {
                let result = if action["type"] == "cancel" {
                    cancel(&stored, time).map(|v| stored = v)
                } else {
                    let state = match s(&action["type"]) {
                        "start" => "running",
                        "pass" => "passed",
                        "fail" => "failed",
                        _ => "skipped",
                    };
                    let result = update(
                        &mut out,
                        &stored,
                        s(&action["name"]),
                        state,
                        action["detail"].as_str(),
                    );
                    if stored["state"] == "running" && result.is_ok() {
                        stored = out.clone();
                    }
                    result
                };
                if let Err(e) = result {
                    error = Some(e);
                    break;
                }
            }
            if error.is_none() && truth(&c["runError"]) {
                error = Some(Error::new(
                    s(&c["runError"]["code"]),
                    s(&c["runError"]["message"]),
                ));
            }
            finish(
                &out,
                &stored,
                time,
                truth(&c["awaitRestart"]),
                error.as_ref(),
            )
        }
        _ => Value::Null,
    }
}

pub fn notify(c: &Value) -> notify::Report {
    use notify::*;
    let items: Vec<_> = a(&c["items"]).iter().map(Item::from_value).collect();
    let level = s(&c["level"]);
    let time = now(c);
    let mut state = retain(&c["raw"], time);
    let original = candidates(&items, level, &c["raw"]);
    let mut pending = candidates(&items, level, &state);
    transitions(&mut pending, &items, level, a(&c["events"]));
    let mut report = Report {
        candidates: original,
        sent: vec![],
        deliveries: vec![],
        publications: vec![],
        state: Value::Null,
    };
    for candidate in pending {
        if state.get(&candidate.key).is_some() {
            continue;
        }
        let mut data = candidate.data;
        let presenters = if truth(&c["notifier"]) {
            vec![json!({
                "client_id": s(&c["notifier"]["client_id"]),
                "kind": "desktop",
                "medium": "os",
            })]
        } else {
            vec![]
        };
        let delivered = if assign_presenters(&mut data, &presenters) {
            let make = |data: Data| NotificationEvent {
                kind: "entity",
                data: EventData {
                    kind: "notify",
                    id: candidate.key.clone(),
                    value: data,
                },
            };
            report.publications.push(vec![make(data.clone())]);
            let delivered = c["publishOk"] != false;
            if delivered {
                report.sent.push(make(data));
            }
            delivered
        } else {
            let data = plugin_message(&data);
            let ids: Vec<_> = c
                .get("notifiers")
                .map(a)
                .map(|ids| ids.iter().map(|id| s(id).to_owned()).collect())
                .unwrap_or_else(|| vec!["z".into(), "a".into()]);
            let ids = provider_order(&ids);
            let mut delivered = false;
            for id in ids {
                report.deliveries.push(Delivery {
                    id: id.clone(),
                    data: data.clone(),
                });
                if c["deliveries"].get(&id).map(|v| v == true).unwrap_or(true) {
                    delivered = true;
                    break;
                }
            }
            delivered
        };
        record_delivery(&mut state, &candidate.key, time, delivered);
    }
    report.state = state;
    report
}
