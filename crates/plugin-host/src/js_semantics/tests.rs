#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
use std::process::Command;

#[test]
fn numeric_fields_match_javascript_integer_and_safe_integer_checks() {
    // These bounds cover each numeric input admitted in fs.list/readRange and
    // the broker's bounded write, HTTP, process, host and worktree requests.
    let fields = [
        ("list.limit", 1_u64, 1000_u64),
        ("readRange.offset", 0, 9_007_199_254_740_991),
        ("readRange.length", 0, 262_144),
        ("readRange.expected.size", 0, 9_007_199_254_740_991),
        ("readRange.expected.inode", 0, 9_007_199_254_740_991),
        ("readRange.expected.device", 0, 9_007_199_254_740_991),
        ("readRange.expected.mode", 0, 9_007_199_254_740_991),
        ("write.bytes", 0, 4_194_304),
        ("write.offset", 0, 9_007_199_254_740_991),
        ("write.mode", 384, 384),
        ("http.bytes", 0, 4_194_304),
        ("http.offset", 0, 4_194_304),
        ("http.length", 0, 262_144),
        ("http.timeoutMs", 1, 120_000),
        ("process.timeoutMs", 1, 1_800_000),
        ("worktree.attempt", 1, 9_007_199_254_740_991),
        ("hosts.maxBytes", 1, 52_428_800),
        ("hosts.timeoutMs", 1, 60_000),
        ("process.outputChunk.offset", 0, 9_007_199_254_740_991),
        ("process.outputChunk.length", 0, 262_144),
    ];
    let numbers = [
        "0",
        "1",
        "1.0",
        "1e2",
        "-1",
        "1.5",
        "1001",
        "9007199254740991",
        "9007199254740992",
    ];
    let cases: Vec<_> = fields.iter().flat_map(|(name, minimum, maximum)| {
        numbers.iter().map(move |number| json!({"name":name,"minimum":minimum,"maximum":maximum,"number":number}))
    }).collect();
    let script = "const cases=JSON.parse(Bun.argv.at(-1));console.log(JSON.stringify(cases.map(c=>{const n=JSON.parse(c.number);return Number.isSafeInteger(n)&&n>=c.minimum&&n<=c.maximum})));";
    let output = Command::new("bun")
        .args(["-e", script, &json!(cases).to_string()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<bool> = serde_json::from_slice(&output.stdout).unwrap();
    for (case, bun) in cases.iter().zip(expected) {
        let number: Value = serde_json::from_str(case["number"].as_str().unwrap()).unwrap();
        let minimum = case["minimum"].as_u64().unwrap();
        let maximum = case["maximum"].as_u64().unwrap();
        let rust = safe_u64(&number).is_some_and(|n| (minimum..=maximum).contains(&n));
        assert_eq!(rust, bun, "{} {}", case["name"], case["number"]);
    }
}

#[test]
fn path_and_glob_use_utf16_and_zod_strings_use_codepoints() {
    let values = ["a", "😀", &"😀".repeat(2048), &"😀".repeat(2049)];
    let script = "const v=JSON.parse(Bun.argv.at(-1));const {z}=await import('zod');console.log(JSON.stringify(v.map(s=>[s.length,z.string().max(4096).safeParse(s).success])));";
    let output = Command::new("bun")
        .args(["-e", script, &json!(values).to_string()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<(usize, bool)> = serde_json::from_slice(&output.stdout).unwrap();
    for (value, (units, zod_accepts)) in values.iter().zip(expected) {
        assert_eq!(utf16_len(value), units);
        assert_eq!(codepoint_len(value) <= 4096, zod_accepts);
    }
}
