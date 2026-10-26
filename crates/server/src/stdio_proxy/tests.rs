#![allow(clippy::unwrap_used)]
use super::*;
#[cfg(feature = "test-ops")]
#[test]
fn work_grant_scopes_all_native_operations_to_the_core() {
    let mut env = HashMap::new();
    let names = stdio_dispatcher(&env).names();
    assert!(names.contains(&"strategy.list"));
    assert!(names.contains(&"test.echo"));
    env.insert("PACER_WORK_GRANT".to_owned(), "test-only-grant".to_owned());
    assert!(stdio_dispatcher(&env).names().is_empty());
}
#[test]
fn only_acknowledged_v3_hello_enables_native() {
    let mut state = Negotiation::default();
    let _ = state.request(&json!({"method":"hello","id":1,"params":{"protocol":3}}));
    assert!(!state.native);
    state.response(&json!({"id":2,"result":{"protocol":"3.0.0"}}));
    assert!(!state.native);
    state.response(&json!({"id":1,"error":{"code":-32602}}));
    assert!(!state.native);
    let _ = state.request(&json!({"method":"hello","id":3}));
    state.response(&json!({"id":3,"result":{"protocol":"2.0.0"}}));
    assert!(!state.native);
    let _ = state.request(&json!({"method":"hello","id":4}));
    state.response(&json!({"id":4,"result":{"protocol":"3.0.0"}}));
    assert!(state.native);
    let _ = state.request(&json!({"method":"hello","params":{"protocol":2}}));
    assert!(!state.native);
}
#[tokio::test]
async fn unnegotiated_invalid_and_oversized_frames_are_transparent() {
    let ctx = Ctx::from_env();
    let dispatcher = Dispatcher::new("");
    let mut input = b"{\"jsonrpc\":\"2.0\",\"method\":\"test.echo\",\"id\":1}\ninvalid\n".to_vec();
    input.extend(vec![b' '; MAX_NATIVE_FRAME + 1]);
    input.push(b'\n');
    let mut core = Vec::new();
    let out = Mutex::new(Vec::new());
    forward_input(
        &input[..],
        &mut core,
        &out,
        &ctx,
        &dispatcher,
        &Mutex::new(Negotiation::default()),
    )
    .await
    .unwrap();
    assert_eq!(core, input);
    assert!(out.into_inner().is_empty());
}
#[tokio::test]
async fn surrogate_bearing_settings_keep_stdio_request_with_core() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(
        home.join("settings.json"),
        r#"{"0":"\ud83d","1":"\ude00","notifications":"important"}"#,
    )
    .unwrap();
    let ctx = Ctx::with(dir.path().to_path_buf(), home, HashMap::new(), 0.0);
    let dispatcher = Dispatcher::new("");
    let input = b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications.get\",\"id\":1,\"params\":{}}\n";
    let mut core = Vec::new();
    let out = Mutex::new(Vec::new());
    let state = Mutex::new(Negotiation {
        native: true,
        previous: true,
        pending: None,
        settled: None,
    });
    forward_input(&input[..], &mut core, &out, &ctx, &dispatcher, &state)
        .await
        .unwrap();
    assert_eq!(core, input);
    assert!(out.into_inner().is_empty());
}
#[cfg(feature = "test-ops")]
#[tokio::test]
async fn acknowledged_native_and_forward_escape() {
    for forward in ["", "*", "test.echo"] {
        let ctx = Ctx::from_env();
        let dispatcher = Dispatcher::new(forward);
        let input =
            b"{\"jsonrpc\":\"2.0\",\"method\":\"test.echo\",\"id\":1,\"params\":{\"ok\":true}}\n";
        let mut core = Vec::new();
        let out = Mutex::new(Vec::new());
        let state = Mutex::new(Negotiation {
            native: true,
            previous: true,
            pending: None,
            settled: None,
        });
        forward_input(&input[..], &mut core, &out, &ctx, &dispatcher, &state)
            .await
            .unwrap();
        if forward.is_empty() {
            assert!(core.is_empty());
            assert_eq!(
                serde_json::from_slice::<Value>(&out.into_inner()).unwrap(),
                json!({"jsonrpc":"2.0","id":1,"result":{"ok":true}})
            );
        } else {
            assert_eq!(core, input);
            assert!(out.into_inner().is_empty());
        }
    }
}
#[cfg(feature = "test-ops")]
#[tokio::test]
async fn request_aware_stdio_fallback_keeps_original_line() {
    let ctx = Ctx::from_env();
    let dispatcher = Dispatcher::new("");
    let input = b"{ \"jsonrpc\":\"2.0\", \"method\":\"test.echo\", \"id\":7, \"params\":{ \"force_core\":true, \"name\":\"caf\\u00e9\" } }\n";
    let mut core = Vec::new();
    let out = Mutex::new(Vec::new());
    let state = Mutex::new(Negotiation {
        native: true,
        previous: true,
        pending: None,
        settled: None,
    });
    forward_input(&input[..], &mut core, &out, &ctx, &dispatcher, &state)
        .await
        .unwrap();
    assert_eq!(core, input);
    assert!(out.into_inner().is_empty());
}
#[cfg(feature = "test-ops")]
#[tokio::test]
async fn delayed_hello_ack_selects_pipelined_large_native_request() {
    let ctx = Ctx::from_env();
    let dispatcher = Dispatcher::new("");
    let params = json!({"text":"x".repeat(300 * 1024)});
    let hello =
        b"{\"jsonrpc\":\"2.0\",\"method\":\"hello\",\"id\":1,\"params\":{\"protocol\":3}}\n";
    let mut input = hello.to_vec();
    input.extend(
        serde_json::to_vec(&json!({"jsonrpc":"2.0","method":"test.echo","id":2,"params":params}))
            .unwrap(),
    );
    // EOF without newline is still a complete JSON-RPC request.
    let (core_write, mut core_read) = tokio::io::duplex(4096);
    let (mut core_output, output_read) = tokio::io::duplex(4096);
    let out = Mutex::new(Vec::new());
    let state = Mutex::new(Negotiation::default());
    let fake_core = async {
        let mut line = vec![0; hello.len()];
        tokio::io::AsyncReadExt::read_exact(&mut core_read, &mut line)
            .await
            .unwrap();
        assert_eq!(line, hello);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        core_output
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocol\":\"3.0.0\"}}\n")
            .await
            .unwrap();
        let mut forwarded = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut core_read, &mut forwarded)
            .await
            .unwrap();
        assert!(
            forwarded.is_empty(),
            "pipelined native request reached the core"
        );
        core_output.shutdown().await.unwrap();
    };
    let (incoming, outgoing, ()) = tokio::join!(
        forward_input(&input[..], core_write, &out, &ctx, &dispatcher, &state),
        forward_output(BufReader::new(output_read), &out, &state, &dispatcher),
        fake_core
    );
    incoming.unwrap();
    outgoing.unwrap();
    let bytes = out.into_inner();
    let responses: Vec<Value> = bytes
        .split(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect();
    assert_eq!(responses.iter().filter(|r| r["id"] == 2).count(), 1);
    assert_eq!(
        responses.iter().find(|r| r["id"] == 2).unwrap()["result"],
        params
    );
}

