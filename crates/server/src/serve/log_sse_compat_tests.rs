//! Cross-runtime cases use the real TS store and HTTP handler, never a model of it.
use super::*;

async fn body(port: u16, id: &str, major: u8) -> (StatusCode, String) {
    let response = client()
        .request(request(
            port,
            &format!("/v{major}/tasks/{id}/log?follow=1"),
            Method::GET,
            true,
        ))
        .await
        .unwrap();
    let status = response.status();
    let bytes = tokio::time::timeout(Duration::from_secs(4), response.into_body().collect())
        .await
        .unwrap()
        .unwrap()
        .to_bytes();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}
fn write_raw(home: &Path, id: &str, bytes: &[u8]) {
    let dir = home.join("tasks");
    std::fs::create_dir_all(&dir).unwrap();
    let temp = dir.join("record.tmp");
    std::fs::write(&temp, bytes).unwrap();
    std::fs::rename(temp, dir.join(format!("{id}.json"))).unwrap();
}
fn raw(id: &str) -> serde_json::Value {
    json!({"id":id,"rev":2,"state":"done","createdAt":1000,"brief":{"repo":"/tmp/repo"},"attempts":[{"startedAt":1,"endedAt":2}]})
}

#[tokio::test]
async fn connected_stream_resets_stderr_when_run_disappears_and_returns() {
    for major in [2, 3] {
        let home = tempfile::tempdir().unwrap();
        let run = home.path().join("run");
        task(home.path(), &run, "running");
        std::fs::write(run.join("stderr"), "abc").unwrap();
        let (port, server) = compatibility_listener(home.path()).await;
        let response = client()
            .request(request(
                port,
                &format!("/v{major}/tasks/{ID}/log?follow=1"),
                Method::GET,
                true,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut body = response.into_body();
        async fn until(body: &mut hyper::body::Incoming, marker: &str) -> String {
            tokio::time::timeout(Duration::from_secs(4), async {
                let mut text = String::new();
                while !text.contains(marker) {
                    let frame = body.frame().await.unwrap().unwrap();
                    if let Ok(bytes) = frame.into_data() {
                        text.push_str(std::str::from_utf8(&bytes).unwrap());
                    }
                }
                text
            })
            .await
            .unwrap()
        }
        assert!(
            until(&mut body, "\"stderr\":\"abc\"")
                .await
                .contains("event: log")
        );
        let fallback = home.path().join("fallback.log");
        std::fs::write(&fallback, "between").unwrap();
        let mut store = pacer_store::TaskStore::open(home.path()).unwrap();
        store
            .update(ID, 1, 1001.0, |task| {
                task.as_object_mut().unwrap().remove("run");
                task["attempts"] = json!([{"startedAt":1,"endedAt":2,"log":fallback}]);
            })
            .unwrap();
        // This marker proves a poll observed the record without a run.
        assert!(
            until(&mut body, "between")
                .await
                .contains("\"stderr\":\"\"")
        );
        let replacement = home.path().join("replacement-run");
        std::fs::create_dir(&replacement).unwrap();
        std::fs::write(replacement.join("stderr"), "xyz").unwrap();
        store
            .update(ID, 2, 1002.0, |task| {
                task["run"] = json!({"dir":replacement})
            })
            .unwrap();
        let restored = until(&mut body, "\"stderr\":\"xyz\"").await;
        assert!(!restored.contains("event: done"));
        std::fs::write(replacement.join("exit"), "0").unwrap();
        assert!(until(&mut body, "event: done").await.contains("data: {}"));
        server.abort();
    }
}

#[tokio::test]
async fn compatibility_import_survives_separate_streams_deletion_and_older_revisions() {
    for remove in [false, true] {
        let native = tempfile::tempdir().unwrap();
        let reference = tempfile::tempdir().unwrap();
        let (port, server) = compatibility_listener(native.path()).await;
        for home in [native.path(), reference.path()] {
            write_raw(home, ID, &serde_json::to_vec(&raw(ID)).unwrap());
        }
        assert_eq!(body(port, ID, 3).await.0, StatusCode::OK);
        assert_eq!(ts_read(reference.path(), ID)["rev"], 2);
        for home in [native.path(), reference.path()] {
            if remove {
                std::fs::remove_file(home.join(format!("tasks/{ID}.json"))).unwrap();
            } else {
                let mut older = raw(ID);
                older["rev"] = json!(1);
                older["title"] = json!("older");
                write_raw(home, ID, &serde_json::to_vec(&older).unwrap());
            }
        }
        assert_eq!(body(port, ID, 3).await.0, StatusCode::OK);
        assert_eq!(ts_read(native.path(), ID), ts_read(reference.path(), ID));
        assert_eq!(ts_read(native.path(), ID)["rev"], 2);
        server.abort();
    }
}

#[tokio::test]
async fn legacy_numeric_fields_match_actual_typescript_import() {
    let native = tempfile::tempdir().unwrap();
    let reference = tempfile::tempdir().unwrap();
    let (port, server) = compatibility_listener(native.path()).await;
    let tokens = [
        "1",
        "2.0",
        "2e0",
        "1.25",
        "0",
        "-0",
        "-1",
        "9007199254740991",
        "9007199254740992",
        "9007199254740993",
        "9007199254740990.5",
        "1e308",
        "1.7976931348623157e308",
        "1e309",
        "-1e309",
        "1e-400",
        "null",
        "true",
        "\"2\"",
        "[]",
        "{}",
        "MISSING",
    ];
    let mut n = 0;
    for field in ["rev", "createdAt", "startedAt", "endedAt"] {
        for token in tokens {
            n += 1;
            let id = format!("t-20261102-101125-{n:04x}");
            let mut task = raw(&id);
            let obj = if matches!(field, "startedAt" | "endedAt") {
                task["attempts"][0].as_object_mut().unwrap()
            } else {
                task.as_object_mut().unwrap()
            };
            if token == "MISSING" {
                obj.remove(field);
            } else {
                obj.insert(field.into(), json!("NUMBER_TOKEN"));
            }
            let bytes = serde_json::to_string(&task)
                .unwrap()
                .replace("\"NUMBER_TOKEN\"", token);
            for home in [native.path(), reference.path()] {
                write_raw(home, &id, bytes.as_bytes());
            }
            let expected = ts_read(reference.path(), &id);
            let (status, text) = body(port, &id, 3).await;
            assert_eq!(
                status,
                if expected.is_null() {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::OK
                },
                "{field}={token}: {text}"
            );
            // Read SQL directly: a TS read here must not rescue a missing native import.
            let code = format!(
                "import {{Database}} from 'bun:sqlite'; const d=new Database({},{{readonly:true}}); console.log(JSON.stringify(d.query('SELECT record FROM tasks WHERE id=?').get({})))",
                serde_json::to_string(&native.path().join("state/tasks.db")).unwrap(),
                serde_json::to_string(&id).unwrap()
            );
            let output = std::process::Command::new("bun")
                .args(["-e", &code])
                .env("HOME", native.path())
                .env("PACER_HOME", native.path())
                .output()
                .unwrap();
            assert!(output.status.success());
            let row: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            let imported = row["record"]
                .as_str()
                .map(|s| serde_json::from_str::<serde_json::Value>(s).unwrap())
                .unwrap_or(serde_json::Value::Null);
            assert_eq!(imported, expected, "{field}={token}");
        }
    }
    server.abort();
}

#[tokio::test]
async fn invalid_utf8_legacy_json_imports_with_replacement_like_typescript() {
    let native = tempfile::tempdir().unwrap();
    let reference = tempfile::tempdir().unwrap();
    let mut record = raw(ID);
    record["title"] = json!("INVALID");
    let bytes = serde_json::to_string(&record)
        .unwrap()
        .replace("INVALID", "\u{0001}")
        .into_bytes()
        .into_iter()
        .map(|b| if b == 1 { 0xff } else { b })
        .collect::<Vec<_>>();
    for home in [native.path(), reference.path()] {
        write_raw(home, ID, &bytes);
    }
    let (port, server) = compatibility_listener(native.path()).await;
    assert_eq!(body(port, ID, 3).await.0, StatusCode::OK);
    assert_eq!(ts_read(native.path(), ID), ts_read(reference.path(), ID));
    assert_eq!(ts_read(native.path(), ID)["title"], "\u{fffd}");
    server.abort();
}

#[tokio::test]
async fn malformed_run_and_dir_have_typescript_prestream_errors() {
    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    std::fs::create_dir(&run).unwrap();
    let (port, server) = compatibility_listener(home.path()).await;
    for (n, value) in [
        None,
        Some(json!(null)),
        Some(json!({})),
        Some(json!(false)),
        Some(json!(0)),
        Some(json!("")),
        Some(json!(true)),
        Some(json!(1)),
        Some(json!("run")),
        Some(json!([])),
        Some(json!({"dir":null})),
        Some(json!({"dir":2})),
        Some(json!({"dir":[]})),
        Some(json!({"dir":{}})),
        Some(json!({"dir":""})),
        Some(json!({"dir":run})),
    ]
    .into_iter()
    .enumerate()
    {
        for terminal in [false, true] {
            let id = format!("t-20261102-101125-{:04x}", n * 2 + usize::from(terminal));
            let mut task = raw(&id);
            task["state"] = json!(if terminal { "done" } else { "running" });
            if let Some(value) = &value {
                task["run"] = value.clone();
            }
            write_raw(home.path(), &id, &serde_json::to_vec(&task).unwrap());
            // Compare HTTP headers only for running cases (valid streams remain open).
            let path = format!("/v3/tasks/{id}/log?follow=1");
            let native = client()
                .request(request(port, &path, Method::GET, true))
                .await
                .unwrap();
            let reference = client()
                .request(request(
                    port,
                    &path.replace("/v3/", "/v2/"),
                    Method::GET,
                    true,
                ))
                .await
                .unwrap();
            assert_eq!(
                native.status(),
                reference.status(),
                "run={value:?}, terminal={terminal}"
            );
            assert_eq!(
                native.headers().get("content-type"),
                reference.headers().get("content-type")
            );
            if native.status() != StatusCode::OK {
                let a: serde_json::Value =
                    serde_json::from_slice(&native.into_body().collect().await.unwrap().to_bytes())
                        .unwrap();
                let b: serde_json::Value = serde_json::from_slice(
                    &reference.into_body().collect().await.unwrap().to_bytes(),
                )
                .unwrap();
                assert_eq!(a, b, "run={value:?}");
            }
        }
    }
    server.abort();
}

#[tokio::test]
async fn old_sqlite_schema_migrates_before_native_follow() {
    for (archived, mtime) in [(false, false), (true, false), (false, true)] {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join("state")).unwrap();
        std::fs::create_dir(home.path().join("tasks")).unwrap();
        let code = format!(
            "import {{Database}} from 'bun:sqlite'; const d=new Database({}); d.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,rev INTEGER,state TEXT,created_at REAL,updated_at REAL,settled_at REAL,repo TEXT,record TEXT NOT NULL{}{})'); d.query('INSERT INTO tasks(id,rev,record) VALUES(?,?,?)').run({},2,{}); d.close();",
            serde_json::to_string(&home.path().join("state/tasks.db")).unwrap(),
            if archived {
                ",archived INTEGER NOT NULL DEFAULT 0"
            } else {
                ""
            },
            if mtime { ",json_mtime REAL" } else { "" },
            serde_json::to_string(ID).unwrap(),
            serde_json::to_string(&serde_json::to_string(&raw(ID)).unwrap()).unwrap()
        );
        assert!(
            std::process::Command::new("bun")
                .args(["-e", &code])
                .env("HOME", home.path())
                .env("PACER_HOME", home.path())
                .status()
                .unwrap()
                .success()
        );
        let (port, server) = compatibility_listener(home.path()).await;
        let native = body(port, ID, 3).await;
        let reference = body(port, ID, 2).await;
        assert_eq!(native, reference);
        assert_eq!(native.0, StatusCode::OK);
        server.abort();
    }
}

#[tokio::test]
async fn connected_compatibility_read_keeps_native_byte_offsets() {
    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    task(home.path(), &run, "running");
    std::fs::write(run.join("stdout"), "before🙂").unwrap();
    let (port, server) = compatibility_listener(home.path()).await;
    let response = client()
        .request(request(
            port,
            &format!("/v3/tasks/{ID}/log?follow=1"),
            Method::GET,
            true,
        ))
        .await
        .unwrap();
    let mut stream = response.into_body();
    let mut first = String::new();
    while !first.contains("before🙂") {
        let frame = stream.frame().await.unwrap().unwrap().into_data().unwrap();
        first.push_str(&String::from_utf8_lossy(&frame));
    }
    std::fs::write(run.join("stdout"), "before🙂after🦀").unwrap();
    legacy_json(home.path(), ID, json!(2), "done", &run);
    let rest = tokio::time::timeout(Duration::from_secs(4), stream.collect())
        .await
        .unwrap()
        .unwrap()
        .to_bytes();
    assert_eq!(
        rest,
        "event: log\ndata: {\"stdout\":\"after🦀\",\"stderr\":\"\"}\n\nevent: done\ndata: {}\n\n"
    );
    assert_eq!(ts_read(home.path(), ID)["rev"], 2);
    server.abort();
}

#[tokio::test]
async fn legacy_negative_mtime_and_non_numeric_mtime_column_use_ts_read_path() {
    for old_timestamp in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let run = home.path().join("run");
        task(home.path(), &run, "done");
        if old_timestamp {
            // A restored file may predate the Unix epoch; Bun reports negative mtimeMs.
            std::fs::File::open(home.path().join(format!("tasks/{ID}.json")))
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new()
                        .set_modified(std::time::UNIX_EPOCH - Duration::from_secs(1)),
                )
                .unwrap();
        } else {
            let code = format!(
                "import {{Database}} from 'bun:sqlite'; const d=new Database({}); d.query(\"UPDATE tasks SET json_mtime='legacy' WHERE id=?\").run({}); d.close();",
                serde_json::to_string(&home.path().join("state/tasks.db")).unwrap(),
                serde_json::to_string(ID).unwrap()
            );
            assert!(
                std::process::Command::new("bun")
                    .args(["-e", &code])
                    .env("HOME", home.path())
                    .env("PACER_HOME", home.path())
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let (port, server) = compatibility_listener(home.path()).await;
        let native = body(port, ID, 3).await;
        let reference = body(port, ID, 2).await;
        assert_eq!(native, reference, "old_timestamp={old_timestamp}");
        assert_eq!(native.0, StatusCode::OK);
        server.abort();
    }
}
