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
        let mut hub = Controller::default();
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
                    );
                    order.push(id);
                }
                "take" => hub.take(id, &step[2]["force"]),
                "release" => hub.release(id),
                "disconnect" => hub.disconnect(id),
                "input" => {
                    let s = step[2].as_str().unwrap();
                    if hub.input(id, s.as_bytes()) {
                        hub.events.push(json!(["input", s]));
                    }
                }
                "size" => {
                    if let Some((c, r)) = hub.resize(id, &step[2]["cols"], &step[2]["rows"]) {
                        hub.events.push(json!(["resize", c, r]));
                    }
                }
                _ => panic!(),
            }
            let mut messages = std::mem::take(&mut hub.messages);
            messages.sort_by_key(|v| order.iter().position(|id| v["id"] == *id).unwrap());
            trace.push(json!({"controller":hub.holder(),"size":hub.size(),"events":std::mem::take(&mut hub.events),"messages":messages}));
        }
        assert_eq!(json!(trace), row["trace"]);
    }
}
