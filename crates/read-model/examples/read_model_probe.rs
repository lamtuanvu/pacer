//! Line-oriented test adapter. Never installed or registered as a native op.
use pacer_foundation::Ctx;
use pacer_read_model::{
    ActiveSession, Probes, ReadModel, SessionProbe, SnapshotInput, StatusInput, events, js::*,
};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut model = ReadModel::new();
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line?)?;
        let ctx = Ctx::with(
            text(&input["home"]).into(),
            text(&input["pacerHome"]).into(),
            serde_json::from_value(input.get("env").cloned().unwrap_or(json!({})))?,
            num(&input["now"]),
        );
        let zone = text(&input["zone"])
            .parse()
            .unwrap_or(chrono_tz::Asia::Ho_Chi_Minh);
        let alive = |pid: i64| {
            array(&input["alive"])
                .iter()
                .any(|p| p.as_i64() == Some(pid))
        };
        let result = match text(&input["op"]) {
            "capacity" => {
                let sessions = if input.get("sessions").is_some() {
                    array(&input["sessions"]["active"])
                        .iter()
                        .map(|s| ActiveSession {
                            task_id: text(&s["task_id"]).to_string(),
                            executor: text(&s["executor"]).to_string(),
                        })
                        .collect::<Vec<_>>()
                } else {
                    Vec::new()
                };
                let active = pacer_read_model::ActiveCounts::from_sessions(&sessions);
                stringify(
                    &json!({"executors":pacer_read_model::capacity::executors(&ctx,&active,&input["status"],&input["strategy"],array(&input["tasks"])),"accounts":pacer_read_model::capacity::accounts_in_home(&ctx,&input["status"],&input["strategy"]),"planner":pacer_read_model::capacity::planner(&input["status"],zone)}),
                )
            }
            "events" => events::events_document(
                &ctx,
                num(&input["since"]),
                input["protocol"].as_u64().unwrap_or(3) as u8,
                model.store(&ctx)?,
                zone,
                &alive,
            )?
            .json(),
            "tasks" => pacer_read_model::tasks::snapshot_document(
                &ctx,
                array(&input["records"]),
                model.store(&ctx)?,
                &alive,
            )?
            .json(),
            "cursor" => {
                match events::parse_cursor(input["header"].as_str(), input["query"].as_str()) {
                    Ok(n) => stringify(&json!({
                    "cursor":number(n)}
                    )),
                    Err(e) => stringify(&json!({
                    "error":{
                    "code":"invalid_input","message":e.to_string()}
                    }
                    )),
                }
            }
            _ => {
                let probes = Probes {
                    setup: input["setup"].clone(),
                    policy: input["policy"].clone(),
                    machine: input["machine"].clone(),
                    service: input["service"].clone(),
                    desktop_updates: array(&input["desktopUpdates"]).to_vec(),
                    service_installed: truth(&input["serviceInstalled"]),
                    can_pair: truth(&input["canPair"]),
                    // Only a MISSING sessions field selects Default. An explicitly
                    // supplied revision is passed through verbatim, even if empty.
                    sessions: if input.get("sessions").is_some() {
                        SessionProbe {
                            revision: text(&input["sessions"]["revision"]).to_string(),
                            active: array(&input["sessions"]["active"])
                                .iter()
                                .map(|s| ActiveSession {
                                    task_id: text(&s["task_id"]).to_string(),
                                    executor: text(&s["executor"]).to_string(),
                                })
                                .collect(),
                        }
                    } else {
                        SessionProbe::default()
                    },
                };
                let status = if input["useCache"] == true {
                    StatusInput::Cached
                } else if let Some(message) = input["statusError"].as_str() {
                    StatusInput::Failure(message.into())
                } else {
                    StatusInput::Provided(input["status"].clone())
                };
                let mut options = SnapshotInput::new(&probes, status);
                options.max_budget_age_s = input["maxBudgetAgeS"].as_f64().unwrap_or(60.0);
                model
                    .snapshot(&ctx, options, zone, &alive)?
                    .json(input["protocol"].as_u64().unwrap_or(3) as u8)
            }
        };
        writeln!(out, "{result}")?;
        out.flush()?;
    }
    Ok(())
}
