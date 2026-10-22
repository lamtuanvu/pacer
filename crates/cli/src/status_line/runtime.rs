use super::{fields, render};
use pacer_foundation::ctx::Ctx;
use serde_json::Value;
use std::{fs, time::Duration};

pub fn run(args: &[String]) -> i32 {
    let ctx = Ctx::from_env();
    let mut width = ctx
        .env
        .get("COLUMNS")
        .and_then(|n| n.parse::<f64>().ok())
        .unwrap_or(80.0);
    let mut no_color = ctx.env.contains_key("NO_COLOR");
    let mut json = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => json = true,
            "--no-color" => no_color = true,
            "--hook" => {
                if args.get(i + 1).is_some_and(|v| !v.starts_with("--")) {
                    i += 1;
                }
            }
            "--width" => {
                if let Some(value) = args.get(i + 1).filter(|v| !v.starts_with("--")) {
                    if !value.is_empty()
                        && value.bytes().all(|b| b.is_ascii_digit())
                        && let Ok(n) = value.parse::<f64>()
                        && n.is_finite()
                        && n > 0.0
                    {
                        width = n;
                    }
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    let snapshot = service_snapshot(&ctx).or_else(|| link_snapshot(&ctx));
    if json {
        println!("{}", fields(snapshot.as_ref()));
    } else {
        let width = if width.is_finite() && width > 0.0 {
            width.floor().max(1.0) as usize
        } else {
            80
        };
        println!("{}", render(snapshot.as_ref(), width, !no_color));
    }
    0
}
fn service_snapshot(ctx: &Ctx) -> Option<Value> {
    let token = fs::read_to_string(ctx.pacer_home.join("token")).ok()?;
    let token = token.trim();
    if token.is_empty() {
        return None;
    }
    let port = ctx.env.get("PACER_PORT").map_or("4317", String::as_str);
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(300)))
        .max_redirects(0)
        .proxy(None)
        .build();
    let agent = ureq::Agent::new_with_config(config);
    let mut response = agent
        .get(format!("http://127.0.0.1:{port}/v2/snapshot"))
        .header("authorization", format!("Bearer {token}"))
        .call()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = serde_json::from_str(&response.body_mut().read_to_string().ok()?).ok()?;
    let snapshot = body.get("snapshot")?;
    (fields(Some(snapshot))["online"] == true).then(|| snapshot.clone())
}
fn link_snapshot(ctx: &Ctx) -> Option<Value> {
    let snapshot: Value =
        serde_json::from_str(&fs::read_to_string(ctx.pacer_home.join("link/latest.json")).ok()?)
            .ok()?;
    let at = snapshot["at"].as_f64()?;
    (at.is_finite() && ctx.now - at <= 120.0 && fields(Some(&snapshot))["online"] == true)
        .then_some(snapshot)
}
