#![allow(clippy::unwrap_used)]
use super::*;
use std::collections::HashMap;

const ROOT: &str = "t-20260101-000000-0001";
const CHILD: &str = "t-20260101-000000-0002";

#[derive(Default)]
struct Fake {
    requests: Vec<Value>,
    /// The delivery reply is lost, after the turn started when a home is set.
    fail: bool,
    taken: Option<std::path::PathBuf>,
}

impl Bridge for Fake {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        self.requests.push(request.clone());
        let deliver = request["kind"] == "deliver";
        if deliver && let Some(home) = &self.taken {
            // `startTurnIfIdle` marks the task; the runner claims the message later.
            TaskStore::open(home)
                .unwrap()
                .update_current(ROOT, 2.0, |t| {
                    t["pendingTurn"] = json!({"turnId": "turn-1"});
                    Ok(())
                })
                .unwrap();
        }
        let fail = deliver && self.fail;
        Box::pin(async move {
            if fail {
                return Err(unavailable());
            }
            Ok(if deliver {
                json!({"delivery": "queued"})
            } else {
                json!({"ok": true})
            })
        })
    }
}

fn home() -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().join(".pacer"),
        HashMap::new(),
        1_700_000_000.123_456,
    );
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let task = |id: &str, origin: &str, state: &str| json!({"id":id,"rev":1,"state":state,"createdAt":1,"updatedAt":1,"brief":{"goal":"g","repo":"/r"},"attempts":[],"origin":origin,"source":"cli"});
    store
        .insert(&task(ROOT, "external:local", "done"), 1.0)
        .unwrap();
    store
        .insert(&task(CHILD, &format!("task:{ROOT}"), "queued"), 1.0)
        .unwrap();
    (dir, ctx)
}

fn as_executor(ctx: &Ctx, id: &str) -> Ctx {
    let mut ctx = ctx.clone();
    ctx.env.insert("PACER_ROLE".into(), "executor".into());
    ctx.env.insert("PACER_TASK_ID".into(), id.into());
    ctx
}

async fn run(ctx: &Ctx, name: &str, params: Value, bridge: &mut Fake) -> Result<Value, CoreError> {
    call(ctx, name, params, bridge).await
}

#[test]
fn trims_like_javascript_and_finds_headless_runners() {
    assert_eq!(js_trim("\u{feff}\u{a0} hi \u{2028}\t"), "hi");
    assert_eq!(js_trim("\u{85}x"), "\u{85}x");
    let (_dir, ctx) = home();
    for (executor, headless) in [
        ("codex", true),
        ("claude-code#work", true),
        ("agy", true),
        ("codex@local", true),
        ("codex@remote", false),
        ("opencode", false),
        ("unknown", false),
        ("Codex", false),
    ] {
        assert_eq!(headless_turn(&ctx, executor), headless, "{executor}");
    }
}

#[tokio::test]
async fn send_stores_in_milliseconds_and_delivers_through_the_bridge() {
    let (_dir, ctx) = home();
    let mut bridge = Fake::default();
    let to_human = run(
        &ctx,
        "msg.send",
        json!({"to":"human","body":" hi "}),
        &mut bridge,
    )
    .await
    .unwrap();
    assert_eq!(to_human["delivery"], "pull");
    assert_eq!(to_human["duplicate"], false);
    let message = &to_human["message"];
    assert_eq!(message["body"], "hi");
    assert_eq!(message["createdAt"], json!(1_700_000_000.123));
    assert!(
        message["id"]
            .as_str()
            .unwrap()
            .starts_with("m-01700000000123-")
    );
    // A message to the human republishes its task in the Core.
    assert_eq!(
        bridge.requests,
        [json!({"kind":"notify","id":message["id"]})]
    );

    let to_root = run(
        &ctx,
        "msg.send",
        json!({"to":format!("task:{ROOT}"),"body":"go","request_id":"r"}),
        &mut bridge,
    )
    .await
    .unwrap();
    assert_eq!(to_root["delivery"], "queued");
    assert_eq!(
        bridge.requests[1],
        json!({"kind":"deliver","to":format!("task:{ROOT}")})
    );
    let again = run(
        &ctx,
        "msg.send",
        json!({"to":format!("task:{ROOT}"),"body":"go","request_id":"r"}),
        &mut bridge,
    )
    .await
    .unwrap();
    assert_eq!(again["duplicate"], true);
    assert_eq!(again["message"]["id"], to_root["message"]["id"]);
    let other = run(
        &ctx,
        "msg.send",
        json!({"to":format!("task:{ROOT}"),"body":"stop","request_id":"r"}),
        &mut bridge,
    )
    .await
    .unwrap_err();
    assert_eq!(other.code, Code::Conflict);
    assert_eq!(other.data.unwrap()["reason"], "msg_request_mismatch");

    let nudge = run(
        &ctx,
        "msg.send",
        json!({"to":"human","body":"x","kind":"nudge"}),
        &mut bridge,
    )
    .await
    .unwrap_err();
    assert_eq!(nudge.message, "Only the broker sends nudges");
    let invalid = run(
        &ctx,
        "msg.send",
        json!({"to":"x","body":"","kind":"y"}),
        &mut bridge,
    )
    .await
    .unwrap_err();
    assert!(
        invalid
            .message
            .contains("body: Too small: expected string to have >=1 characters")
    );
    assert!(invalid.message.contains("kind: Invalid option"));

    // Zod's string checks count code points, not UTF-16 units.
    for (count, fits) in [(128, true), (129, false)] {
        let sent = run(
            &ctx,
            "msg.send",
            json!({"to":"human","body":"x","request_id":"😀".repeat(count)}),
            &mut bridge,
        )
        .await;
        assert_eq!(sent.is_ok(), fits, "{count}");
    }
}

