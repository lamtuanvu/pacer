//! Byte-equality tests for the OpenCode reporting source (M3 C3), ported
//! from `plugins/agent-session/opencode-report.ts` and the golden that
//! `test/session-agent-reporting.test.ts` reproduces through
//! `agentSession.prepare`.

use pacer_bundled_agent_session::opencode_reporting_source;

/// `reporting_source_is_byte_equal_to_typescript`: compare with the golden
/// `tests/fixtures/opencode-report.golden.txt`. The golden comes from
/// `bun -e 'import {opencodeReportingSource} from "./plugins/agent-session/opencode-report"; process.stdout.write(opencodeReportingSource("ses_\"q\n", "/tmp/run dir"))'`,
/// committed in this PR.
#[test]
fn reporting_source_is_byte_equal_to_typescript() {
    let golden = include_str!("fixtures/opencode-report.golden.txt");
    assert_eq!(
        opencode_reporting_source("ses_\"q\n", "/tmp/run dir"),
        golden
    );
}

/// `reporting_source_quotes_with_json_stringify`: a session id with a double
/// quote is escaped through `serde_json::to_string`, exactly as
/// `JSON.stringify` does in the reference.
#[test]
fn reporting_source_quotes_with_json_stringify() {
    let source = opencode_reporting_source("a\"b", "/tmp/run");
    assert!(source.contains("const sessionID = \"a\\\"b\";"));
}
