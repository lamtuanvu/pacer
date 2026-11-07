#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;

fn home(now: f64) -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("state/jobs")).unwrap();
    let ctx = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        [("API_TOKEN".to_owned(), "s3cret".to_owned())].into(),
        now,
    );
    (dir, ctx)
}

fn put(ctx: &Ctx, id: &str, job: &Value) {
    fs::write(
        directory(ctx).join(format!("{id}.json")),
        serde_json::to_vec(job).unwrap(),
    )
    .unwrap();
}

fn job(id: &str, state: &str, started: f64, cancellable: bool) -> Value {
    json!({"id":id,"kind":"host.check","target":"h","state":state,"steps":[{"name":"a","state":"running","detail":"key s3cret for a@b.io"},{"name":"b","state":"pending"}],"startedAt":started,"pid":1,"cancellable":cancellable})
}

#[tokio::test]
async fn params_match_zod_and_registry_errors() {
    let (_dir, ctx) = home(100.0);
    let err = |r: Result<Value, CoreError>| r.err().unwrap().message;
    assert_eq!(
        err(job_get(&ctx, json!({})).await),
        "id: Invalid input: expected string, received undefined"
    );
    assert_eq!(
        err(job_get(&ctx, json!({"id": ""})).await),
        "id: Too small: expected string to have >=1 characters"
    );
    assert_eq!(
        err(job_get(&ctx, json!({"id": "../x"})).await),
        "invalid job id"
    );
    assert_eq!(
        err(job_get(&ctx, json!({"id": "nope"})).await),
        "unknown job nope"
    );
    assert_eq!(
        err(job_list(&ctx, json!({"target": 5})).await),
        "target: Invalid input: expected string, received number"
    );
}

#[tokio::test]
async fn list_prunes_settled_jobs_after_a_day_and_sorts_newest_first() {
    let (_dir, ctx) = home(100_000.0);
    put(&ctx, "a", &job("a", "passed", 10.0, false));
    put(&ctx, "b", &job("b", "running", 10.0, false));
    put(&ctx, "c", &job("c", "failed", 99_000.0, false));
    fs::write(directory(&ctx).join("bad.json"), "{").unwrap();
    let ids: Vec<_> = job_list(&ctx, Value::Null)
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|j| j["id"].clone())
        .collect();
    assert_eq!(ids, [json!("c"), json!("b")]);
    assert!(!directory(&ctx).join("a.json").exists());
    assert!(!job_stays_forwarded(&ctx, "job.list", &json!({})));
    fs::write(directory(&ctx).join("null.json"), "null").unwrap();
    assert!(job_stays_forwarded(&ctx, "job.list", &json!({})));
    assert!(job_stays_forwarded(&ctx, "job.get", &json!({"id": "bad"})));
}

#[tokio::test]
async fn cancel_settles_steps_writes_the_file_and_redacts_the_event() {
    let (_dir, ctx) = home(50.0);
    put(&ctx, "fixed", &job("fixed", "running", 10.0, false));
    let error = job_cancel(&ctx, json!({"id": "fixed"}))
        .await
        .err()
        .unwrap();
    assert_eq!(
        (error.code, error.message.as_str()),
        (Code::NotAllowed, "job is not cancellable")
    );
    put(&ctx, "j", &job("j", "running", 10.0, true));
    let out = job_cancel(&ctx, json!({"id": "j"})).await.unwrap();
    assert_eq!(out["state"], "cancelled");
    assert_eq!(out["endedAt"], json!(50));
    assert_eq!(out["steps"][0]["state"], "skipped");
    let stored: Value =
        serde_json::from_slice(&fs::read(directory(&ctx).join("j.json")).unwrap()).unwrap();
    assert_eq!(stored, out);
    let published = jobs::published(&out, &json!({"API_TOKEN": "s3cret"})).unwrap();
    assert_eq!(
        published["steps"][0]["detail"],
        "key [redacted] for [redacted]"
    );
    let again = job_cancel(&ctx, json!({"id": "j"})).await.unwrap();
    assert_eq!(again, out);
}