#[tokio::test]
async fn an_answer_stays_recorded_unless_its_turn_never_started() {
    for (fail, taken) in [(false, false), (true, false), (true, true)] {
        let (_dir, ctx) = home();
        let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
        let mut bridge = Fake::default();
        let question = run(
            &as_executor(&ctx, ROOT),
            "msg.send",
            json!({"to":"external:local","body":"which?","kind":"question"}),
            &mut bridge,
        )
        .await
        .unwrap();
        // The task's open question is the one the message asked, as TypeScript records it.
        store
            .update_current(ROOT, ctx.now, |t| {
                t["question"] = json!({"text":"which?","at":question["message"]["createdAt"]});
                Ok(())
            })
            .unwrap();
        bridge.fail = fail;
        bridge.taken = taken.then(|| ctx.pacer_home.clone());
        let sent = run(
            &ctx,
            "msg.send",
            json!({"to":format!("task:{ROOT}"),"body":"this","kind":"answer","reply_to":question["message"]["id"]}),
            &mut bridge,
        )
        .await;
        match &sent {
            Ok(sent) => assert_eq!(sent["delivery"], "queued"),
            Err(error) => assert_eq!(error.code, Code::Unavailable),
        }
        assert_eq!(sent.is_err(), fail);
        let task = store.read(ROOT).unwrap().unwrap();
        let kept = !fail || taken;
        assert_eq!(
            task["question"].get("answer").is_some(),
            kept,
            "{fail} {taken}"
        );
    }
}

#[tokio::test]
async fn close_is_for_the_parent_origin_or_human_and_cleans_through_the_bridge() {
    let (_dir, ctx) = home();
    let mut bridge = Fake::default();
    let child = as_executor(&ctx, CHILD);
    let refused = run(&child, "msg.close", json!({"task":ROOT}), &mut bridge)
        .await
        .unwrap_err();
    assert_eq!(refused.code, Code::NotAllowed);
    let parent = as_executor(&ctx, ROOT);
    let closed = run(&parent, "msg.close", json!({"task":CHILD}), &mut bridge)
        .await
        .unwrap();
    assert_eq!(closed, json!({"task":CHILD,"closed":true}));
    assert_eq!(bridge.requests, [json!({"kind":"clean","id":CHILD})]);
    let closed_send = run(
        &ctx,
        "msg.send",
        json!({"to":format!("task:{CHILD}"),"body":"x"}),
        &mut bridge,
    )
    .await
    .unwrap_err();
    assert_eq!(
        closed_send.message,
        format!("Task {CHILD} is closed for messages")
    );
    let confirm = run(&ctx, "msg.confirm", json!({"id":"m"}), &mut bridge)
        .await
        .unwrap_err();
    assert_eq!(confirm.message, "Only the human confirms held messages");
}

#[tokio::test]
async fn wait_returns_unread_messages_and_consumes_them() {
    let (_dir, ctx) = home();
    let mut bridge = Fake::default();
    assert!(wait_now(&ctx, &json!({})).is_none());
    let invalid = wait_now(&ctx, &json!({"timeout_s":0}))
        .unwrap()
        .unwrap_err();
    assert_eq!(
        invalid.message,
        "timeout_s: Too small: expected number to be >=1"
    );
    let parent = as_executor(&ctx, ROOT);
    run(
        &parent,
        "msg.send",
        json!({"to":"external:local","body":"done"}),
        &mut bridge,
    )
    .await
    .unwrap();
    let hit = wait_now(&ctx, &json!({})).unwrap().unwrap();
    assert_eq!(hit["participant"], "external:local");
    assert_eq!(hit["messages"][0]["status"], "read");
    let timed_out = run(&ctx, "msg.wait", json!({"timeout_s":1}), &mut bridge)
        .await
        .unwrap();
    assert_eq!(timed_out["timedOut"], true);
}
