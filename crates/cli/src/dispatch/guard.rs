use serde_json::{json, value::RawValue};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::time::Duration;

const REASON: &str = "pacer: native subagents are blocked for this managed attempt. Request child work with `pacer dispatch child --goal ... --request-id ...`.";

pub(super) fn run(args: &[String]) -> i32 {
    let env: std::collections::HashMap<String, String> = std::env::vars().collect();
    if env.get("PACER_WORK_GRANT").is_some_and(|v| !v.is_empty())
        && !env
            .get("PACER_ENFORCEMENT_TOKEN")
            .is_some_and(|v| !v.is_empty())
    {
        eprintln!("pacer: work grants only allow scoped dispatch commands");
        return 2;
    }
    let planner = args
        .windows(2)
        .find(|pair| pair[0] == "--planner")
        .map(|pair| pair[1].as_str())
        .unwrap_or("");
    if !matches!(planner, "claude-code" | "codex" | "cursor") {
        return 0;
    }
    let stdin = read_hook_stdin();
    let is_bash = parse_js_json(&stdin).ok().is_some_and(|raw| raw.is_bash);
    if is_bash {
        if planner == "cursor" {
            println!("{{\"permission\":\"allow\"}}");
        }
        return 0;
    }
    if let Some(path) = env
        .get("PACER_CANARY_MARKER")
        .filter(|path| !path.is_empty())
    {
        write_marker(path, "native-child.denied");
    }
    if !report_denial(&env, planner)
        && let Some(path) = env
            .get("PACER_GUARD_FAILURE_MARKER")
            .filter(|path| !path.is_empty())
    {
        write_marker(path, "guard-report-failed");
    }
    let output = if planner == "cursor" {
        json!({"permission":"deny","user_message":REASON})
    } else {
        json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":REASON}})
    };
    println!("{output}");
    0
}

// JSON.parse accepts lone UTF-16 surrogates, while serde_json requires Unicode
// scalar values. The guard only observes ASCII property names and "Bash", so
// replacing surrogate escapes preserves every value relevant to its decision.
struct ParsedJson {
    is_bash: bool,
    is_null: bool,
}

fn parse_js_json(input: &str) -> Result<ParsedJson, serde_json::Error> {
    let bytes = input.as_bytes();
    let mut normalized = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let mut in_string = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string && byte == b'\\' && index + 1 < bytes.len() {
            if bytes[index + 1] == b'u' && index + 6 <= bytes.len() {
                let digits = std::str::from_utf8(&bytes[index + 2..index + 6]);
                if digits
                    .ok()
                    .and_then(|s| u16::from_str_radix(s, 16).ok())
                    .is_some_and(|n| (0xd800..=0xdfff).contains(&n))
                {
                    normalized.extend_from_slice(b"\\ufffd");
                    index += 6;
                    continue;
                }
            }
            normalized.extend_from_slice(&bytes[index..index + 2]);
            index += 2;
            continue;
        }
        if byte == b'"' {
            in_string = !in_string;
        }
        normalized.push(byte);
        index += 1;
    }
    let raw: Box<RawValue> = serde_json::from_slice(&normalized)?;
    let value = raw.get();
    let is_bash = if value.starts_with('{') {
        let fields: std::collections::HashMap<String, Box<RawValue>> = serde_json::from_str(value)?;
        fields
            .get("tool_name")
            .and_then(|v| serde_json::from_str::<String>(v.get()).ok())
            .is_some_and(|v| v == "Bash")
    } else {
        false
    };
    Ok(ParsedJson {
        is_bash,
        is_null: value == "null",
    })
}

fn read_hook_stdin() -> String {
    // Hook input may be an open pipe. Match src/install/stdin.ts's one-second
    // deadline without keeping the CLI alive for the producer to close it.
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut input = Vec::new();
        let result = std::io::stdin()
            .read_to_end(&mut input)
            .map(|_| decode_utf8(&input));
        let _ = send.send(result);
    });
    receive
        .recv_timeout(Duration::from_millis(1000))
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default()
}

// Fetch and Bun stdin.text decode as UTF-8 with replacement and discard one BOM.
fn decode_utf8(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

fn write_marker(path: &str, contents: &str) {
    use std::io::Write;
    let target = std::path::Path::new(path);
    let Some(parent) = target.parent() else {
        return;
    };
    let temp = parent.join(format!(
        ".pacer-guard-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |time| time.as_nanos())
    ));
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
    {
        if file.write_all(contents.as_bytes()).is_ok() && file.sync_all().is_ok() {
            let _ = std::fs::hard_link(&temp, target);
        }
        let _ = std::fs::remove_file(&temp);
    }
}

fn report_denial(env: &std::collections::HashMap<String, String>, planner: &str) -> bool {
    let Some(token) = env.get("PACER_ENFORCEMENT_TOKEN") else {
        return false;
    };
    if token.len() != 68
        || !token.starts_with("pet_")
        || !token[4..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return false;
    }
    let port = env.get("PACER_PORT").map_or("4317", String::as_str);
    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let Ok(mut url) = url::Url::parse(&format!(
        "http://127.0.0.1:{port}/v3/ops/dispatch.enforcement.denied"
    )) else {
        return false;
    };
    let deadline = std::time::Instant::now() + Duration::from_millis(1500);
    let mut post = true;
    let mut authorized = true;
    // Bun fetch allows 126 redirects before rejecting the 127th response.
    for redirects in 0..=126 {
        let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) else {
            return false;
        };
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(remaining))
            .max_redirects(0)
            .http_status_as_error(false)
            .proxy(None)
            .build();
        let agent = ureq::Agent::new_with_config(config);
        let result = if post {
            let mut request = agent
                .post(url.as_str())
                .header("content-type", "application/json");
            if authorized {
                request = request.header("authorization", format!("Bearer {token}"));
            }
            request.send(json!({"agent":planner}).to_string())
        } else {
            let mut request = agent.get(url.as_str());
            if authorized {
                request = request.header("authorization", format!("Bearer {token}"));
            }
            request.call()
        };
        let Ok(mut response) = result else {
            return false;
        };
        let status = response.status().as_u16();
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            let Some(location) = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
            else {
                return false;
            };
            if redirects == 126 {
                return false;
            }
            let Ok(next) = url.join(location) else {
                return false;
            };
            if !matches!(next.scheme(), "http" | "https")
                || !next.username().is_empty()
                || next.password().is_some()
            {
                return false;
            }
            if url.origin() != next.origin() {
                authorized = false;
            }
            if matches!(status, 301..=303) {
                post = false;
            }
            url = next;
            continue;
        }
        if !response.status().is_success() {
            return false;
        }
        let deflate = response
            .headers()
            .get("content-encoding")
            .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"deflate"));
        let mut bytes = Vec::new();
        let body = response.body_mut().with_config();
        let mut reader = body.reader();
        let read = if deflate {
            flate2::read::ZlibDecoder::new(reader).read_to_end(&mut bytes)
        } else {
            reader.read_to_end(&mut bytes)
        };
        return read.is_ok()
            && parse_js_json(&decode_utf8(&bytes)).is_ok_and(|value| !value.is_null);
    }
    false
}

#[cfg(test)]
mod tests;
