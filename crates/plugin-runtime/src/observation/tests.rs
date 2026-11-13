#![allow(clippy::unwrap_used)]
use super::*;
use crate::ProcessOwner;
use pacer_plugin_host::SpawnSpec;
use std::{collections::HashMap, path::PathBuf, time::Instant};
use tempfile::TempDir;

const GENERATION: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const CURSOR: u64 = 3_000_000_000_004;
const ID: &str = "fx-obs";

type Core = Box<dyn Fn(&Value) -> Result<Value, DoorRefusal> + Send + Sync>;

/// A live child that records every byte it reads, under a native owner whose
/// door is a scripted Core that keeps every body it was sent.
struct Fixture {
    _owner: ProcessOwner,
    lane: Arc<PluginLane>,
    sent: Arc<StdMutex<Vec<Value>>>,
    lines: PathBuf,
    dir: TempDir,
}

impl Fixture {
    async fn new(capabilities: &[&str], core: Core) -> Self {
        let dir = TempDir::new().unwrap();
        let lines = dir.path().join("lines");
        let script = format!(
            r#"const r=Bun.stdin.stream().getReader();const {{appendFileSync}}=require('node:fs');for(;;){{const {{value,done}}=await r.read();if(done)break;appendFileSync({:?},value);}}"#,
            lines.to_str().unwrap()
        );
        let spec = SpawnSpec {
            argv: vec!["bun".into(), "-e".into(), script],
            cwd: dir.path().to_path_buf(),
            env: std::env::vars().collect(),
        };
        let mut owner = ProcessOwner::native_for_tests();
        let (sink, mut requests) = mpsc::unbounded_channel::<DoorRequest>();
        owner.set_door_sink(sink);
        let sent = Arc::new(StdMutex::new(Vec::new()));
        tokio::spawn({
            let sent = Arc::clone(&sent);
            async move {
                while let Some(request) = requests.recv().await {
                    sent.lock().unwrap().push(request.body.clone());
                    let _ = request.reply.send(core(&request.body));
                }
            }
        });
        owner.spawn(ID, &spec).unwrap();
        let lane = owner.lane(ID).unwrap();
        let capabilities: Vec<Value> = capabilities
            .iter()
            .map(|name| json!({"name": name}))
            .collect();
        let hello = json!({
            "protocol":"1.10.0","pacer":"0.2.0",
            "manifest":{"id":ID,"version":"1.0.0","publisher":"fixture","host":">=1.10.0",
                "capabilities":capabilities,"contributes":{"policy":{}}},
            "config":{"types":["task"]},
            "grants":capabilities.iter().map(|c| c["name"].clone()).collect::<Vec<_>>(),
            "features":["policyObservations"]
        });
        lane.mark_ready(Some(json!({"features":["policyObservations"]})));
        lane.observation().install(ID, &hello, lane.process());
        Self {
            _owner: owner,
            lane,
            sent,
            lines,
            dir,
        }
    }

    fn call(&self, grants: &[&str]) -> CallObservation {
        CallObservation {
            call: ObservationCall::new(
                "call-token".into(),
                Instant::now() + Duration::from_secs(60),
                grants.iter().map(|grant| (*grant).to_owned()).collect(),
                true,
            ),
            context: ReadContext {
                home: self.dir.path().to_path_buf(),
                pacer_home: self.dir.path().join(".pacer"),
                env: HashMap::new(),
                now: 1.0,
            },
            generation: Some(GENERATION.into()),
        }
    }

    async fn answer(
        &self,
        method: &str,
        params: Value,
        meta: Value,
        call: Option<&CallObservation>,
    ) -> Result<Value, Value> {
        let meta = (!meta.is_null()).then_some(meta);
        self.lane
            .observation()
            .answer(method, params, meta, call)
            .await
    }

    async fn subscribe(&self, call: &CallObservation) -> String {
        let reply = self
            .answer(
                "capability.events.subscribe",
                json!({"types":["task"]}),
                json!({"capabilityCall":"call-token"}),
                Some(call),
            )
            .await
            .unwrap();
        reply["readOwner"].as_str().unwrap().to_owned()
    }

    fn sent(&self, kind: &str) -> Vec<Value> {
        let sent = self.sent.lock().unwrap();
        sent.iter()
            .filter(|body| body["kind"] == kind)
            .cloned()
            .collect()
    }

