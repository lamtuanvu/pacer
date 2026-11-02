#![allow(clippy::unwrap_used)]
use super::*;
use pacer_store::TaskStore;
use serde_json::json;
const ID: &str = "t-20261101-184223-ea3b";

#[test]
fn run_exit_number_acceptance_matches_javascript() {
    const VALUES: &[&str] = &[
        "0",
        " 1.0 ",
        "1e2",
        "0x10",
        "0b11",
        "0o7",
        "",
        " ",
        "NaN",
        "Infinity",
        "1e999",
        "0x",
        "+0x10",
        "1_0",
        "\u{feff} 2 \u{feff}",
        "\u{0085}2",
    ];
    let input = serde_json::to_string(VALUES).unwrap();
    let code = format!(
        "console.log(JSON.stringify({input}.map(s => s.trim() !== '' && Number.isFinite(Number(s)))))"
    );
    let output = std::process::Command::new("bun")
        .args(["-e", &code])
        .output()
        .unwrap();
    assert!(output.status.success());
    let expected: Vec<bool> = serde_json::from_slice(&output.stdout).unwrap();
    let actual: Vec<bool> = VALUES.iter().map(|value| finite_js_number(value)).collect();
    assert_eq!(actual, expected);
}

#[test]
fn exit_receipt_trim_matches_javascript() {
    const VALUES: &[&str] = &[
        "\u{0085} 2",
        "\u{feff} 2",
        "\u{2028}2\u{2029}",
        "\u{00a0}2",
        "\u{1680}2",
        "\u{2000}2",
        "\u{2001}2",
        "\u{2002}2",
        "\u{2003}2",
        "\u{2004}2",
        "\u{2005}2",
        "\u{2006}2",
        "\u{2007}2",
        "\u{2008}2",
        "\u{2009}2",
        "\u{200a}2",
        "\u{202f}2",
        "\u{205f}2",
        "\u{3000}2",
        "\t2\n",
    ];
    let input = serde_json::to_string(VALUES).unwrap();
    let code = format!(
        "console.log(JSON.stringify({input}.map(s => {{ const t=s.trim(); return t!=='' && Number.isFinite(Number(t)); }})))"
    );
    let output = std::process::Command::new("bun")
        .args(["-e", &code])
        .output()
        .unwrap();
    assert!(output.status.success());
    let expected: Vec<bool> = serde_json::from_slice(&output.stdout).unwrap();
    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    std::fs::create_dir(&run).unwrap();
    let mut store = TaskStore::open(home.path()).unwrap();
    store.insert(&json!({"id":ID,"rev":1,"state":"running","createdAt":1000.0,"brief":{"repo":"/tmp/repo"},"attempts":[],"run":{"dir":run}}), 1000.0).unwrap();
    let ctx = Ctx::with(
        home.path().into(),
        home.path().into(),
        Default::default(),
        1000.0,
    );
    for (value, expected) in VALUES.iter().zip(expected) {
        std::fs::write(run.join("exit"), value).unwrap();
        assert_eq!(
            read_chunk(
                &TaskLogReader::open(&ctx.pacer_home).unwrap(),
                ID,
                &mut Offsets::default()
            )
            .unwrap()
            .done,
            expected,
            "{value:?}"
        );
    }
}

#[tokio::test]
async fn follows_bounded_chunks_and_emits_done_after_drain() {
    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    std::fs::create_dir(&run).unwrap();
    std::fs::write(run.join("stdout"), "first\n").unwrap();
    let mut store = TaskStore::open(home.path()).unwrap();
    store.insert(&json!({"id":ID,"rev":1,"state":"running","createdAt":1000.0,"brief":{"repo":"/tmp/repo"},"attempts":[],"run":{"dir":run}}), 1000.0).unwrap();
    let ctx = Ctx::with(
        home.path().into(),
        home.path().into(),
        Default::default(),
        1000.0,
    );
    let mut offsets = Offsets::default();
    let mut frames = VecDeque::new();
    let reader = Arc::new(Mutex::new(TaskLogReader::open(&ctx.pacer_home).unwrap()));
    let core = CoreChild::unavailable();
    assert!(
        !drain(&reader, &core, ID, &mut offsets, &mut frames, 4)
            .await
            .unwrap()
    );
    assert_eq!(
        frames.pop_front().unwrap(),
        "event: log\ndata: {\"stdout\":\"first\\n\",\"stderr\":\"\"}\n\n"
    );
    std::fs::write(run.join("stdout"), "first\nsecond\n").unwrap();
    std::fs::write(run.join("exit"), "0").unwrap();
    assert!(
        drain(&reader, &core, ID, &mut offsets, &mut frames, 4)
            .await
            .unwrap()
    );
    assert!(frames.pop_front().unwrap().contains("second\\n"));
    assert_eq!(frames.pop_front().unwrap(), "event: done\ndata: {}\n\n");
}

#[tokio::test]
async fn completed_log_drains_before_first_response_finishes() {
    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    std::fs::create_dir(&run).unwrap();
    std::fs::write(run.join("stdout"), "finished\n").unwrap();
    let mut store = TaskStore::open(home.path()).unwrap();
    store.insert(&json!({"id":ID,"rev":1,"state":"done","createdAt":1000.0,"brief":{"repo":"/tmp/repo"},"attempts":[],"run":{"dir":run}}), 1000.0).unwrap();
    let ctx = Ctx::with(
        home.path().into(),
        home.path().into(),
        Default::default(),
        1000.0,
    );
    let response = follow(ctx, ID.to_owned(), Arc::new(CoreChild::unavailable())).await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = tokio::time::timeout(
        Duration::from_millis(500),
        axum::body::to_bytes(response.into_body(), 4096),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        String::from_utf8(bytes.to_vec()).unwrap(),
        ": connected\n\nevent: log\ndata: {\"stdout\":\"finished\\n\",\"stderr\":\"\"}\n\nevent: done\ndata: {}\n\n"
    );
}