#[tokio::test]
async fn native_rpc_errors_keep_codes_and_omit_object_data() {
    let dispatcher = crate::native::error_dispatcher();
    let ctx = Ctx::from_env();
    for code in [
        "unknown_op",
        "unknown_task",
        "invalid_input",
        "unknown_executor",
        "conflict",
        "not_allowed",
        "not_found",
        "too_large",
        "internal",
        "plugin_timeout",
        "plugin_unavailable",
        "plugin_refused",
        "capability_denied",
        "unknown_plugin",
    ] {
        let input = serde_json::to_vec(
            &json!({"jsonrpc":"2.0","id":1,"method":"test.error","params":code}),
        )
        .unwrap();
        let mut core = Vec::new();
        let out = Mutex::new(Vec::new());
        let state = Mutex::new(Negotiation {
            native: true,
            previous: true,
            pending: None,
            settled: None,
        });
        forward_input(&input[..], &mut core, &out, &ctx, &dispatcher, &state)
            .await
            .unwrap();
        assert!(core.is_empty());
        let response: Value = serde_json::from_slice(&out.into_inner()).unwrap();
        let number = match code {
            "unknown_op" => -32601,
            "invalid_input" => -32602,
            _ => -32000,
        };
        assert_eq!(
            response,
            json!({"jsonrpc":"2.0","id":1,"error":{"code":number,"message":"message","data":{"code":code,"hint":"retry"}}})
        );
    }
}

#[test]
fn rejected_hello_preserves_previously_acknowledged_protocol() {
    let mut state = Negotiation {
        native: true,
        previous: true,
        pending: None,
        settled: None,
    };
    let _ =
        state.request(&json!({"jsonrpc":"2.0","method":"hello","id":9,"params":{"protocol":4}}));
    state.response(&json!({"jsonrpc":"2.0","id":9,"error":{"code":-32602}}));
    assert!(state.native);
}

#[tokio::test]
async fn slow_native_does_not_block_forwarded_calls_and_eof_drains_results() {
    let dispatcher = crate::native::slow_dispatcher();
    let ctx = Ctx::from_env();
    let input=b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"test.slow\",\"params\":true}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"core.fast\"}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"test.slow\",\"params\":false}\n";
    let (core_write, core_read) = tokio::io::duplex(4096);
    let (mut core_output, output_read) = tokio::io::duplex(4096);
    let state = Mutex::new(Negotiation {
        native: true,
        previous: true,
        pending: None,
        settled: None,
    });
    let out = Mutex::new(Vec::new());
    let core = async {
        let mut core_read = BufReader::new(core_read);
        let mut line = String::new();
        core_read.read_line(&mut line).await.unwrap();
        let request: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["id"], 2);
        core_output
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"fast\"}\n")
            .await
            .unwrap();
        line.clear();
        assert_eq!(core_read.read_line(&mut line).await.unwrap(), 0);
        core_output.shutdown().await.unwrap();
    };
    let (incoming, outgoing, ()) = tokio::join!(
        forward_input(&input[..], core_write, &out, &ctx, &dispatcher, &state),
        forward_output(BufReader::new(output_read), &out, &state, &dispatcher),
        core
    );
    incoming.unwrap();
    outgoing.unwrap();
    let bytes = out.into_inner();
    let rows: Vec<Value> = bytes
        .split(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["id"], 2);
    assert_eq!(rows[0]["result"], "fast");
    assert_eq!(rows.iter().find(|r| r["id"] == 1).unwrap()["result"], true);
    assert_eq!(
        rows.iter().find(|r| r["id"] == 3).unwrap()["error"]["data"]["code"],
        "conflict"
    );
}