    async fn exited(&self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.lane.process().is_alive() {
            if Instant::now() > deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        true
    }
}

fn events_after(body: &Value, events: &Value, last: u64) -> Result<Value, DoorRefusal> {
    Ok(if body["since"].is_null() {
        json!({"last": CURSOR})
    } else if body["since"] == CURSOR {
        json!({"events": events, "last": last, "reset": false})
    } else {
        json!({"events": [], "last": last, "reset": false})
    })
}

fn message(error: &Value) -> &str {
    error["message"].as_str().unwrap()
}

#[tokio::test]
async fn subscription_delivers_core_events_in_order_as_javascript_writes_them() {
    let events: Value = serde_json::from_str(
        r#"[{"seq":3000000000005,"at":1.5,"type":"task","data":{"id":"t1","usd":1e21,"b":1,"a":2}},
            {"seq":3000000000007,"at":2,"type":"task","data":{"id":"t2","state":"stopped"}}]"#,
    )
    .unwrap();
    let fixture = Fixture::new(
        &["tasks.read", "events.subscribe"],
        Box::new(move |body| events_after(body, &events, 3_000_000_000_007)),
    )
    .await;
    fixture
        .subscribe(&fixture.call(&["tasks.read", "events.subscribe"]))
        .await;
    let deadline = Instant::now() + Duration::from_secs(5);
    while std::fs::read_to_string(&fixture.lines).map_or(0, |text| text.lines().count()) < 2 {
        assert!(Instant::now() < deadline, "the events never arrived");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        std::fs::read_to_string(&fixture.lines).unwrap(),
        concat!(
            r#"{"jsonrpc":"2.0","method":"$/event","params":{"seq":3000000000005,"at":1.5,"type":"task","data":{"id":"t1","usd":1e+21,"b":1,"a":2}}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","method":"$/event","params":{"seq":3000000000007,"at":2,"type":"task","data":{"id":"t2","state":"stopped"}}}"#,
            "\n"
        )
    );
    let pumps = fixture.sent("observation_events");
    assert_eq!(
        pumps[0],
        json!({"kind":"observation_events","id":ID,"generation":GENERATION,"since":null,"types":["reset"]})
    );
    assert_eq!(
        pumps[1],
        json!({"kind":"observation_events","id":ID,"generation":GENERATION,"since":CURSOR,"types":["task"]})
    );
    assert!(
        pumps[2..]
            .iter()
            .all(|body| body["since"] == 3_000_000_000_007_u64),
        "the cursor follows Core's last: {pumps:?}"
    );
}

#[tokio::test]
async fn retired_generation_refuses_its_read_owner() {
    let fixture = Fixture::new(
        &["tasks.read", "events.subscribe"],
        Box::new(|body| match body["kind"].as_str() {
            Some("observation_read") => Ok(json!({"task":{"id":"t1","state":"queued"}})),
            _ => events_after(body, &json!([]), CURSOR),
        }),
    )
    .await;
    let owner = fixture
        .subscribe(&fixture.call(&["tasks.read", "events.subscribe"]))
        .await;
    let read = || {
        fixture.answer(
            "capability.tasks.read",
            json!({"id":"t1"}),
            json!({"readOwner": owner}),
            None,
        )
    };
    assert_eq!(read().await.unwrap()["task"]["id"], "t1");
    assert_eq!(
        fixture.sent("observation_read"),
        vec![
            json!({"kind":"observation_read","id":ID,"generation":GENERATION,
            "method":"capability.tasks.read","params":{"id":"t1"}})
        ]
    );
    fixture.lane.observation().retire();
    let refused = read().await.unwrap_err();
    assert_eq!(refused["data"]["code"], "capability_denied", "{refused}");
    assert_eq!(
        fixture.sent("observation_read").len(),
        1,
        "a retired generation reaches Core"
    );
    // A later call cannot start another generation on this child either.
    let call = fixture.call(&["tasks.read", "events.subscribe"]);
    let refused = fixture
        .answer(
            "capability.events.subscribe",
            json!({"types":["task"]}),
            json!({"capabilityCall":"call-token"}),
            Some(&call),
        )
        .await
        .unwrap_err();
    assert_eq!(message(&refused), "read owner generation changed");
}

#[tokio::test]
async fn call_sealed_under_another_generation_is_refused() {
    let fixture = Fixture::new(
        &["tasks.read", "events.subscribe"],
        Box::new(|body| events_after(body, &json!([]), CURSOR)),
    )
    .await;
    fixture
        .subscribe(&fixture.call(&["tasks.read", "events.subscribe"]))
        .await;
    let mut call = fixture.call(&["tasks.read", "events.subscribe"]);
    call.generation = Some("2".repeat(64));
    let refused = fixture
        .answer(
            "capability.tasks.read",
            json!({"id":"t1"}),
            json!({"capabilityCall":"call-token"}),
            Some(&call),
        )
        .await
        .unwrap_err();
    assert_eq!(
        message(&refused),
        "observation generation changed before request"
    );
    assert!(fixture.sent("observation_read").is_empty());
}

