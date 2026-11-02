#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_server::mcp::{Backend, BackendFuture, McpServer, Mode};
use serde_json::{Value, json};

struct Echo;
impl Backend for Echo {
    fn call(&self, _name: &str, arguments: Value) -> BackendFuture<'_> {
        Box::pin(async move { Ok(arguments) })
    }
}

#[tokio::test]
async fn catalogs_and_validation_match_ts_goldens_without_a_backend() {
    let golden: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/mcp/ts-stdio-golden.json"
    ))
    .unwrap();
    for (mode, key) in [(Mode::Planner, "planner"), (Mode::Grant, "grant")] {
        let server = McpServer::new(mode, "test", Echo).unwrap();
        let list = server
            .handle(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
            .await
            .unwrap();
        assert_eq!(list["result"]["tools"], golden[key]["tools"]);
        for section in ["schemaFailures", "missingRequired"] {
            for row in golden[key][section].as_array().unwrap() {
                let reply = server.handle(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":row["name"],"arguments":row["args"]}})).await.unwrap();
                assert_eq!(
                    reply["result"], row["result"],
                    "{key}/{section}/{}",
                    row["name"]
                );
            }
        }
    }
}

#[tokio::test]
async fn validates_transforms_and_strips_before_invoking_the_backend() {
    let server = McpServer::new(Mode::Planner, "test", Echo).unwrap();
    let reply = server.handle(json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"task_request_review","arguments":{"task_id":"t","note":"\u{feff}ok\u{feff}","extra":1}}})).await.unwrap();
    assert_eq!(
        reply["result"]["structuredContent"],
        json!({"task_id":"t","note":"ok"})
    );
    let reply = server.handle(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"dispatch_preview","arguments":{"repo":"r","goal":"g"}}})).await.unwrap();
    assert_eq!(
        reply["result"]["structuredContent"],
        json!({"repo":"r","goal":"g","requirements":{},"preferences":{"models":[],"strengths":[]}})
    );
}

#[tokio::test]
async fn numbers_and_pretty_text_use_ecmascript_representation() {
    let server = McpServer::new(Mode::Planner, "test", Echo).unwrap();
    for (raw, text) in [
        ("1.0", "1"),
        ("1e2", "100"),
        ("-0.0", "0"),
        ("1e20", "100000000000000000000"),
        ("1e21", "1e+21"),
        ("1e-7", "1e-7"),
        ("9007199254740993", "9007199254740992"),
    ] {
        let request: Value = serde_json::from_str(&format!(r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"report_limit","arguments":{{"provider":"x","until":{raw}}}}}}}"#)).unwrap();
        let reply = server.handle(request).await.unwrap();
        assert_eq!(
            reply["result"]["content"][0]["text"],
            format!("{{\n \"provider\": \"x\",\n \"until\": {text}\n}}")
        );
    }
}

#[tokio::test]
async fn stdio_handles_fragmentation_concurrent_waits_parse_errors_and_eof() {
    use pacer_server::mcp::run_stdio;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    struct Slow;
    impl Backend for Slow {
        fn call(&self, _name: &str, arguments: Value) -> BackendFuture<'_> {
            Box::pin(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                Ok(arguments)
            })
        }
    }
    let (mut sender, input) = tokio::io::duplex(4096);
    let (output, receiver) = tokio::io::duplex(4096);
    let server = McpServer::new(Mode::Planner, "test", Slow).unwrap();
    let run = tokio::spawn(run_stdio(server, BufReader::new(input), output));
    let frame = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"task_status\",\"arguments\":{\"task_id\":\"😀\"}}}\n";
    let split = frame.find('😀').unwrap() + 1;
    sender.write_all(&frame.as_bytes()[..split]).await.unwrap();
    sender.write_all(&frame.as_bytes()[split..]).await.unwrap();
    sender.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\nnot-json\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n").await.unwrap();
    sender.shutdown().await.unwrap();
    let mut lines = BufReader::new(receiver).lines();
    let mut responses = Vec::new();
    while let Some(line) = lines.next_line().await.unwrap() {
        responses.push(serde_json::from_str::<Value>(&line).unwrap());
    }
    run.await.unwrap().unwrap();
    assert_eq!(responses.len(), 3);
    assert_ne!(responses[0]["id"], 1);
    assert!(
        responses
            .iter()
            .any(|r| r["id"] == 2 && r["result"] == json!({}))
    );
    assert!(responses.iter().any(|r| r["error"]["code"] == -32700));
    assert_eq!(
        responses.last().unwrap()["result"]["structuredContent"]["task_id"],
        "😀"
    );
}

