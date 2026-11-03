//! Shared builders for the acceptance targets. Deep inputs are built and
//! disposed iteratively so a test helper never recurses on input depth.
#![allow(dead_code, clippy::unwrap_used)]
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

/// Deepest node depth (root 0, each member or element +1) the base parser
/// accepts. Pinned by `acceptance::limit_*` against the base revision.
pub const LIMIT: usize = 128;

/// `n` nested arrays around `leaf`; `leaf` sits at node depth `n`.
pub fn arrays(n: usize, leaf: &str) -> String {
    let mut out = String::with_capacity(2 * n + leaf.len());
    out.extend(std::iter::repeat_n('[', n));
    out.push_str(leaf);
    out.extend(std::iter::repeat_n(']', n));
    out
}

/// `n` nested `{"a":…}` objects around `leaf`.
pub fn objects(n: usize, leaf: &str) -> String {
    let mut out = "{\"a\":".repeat(n);
    out.push_str(leaf);
    out.extend(std::iter::repeat_n('}', n));
    out
}

/// Alternating array/object nesting, outermost an array.
pub fn mixed(n: usize, leaf: &str) -> String {
    let mut out = String::new();
    for i in 0..n {
        out.push_str(if i % 2 == 0 { "[" } else { "{\"a\":" });
    }
    out.push_str(leaf);
    for i in (0..n).rev() {
        out.push(if i % 2 == 0 { ']' } else { '}' });
    }
    out
}

/// `n` nested arrays around `leaf`, built without recursion.
pub fn deep_value(n: usize, leaf: Value) -> Value {
    let mut value = leaf;
    for _ in 0..n {
        value = Value::Array(vec![value]);
    }
    value
}

/// `/0` repeated `n` times.
pub fn zeros(n: usize) -> String {
    "/0".repeat(n)
}

/// Drop a caller-owned Value iteratively (serde's own drop recurses).
pub fn dispose(value: Value) {
    let mut stack = vec![value];
    while let Some(mut value) = stack.pop() {
        match &mut value {
            Value::Array(items) => stack.append(items),
            Value::Object(map) => stack.extend(std::mem::take(map).into_iter().map(|(_, v)| v)),
            _ => {}
        }
    }
}

/// Bun `JSON.stringify(JSON.parse(text))`, the §2.1 canonical form. Input goes
/// through stdin so deep documents do not depend on argv limits.
pub fn js_canonical(text: &str) -> Result<String, String> {
    let mut child = Command::new("bun")
        .args([
            "-e",
            "const t=require('fs').readFileSync(0,'utf8');try{process.stdout.write(JSON.stringify(JSON.parse(t)))}catch(e){process.stderr.write(String(e));process.exit(3)}",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    if out.status.success() {
        Ok(String::from_utf8(out.stdout).unwrap())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

const CHILD: &str = "PACER_JS_JSON_ISOLATED_TEST";

/// Run `body` on a 2 MiB thread inside a re-executed copy of this test binary.
/// A stack overflow then aborts only the child, and the parent reports it as
/// an ordinary failure instead of killing the harness.
pub fn isolated(name: &str, body: fn()) {
    if std::env::var(CHILD).as_deref() == Ok(name) {
        let result = std::thread::Builder::new()
            .stack_size(2 << 20)
            .spawn(body)
            .unwrap()
            .join();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
        return;
    }
    let out = Command::new(std::env::current_exe().unwrap())
        .args([name, "--exact", "--nocapture", "--test-threads=1"])
        .env(CHILD, name)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    let tail: String = stderr
        .chars()
        .rev()
        .take(1500)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    assert!(
        out.status.success(),
        "isolated child `{name}` failed ({:?}):\n{tail}",
        out.status
    );
}
