#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_sessions::control::Controller;
use serde_json::{Value, json};
#[test]
fn arbitration_matches_ts_wire_and_events() {
    let rows: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/sessions/viewers-parity.json"
    ))
    .unwrap();
    for row in rows.as_array().unwrap() {
        let mut hub = match row.get("host") {
            Some(host) => Controller::with_host(
                serde_json::from_value(host.clone()).unwrap(),
                "0.0.0-golden",
            ),
            None => Controller::default(),
        };
        let mut trace = vec![];
        let mut order = vec![];
        for step in row["steps"].as_array().unwrap() {
            let id = step[1].as_str().unwrap();
            match step[0].as_str().unwrap() {
                "join" => {
                    let _admitted = hub.join(
                        id,
                        step.get(2)
                            .and_then(Value::as_str)
                            .unwrap_or(&format!("cli:{id}")),
                        step.get(3).unwrap_or(&json!({})),
                    );
                    order.push(id);
                }
                "take" => hub.take(id, &step[2]),
                "release" => hub.release(id),
                "disconnect" => hub.disconnect(id),
                "input" => hub.input(id, step[2].as_str().unwrap().as_bytes(), false),
                "focus" => hub.focus(id),
                "size" => hub.resize(id, &step[2]),
                _ => panic!(),
            }
            let mut messages = std::mem::take(&mut hub.messages);
            messages.sort_by_key(|v| order.iter().position(|id| v["id"] == *id).unwrap());
            trace.push(json!({"controller":hub.holder(),"active":hub.active(),"size":hub.size(),"events":std::mem::take(&mut hub.events),"messages":messages}));
        }
        assert_eq!(json!(trace), row["trace"], "{}", row["steps"]);
    }
}