#[tokio::test]
async fn invalid_requests_and_unknown_tools_never_reach_domain_handlers() {
    struct Refuse;
    impl Backend for Refuse {
        fn call(&self, _: &str, _: Value) -> BackendFuture<'_> {
            panic!("must not call backend")
        }
    }
    let server = McpServer::new(Mode::Grant, "v", Refuse).unwrap();
    assert_eq!(
        server.handle(json!([])).await.unwrap()["error"]["code"],
        -32600
    );
    assert!(
        server
            .handle(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await
            .is_none()
    );
    let unknown = server.handle(json!({"jsonrpc":"2.0","id":"x","method":"tools/call","params":{"name":"budget_status"}})).await.unwrap();
    assert_eq!(
        unknown["result"]["content"][0]["text"],
        "MCP error -32602: Tool budget_status not found"
    );
    assert_eq!(
        server
            .handle(json!({"jsonrpc":"2.0","id":3,"method":"absent"}))
            .await
            .unwrap()["error"]["code"],
        -32601
    );
}

#[test]
fn json_codec_round_trips_lone_surrogates_without_scalar_collisions() {
    use pacer_server::mcp::{from_value, parse_json, stringify_json};
    for unit in 0xd800..=0xdfff {
        let raw = format!(r#""\u{unit:04x}""#);
        assert_eq!(stringify_json(&parse_json(&raw).unwrap(), None), raw);
    }
    for text in [
        "😀",
        "\u{f0000}",
        "\u{f07ff}",
        "\u{f0800}",
        "\u{f0800}\u{f0000}",
        "\u{f0800}\"\n",
        "\u{f0801}",
        "\u{f0802}",
        "\u{f0803}",
    ] {
        let expected = Value::String(text.into()).to_string();
        assert_eq!(
            stringify_json(&parse_json(&expected).unwrap(), None),
            expected
        );
        assert_eq!(stringify_json(&from_value(json!(text)), None), expected);
    }
    assert!(parse_json(r#""\uXXXX""#).is_err());
    assert!(parse_json("\"unterminated").is_err());
}

#[tokio::test]
async fn json_codec_preserves_both_structured_content_and_nested_json_text() {
    use pacer_server::mcp::{parse_json, stringify_json};
    let server = McpServer::new(Mode::Planner, "test", Echo).unwrap();
    for text in [
        r#""\ud800""#.to_string(),
        json!("\u{f0000}\u{f0800}\u{f07ff}").to_string(),
    ] {
        let frame = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"task_status","arguments":{{"task_id":{text}}}}}}}"#
        );
        let reply = server.handle(parse_json(&frame).unwrap()).await.unwrap();
        let wire = stringify_json(&reply, None);
        let expected_inner = format!("{{\n \"task_id\": {text}\n}}");
        assert!(
            wire.contains(&format!("\"structuredContent\":{{\"task_id\":{text}}}")),
            "{wire}"
        );
        assert!(
            wire.contains(&format!("\"text\":{}", json!(expected_inner))),
            "{wire}"
        );
    }
}

#[test]
fn mcp_number_support_does_not_change_other_transport_json_parsers() {
    assert!(serde_json::from_str::<Value>(r#"{"limit":1e400}"#).is_err());
    assert!(serde_json::from_str::<Value>(r#"{"limit":-1e400}"#).is_err());
    let json = pacer_server::mcp::parse_json(r#"{"until":1e400}"#).unwrap();
    assert_eq!(
        pacer_server::mcp::stringify_json(&json, None),
        r#"{"until":null}"#
    );
}

#[test]
fn backend_codec_preserves_nonfinite_unknown_values_and_json_number_grammar() {
    use pacer_server::mcp::{js_number, parse_json, stringify_backend_json};
    for raw in ["1e400", "-1e400"] {
        let value = parse_json(raw).unwrap();
        assert!(js_number(&value).unwrap().is_infinite());
        assert_eq!(stringify_backend_json(&value), raw);
    }
    for raw in ["01", "1.", "1e", "--1", "1e+-2", "{1:2}", "{1e400:2}"] {
        assert!(parse_json(raw).is_err(), "{raw}");
    }
    let value = parse_json(r#"{"dispatch":{"x":1e400},"text":"\ud800"}"#).unwrap();
    assert_eq!(
        stringify_backend_json(&value),
        r#"{"dispatch":{"x":1e400},"text":"\ud800"}"#
    );
}

#[test]
fn finite_numbers_keep_their_ieee_bits_through_mcp_parsing_and_serialization() {
    use pacer_server::mcp::{js_number, parse_json, stringify_backend_json};
    for raw in [
        "3.6662850235276904e-53",
        "1.1098444899886019e+69",
        "2.6599639661238314e-135",
        "-3.2570694962996e-201",
    ] {
        let value = parse_json(raw).unwrap();
        assert_eq!(
            js_number(&value).unwrap().to_bits(),
            raw.parse::<f64>().unwrap().to_bits()
        );
        assert_eq!(stringify_backend_json(&value), raw);
        let nested = parse_json(&format!(r#"{{"n":[{raw}]}}"#)).unwrap();
        assert_eq!(
            stringify_backend_json(&nested),
            format!(r#"{{"n":[{raw}]}}"#)
        );
    }
}