#[tokio::test]
async fn undeclared_or_ungranted_observations_never_reach_core() {
    let undeclared = Fixture::new(
        &["tasks.read"],
        Box::new(|body| events_after(body, &json!([]), CURSOR)),
    )
    .await;
    let refused = undeclared
        .answer(
            "capability.events.subscribe",
            json!({"types":["task"]}),
            json!({"capabilityCall":"call-token"}),
            Some(&undeclared.call(&["tasks.read", "events.subscribe"])),
        )
        .await
        .unwrap_err();
    assert_eq!(
        message(&refused),
        "plugin fx-obs did not declare events.subscribe"
    );
    assert!(undeclared.sent("observation_events").is_empty());

    let ungranted = Fixture::new(
        &["tasks.read", "events.subscribe"],
        Box::new(|body| events_after(body, &json!([]), CURSOR)),
    )
    .await;
    let call = ungranted.call(&["tasks.read"]);
    let refused = ungranted
        .answer(
            "capability.events.subscribe",
            json!({"types":["task"]}),
            json!({"capabilityCall":"call-token"}),
            Some(&call),
        )
        .await
        .unwrap_err();
    assert_eq!(refused["data"]["code"], "capability_denied", "{refused}");
    assert!(ungranted.sent("observation_events").is_empty());
    let refused = ungranted
        .answer(
            "capability.tasks.read",
            json!({"id":"t1"}),
            json!({"capabilityCall":"wrong-token"}),
            Some(&call),
        )
        .await
        .unwrap_err();
    assert_eq!(refused["data"]["code"], "capability_denied", "{refused}");
    assert!(ungranted.sent("observation_read").is_empty());
}

#[tokio::test]
async fn core_refusal_stops_the_child_without_a_failure() {
    let fixture = Fixture::new(
        &["tasks.read", "events.subscribe"],
        Box::new(|body| {
            if body["since"].is_null() {
                Ok(json!({"last": CURSOR}))
            } else {
                Err(DoorRefusal {
                    code: "capability_denied".into(),
                    message: "read owner generation changed".into(),
                })
            }
        }),
    )
    .await;
    fixture
        .subscribe(&fixture.call(&["tasks.read", "events.subscribe"]))
        .await;
    assert!(fixture.exited().await, "Core's refusal stops the child");
    assert!(fixture.sent("observation_retired").is_empty());
    assert_eq!(fixture.lane.observation().generation(), None);
}

#[tokio::test]
async fn failed_pump_is_reported_and_stops_the_child() {
    let fixture = Fixture::new(
        &["tasks.read", "events.subscribe"],
        // A batch without events is no batch.
        Box::new(|_| Ok(json!({"last": CURSOR}))),
    )
    .await;
    fixture
        .subscribe(&fixture.call(&["tasks.read", "events.subscribe"]))
        .await;
    assert!(fixture.exited().await, "a failed pump stops the child");
    assert_eq!(
        fixture.sent("observation_retired"),
        vec![
            json!({"kind":"observation_retired","id":ID,"generation":GENERATION,"reason":PUMP_FAILED})
        ]
    );
}

#[tokio::test]
async fn idle_session_answers_only_what_it_may() {
    let fixture = Fixture::new(
        &["tasks.read", "events.subscribe", "log", "config.get"],
        Box::new(|body| match body["kind"].as_str() {
            Some("log") => Ok(Value::Null),
            _ => events_after(body, &json!([]), CURSOR),
        }),
    )
    .await;
    let logged = fixture
        .answer(
            "capability.log",
            json!({"level":"info","message":"between calls"}),
            Value::Null,
            None,
        )
        .await
        .unwrap();
    assert_eq!(logged["ok"], true);
    assert_eq!(
        fixture.sent("log"),
        vec![json!({"kind":"log","id":ID,"level":"info","message":"between calls"})]
    );
    let config = fixture
        .answer("capability.config.get", json!({}), Value::Null, None)
        .await
        .unwrap();
    assert_eq!(config, json!({"config":{"types":["task"]}}));
    for (method, meta, expected) in [
        (
            "capability.config.get",
            json!({"capabilityCall":"stale-token"}),
            "capability token has no active pending request",
        ),
        (
            "capability.config.get",
            json!({"readOwner":"pro_fixture"}),
            "read owner cannot authorize this method",
        ),
        (
            "capability.tasks.read",
            Value::Null,
            "observations require an active pending call or read owner",
        ),
        (
            "capability.tasks.read",
            json!({"readOwner":"pro_fixture"}),
            "unknown or foreign read owner",
        ),
    ] {
        let refused = fixture
            .answer(method, json!({"id":"t1"}), meta, None)
            .await
            .unwrap_err();
        assert_eq!(message(&refused), expected, "{method}");
    }
    assert!(fixture.sent("observation_read").is_empty());
}
