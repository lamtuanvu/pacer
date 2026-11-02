//! Runner identity and configured-account selection for an Orca attempt.
use super::*;

/// The caller must distinguish a genuinely absent strategy from a loaded value.
/// Other loading failures remain errors at the caller; null is not absence.
#[derive(Clone, Default)]
pub enum OrcaStrategySource {
    #[default]
    Loaded,
    Missing {
        message: String,
    },
}

pub(crate) struct RunnerId<'a> {
    pub agent: &'a str,
    pub account: Option<&'a str>,
    pub host: Option<&'a str>,
}
pub(crate) fn parse_runner_id(id: &str) -> Option<RunnerId<'_>> {
    let part = |s: &str| {
        s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    let (runner, host) = id.split_once('@').map_or((id, None), |(r, h)| (r, Some(h)));
    let (agent, account) = runner
        .split_once('#')
        .map_or((runner, None), |(a, c)| (a, Some(c)));
    if !["claude-code", "codex", "cursor", "agy", "opencode"].contains(&agent)
        || !part(agent)
        || account.is_some_and(|a| !part(a))
        || host.is_some_and(|h| !part(h))
    {
        return None;
    }
    Some(RunnerId {
        agent,
        account,
        host: host.filter(|h| *h != "local"),
    })
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
pub(super) fn resolve_runner<'a>(strategy: &'a Value, id: &str) -> Option<&'a Value> {
    let runners = strategy["runners"].as_object()?;
    if let Some(runner) = runners.get(id) {
        return Some(runner);
    }
    if let Some(runner) = strategy["runnerAliases"][id]
        .as_str()
        .filter(|s| !s.is_empty())
        .and_then(|s| runners.get(s))
    {
        return Some(runner);
    }
    let parsed = parse_runner_id(id).or_else(|| {
        (strategy["accounts"][id]["kind"] == "endpoint").then_some(RunnerId {
            agent: "opencode",
            account: Some(id),
            host: None,
        })
    })?;
    let kind = match parsed.agent {
        "claude-code" => "claude",
        "opencode" => "endpoint",
        agent => agent,
    };
    let mut matches = strategy["accounts"]
        .as_object()
        .into_iter()
        .flat_map(|a| a.values())
        .filter(|a| a["kind"] == kind && !truthy(&a["home"]) && !truthy(&a["orcaAccount"]));
    let first = matches.next();
    let default = if parsed.agent != "opencode" && matches.next().is_none() {
        first.and_then(|a| a["name"].as_str())
    } else {
        None
    };
    let mut canonical = parsed.agent.to_owned();
    if let Some(account) = parsed.account.filter(|a| Some(*a) != default) {
        canonical.push('#');
        canonical.push_str(account);
    }
    if let Some(host) = parsed.host {
        canonical.push('@');
        canonical.push_str(host);
    }
    runners.get(&canonical)
}
pub(super) fn account<'a>(
    strategy: &'a Value,
    provider: &Value,
    source: &OrcaStrategySource,
) -> Result<Option<&'a Value>, BrokerError> {
    let id = provider["id"].as_str().ok_or_else(denied)?;
    if let OrcaStrategySource::Missing { message } = source {
        if provider["via"] == "opencode" || parse_runner_id(id).is_none_or(|r| r.account.is_none())
        {
            return Ok(None);
        }
        return Err(BrokerError::Effect(message.clone()));
    }
    let runner = resolve_runner(strategy, id)
        .ok_or_else(|| BrokerError::Effect(format!("runner not configured: {id}")))?;
    let name = runner["account"].as_str().ok_or_else(denied)?;
    strategy["accounts"]
        .get(name)
        .map(Some)
        .ok_or_else(|| BrokerError::Effect(format!("account not configured: {name}")))
}
#[cfg(test)]
mod tests;
