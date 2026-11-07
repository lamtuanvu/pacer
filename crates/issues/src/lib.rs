//! Native `issue.import` and `issue.search` from `src/core/issue-import.ts`: read-only GitHub
//! issue reads for a registered repository through the user's own `gh` login. The GitHub
//! repository comes from the checkout's `origin` remote, never from the request, and issue
//! content is returned as capped plain text with control and bidi characters removed.
#![allow(clippy::result_large_err)]
mod gh;
mod params;
#[cfg(test)]
mod tests;
mod text;

pub use gh::gh_env;
pub use text::{clean_body, clean_line};

use gh::What;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    js_semantics::js_trim,
};
use pacer_repos::RepoRef;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::{
    sync::{Arc, LazyLock, Mutex, PoisonError},
    time::{Duration, Instant},
};

pub(crate) type IssueError = CoreError;

pub const TITLE_MAX_CHARS: usize = 300;
pub const BODY_MAX_BYTES: usize = 64 * 1024;
const LABEL_MAX_CHARS: usize = 100;
const LABELS_MAX: usize = 50;
const ISSUE_NUMBER_MAX: u64 = (1 << 31) - 1;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const REMOTE_TIMEOUT: Duration = Duration::from_secs(5);
const SEARCH_CACHE: Duration = Duration::from_secs(30);
const SEARCH_CACHE_MAX: usize = 100;

pub(crate) fn fail(code: Code, reason: &str, message: &str, hint: Option<&str>) -> CoreError {
    let mut data = Map::new();
    data.insert("reason".into(), json!(reason));
    let error = CoreError::new(code, message).data(data);
    match hint {
        Some(hint) => error.hint(hint),
        None => error,
    }
}

fn internal(error: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

/// Inputs only the TypeScript repository reader handles, as for `repo.list`.
pub fn issue_stays_forwarded(ctx: &Ctx, op: &str) -> bool {
    matches!(op, "issue.import" | "issue.search")
        && pacer_repos::registry_needs_core(&ctx.pacer_home)
}

/// `authorizeWorkOperation` for callers without a work grant (the front doors forward those).
fn authorize(ctx: &Ctx) -> Result<(), CoreError> {
    if ctx
        .env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial",
        ));
    }
    Ok(())
}

fn providers(ctx: &Ctx) -> Vec<String> {
    pacer_config::strategy::load_strategy(&ctx.pacer_home)
        .ok()
        .and_then(|s| {
            s.get("providers")?
                .as_object()
                .map(|m| m.keys().cloned().collect())
        })
        .unwrap_or_default()
}

/// `refuseExecutors`.
fn refuse_executors(ctx: &Ctx) -> Result<(), CoreError> {
    let cwd = std::env::current_dir().unwrap_or_default();
    if pacer_lifecycle::files_search::executor_session(ctx, &cwd, || providers(ctx))
        || ctx
            .env
            .get("PACER_WORK_GRANT")
            .is_some_and(|v| !v.is_empty())
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Issue import is not available to executor sessions",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GithubRepo {
    pub owner: String,
    pub name: String,
}

impl GithubRepo {
    fn full(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
    fn issue_url(&self, number: u64) -> String {
        format!(
            "https://github.com/{}/{}/issues/{number}",
            self.owner, self.name
        )
    }
}

fn registered(ctx: &Ctx, key: &str) -> Result<RepoRef, CoreError> {
    pacer_repos::list_repos_read_only(&ctx.pacer_home)
        .into_iter()
        .find(|r| r.key == key)
        .ok_or_else(|| {
            fail(
                Code::InvalidInput,
                "unknown_repo",
                &format!("\"{key}\" is not a registered repository"),
                Some("Pass the key of a repository pacer already knows (repo.list)."),
            )
        })
}

static GITHUB_KEY: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"^github\.com/([a-z0-9][a-z0-9-]{0,38})/([a-z0-9._-]{1,100})$").ok()
});

/// `githubRemote`: the GitHub repository behind the checkout's `origin` remote.
fn github_remote(repo: &RepoRef) -> Result<GithubRepo, CoreError> {
    let Some((code, stdout)) =
        pacer_repos::git_read_within(&repo.path, &["remote", "get-url", "origin"], REMOTE_TIMEOUT)
    else {
        return Err(fail(
            Code::Unavailable,
            "gh_failed",
            &format!("Cannot read the git remote of {}", repo.label),
            Some("The repository folder did not respond; check that it is reachable."),
        ));
    };
    let key = (code == 0)
        .then(|| pacer_config::host::repo_key(js_trim(&stdout)))
        .flatten();
    key.as_deref()
        .and_then(|key| GITHUB_KEY.as_ref()?.captures(key))
        .filter(|found| !matches!(&found[2], "." | ".."))
        .map(|found| GithubRepo {
            owner: found[1].to_owned(),
            name: found[2].to_owned(),
        })
        .ok_or_else(|| {
            fail(
                Code::InvalidInput,
                "not_github",
                &format!("{} has no GitHub origin remote", repo.label),
                Some("Issue import reads issues from the github.com repository named by the origin remote."),
            )
        })
}

static PLAIN_REF: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"^#?([0-9]{1,10})$").ok());
static ISSUE_PATH: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^/([^/]+)/([^/]+)/issues/([0-9]{1,10})/?$").ok());

/// `parseIssueRef` for the string forms: "#123", "123" or an issue URL in the same repository.
pub(crate) fn parse_issue_ref(value: &str, gh: &GithubRepo) -> Result<u64, CoreError> {
    let text = js_trim(value);
    let number = if let Some(found) = PLAIN_REF.as_ref().and_then(|re| re.captures(text)) {
        found[1].parse::<u64>().unwrap_or(0)
    } else {
        let url = url::Url::parse(text).map_err(|_| {
            fail(
                Code::InvalidInput,
                "issue_not_found",
                "Expected an issue number or a GitHub issue URL",
                None,
            )
        })?;
        let path = ISSUE_PATH.as_ref().and_then(|re| re.captures(url.path()));
        let host_ok = matches!(url.host_str(), Some("github.com" | "www.github.com"));
        let Some(path) = path.filter(|_| {
            url.scheme() == "https"
                && host_ok
                && url.username().is_empty()
                && url.password().is_none_or(str::is_empty)
                && url.port().is_none()
        }) else {
            return Err(fail(
                Code::InvalidInput,
                "issue_not_found",
                "Expected an issue number or a https://github.com/<owner>/<name>/issues/<n> URL",
                None,
            ));
        };
        if path[1].to_lowercase() != gh.owner || path[2].to_lowercase() != gh.name {
            return Err(fail(
                Code::InvalidInput,
                "repo_mismatch",
                &format!(
                    "That issue belongs to {}/{}, not {}",
                    &path[1],
                    &path[2],
                    gh.full()
                ),
                Some("Choose the repository the issue belongs to."),
            ));
        }
        path[3].parse::<u64>().unwrap_or(0)
    };
    if !(1..=ISSUE_NUMBER_MAX).contains(&number) {
        return Err(fail(
            Code::InvalidInput,
            "issue_not_found",
            "Issue numbers are positive integers",
            None,
        ));
    }
    Ok(number)
}

/// An issue as `ghSummary` (and `ghIssue` when `body` is read) accepts it.
struct RawIssue {
    number: u64,
    title: String,
    labels: Vec<String>,
    url: String,
    state: String,
    body: Option<String>,
}

fn raw_issue(value: &Value, with_body: bool) -> Option<RawIssue> {
    let map = value.as_object()?;
    let number = map.get("number")?.as_f64()?;
    if number.fract() != 0.0 || number <= 0.0 || number > MAX_SAFE {
        return None;
    }
    let text = |name: &str| map.get(name)?.as_str().map(str::to_owned);
    let labels = map
        .get("labels")?
        .as_array()?
        .iter()
        .map(|label| label.as_object()?.get("name")?.as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()?;
    let body = if with_body {
        match map.get("body")? {
            Value::Null => None,
            Value::String(body) => Some(body.clone()),
            _ => return None,
        }
    } else {
        None
    };
    Some(RawIssue {
        number: number as u64,
        title: text("title")?,
        labels,
        url: text("url")?,
        state: text("state")?,
        body,
    })
}

fn unexpected_shape() -> CoreError {
    fail(
        Code::Unavailable,
        "gh_failed",
        "gh returned JSON in an unexpected shape",
        None,
    )
}

/// This repository's canonical URL for the issue, or none for another repository or a pull request.
fn own_issue_url(raw: &RawIssue, gh: &GithubRepo) -> Option<String> {
    let url = gh.issue_url(raw.number);
    (raw.url.to_lowercase() == url).then_some(url)
}

fn summary(raw: &RawIssue, url: &str) -> Map<String, Value> {
    let labels: Vec<String> = raw
        .labels
        .iter()
        .take(LABELS_MAX)
        .map(|name| clean_line(name, LABEL_MAX_CHARS).0)
        .filter(|name| !name.is_empty())
        .collect();
    let state = if raw.state.to_uppercase() == "CLOSED" {
        "closed"
    } else {
        "open"
    };
    let mut out = Map::new();
    out.insert("number".into(), json!(raw.number));
    out.insert(
        "title".into(),
        json!(clean_line(&raw.title, TITLE_MAX_CHARS).0),
    );
    out.insert("labels".into(), json!(labels));
    out.insert("url".into(), json!(url));
    out.insert("state".into(), json!(state));
    out
}

async fn repository(ctx: &Ctx, key: String) -> Result<(RepoRef, GithubRepo), CoreError> {
    let ctx = ctx.clone();
    tokio::task::spawn_blocking(move || {
        let repo = registered(&ctx, &key)?;
        let gh = github_remote(&repo)?;
        Ok((repo, gh))
    })
    .await
    .map_err(internal)?
}

/// `importIssue`: read one issue of a registered repository. Writes nothing.
pub fn issue_import(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        let input = params::import(&params)?;
        refuse_executors(ctx)?;
        params::import_bounds(&input)?;
        let (repo, gh) = repository(ctx, input.repo).await?;
        let number = parse_issue_ref(&input.issue, &gh)?;
        let argv = vec![
            "issue".into(),
            "view".into(),
            number.to_string(),
            format!("--repo=github.com/{}", gh.full()),
            "--json=number,title,body,labels,url,state".into(),
        ];
        let run = gh::limited_gh(&ctx.env, argv).await?;
        let raw = raw_issue(&gh::parse(&run, What::Issue)?, true).ok_or_else(unexpected_shape)?;
        let url = (raw.number == number)
            .then(|| own_issue_url(&raw, &gh))
            .flatten()
            .ok_or_else(|| {
                fail(
                    Code::NotFound,
                    "issue_not_found",
                    &format!("#{number} is not an issue in {}", gh.full()),
                    Some("Pull requests and issues moved to another repository are not imported."),
                )
            })?;
        let (_, title_truncated) = clean_line(&raw.title, TITLE_MAX_CHARS);
        let (body, body_truncated) = clean_body(raw.body.as_deref().unwrap_or(""), BODY_MAX_BYTES);
        let mut out = Map::new();
        out.insert("repo".into(), json!(repo.key));
        out.insert("github".into(), json!(gh.full()));
        out.extend(summary(&raw, &url));
        out.insert("body".into(), json!(body));
        out.insert(
            "truncated".into(),
            json!({"title": title_truncated, "body": body_truncated}),
        );
        Ok(Value::Object(out))
    })
}

// Qualifiers that name another owner or repository. The results would be dropped anyway, but
// the search would still run against GitHub with the user's login. The leading class is the
// JavaScript `\s` set and the names fold ASCII case only, as a non-Unicode `/i` does.
static SCOPE_QUALIFIER: LazyLock<Option<Regex>> = LazyLock::new(|| {
    let space = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";
    Regex::new(&format!(
        r#"(?:^|[{space}"'(+\-])(?i-u:repo|org|user):[^{space}]"#
    ))
    .ok()
});

type SearchCell = Arc<tokio::sync::OnceCell<Result<Value, CoreError>>>;
struct CachedSearch {
    at: Instant,
    key: String,
    cell: SearchCell,
}
static SEARCH_CACHE_ENTRIES: LazyLock<Mutex<Vec<CachedSearch>>> = LazyLock::new(Mutex::default);

fn cached_search(key: String) -> SearchCell {
    let mut cache = SEARCH_CACHE_ENTRIES
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let now = Instant::now();
    cache.retain(|entry| now.duration_since(entry.at) <= SEARCH_CACHE);
    if let Some(hit) = cache.iter().find(|entry| entry.key == key) {
        return hit.cell.clone();
    }
    if cache.len() >= SEARCH_CACHE_MAX {
        cache.remove(0);
    }
    let cell = SearchCell::default();
    cache.push(CachedSearch {
        at: now,
        key,
        cell: cell.clone(),
    });
    cell
}

/// A failure is not cached, so a retry after `gh auth login` or a rate limit runs gh again.
fn forget_search(cell: &SearchCell) {
    SEARCH_CACHE_ENTRIES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .retain(|entry| !Arc::ptr_eq(&entry.cell, cell));
}

/// Forget cached searches. For tests.
pub fn clear_issue_search_cache() {
    SEARCH_CACHE_ENTRIES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clear();
}

async fn run_search(
    ctx: &Ctx,
    repo: &RepoRef,
    gh: &GithubRepo,
    query: &str,
    state: &str,
    limit: u64,
) -> Result<Value, CoreError> {
    let argv = vec![
        "issue".into(),
        "list".into(),
        format!("--repo=github.com/{}", gh.full()),
        format!("--search={query}"),
        format!("--state={state}"),
        format!("--limit={limit}"),
        "--json=number,title,labels,url,state".into(),
    ];
    let run = gh::limited_gh(&ctx.env, argv).await?;
    let raw = gh::parse(&run, What::Repo)?
        .as_array()
        .ok_or_else(unexpected_shape)?
        .iter()
        .map(|item| raw_issue(item, false))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(unexpected_shape)?;
    // Keep only this repository's issues, whatever gh returned.
    let issues: Vec<Value> = raw
        .iter()
        .filter_map(|item| Some(Value::Object(summary(item, &own_issue_url(item, gh)?))))
        .collect();
    Ok(json!({"repo": repo.key, "github": gh.full(), "issues": issues}))
}

/// `searchIssues`: search a registered repository's issues for a picker. Writes nothing.
/// Identical searches within 30 s share one gh call, also while it is still running.
pub fn issue_search(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        let input = params::search(&params)?;
        refuse_executors(ctx)?;
        params::search_bounds(&input)?;
        let (query, _) = clean_line(&input.query, 256);
        if query.is_empty() {
            return Err(fail(
                Code::InvalidInput,
                "issue_not_found",
                "The search query is empty",
                None,
            ));
        }
        if SCOPE_QUALIFIER
            .as_ref()
            .is_some_and(|re| re.is_match(&query))
        {
            return Err(CoreError::new(
                Code::InvalidInput,
                "The search query may not name another repository",
            )
            .hint("Remove repo:, org: and user: qualifiers; the search always covers the selected repository."));
        }
        let (repo, gh) = repository(ctx, input.repo).await?;
        let state = input.state.as_deref().unwrap_or("open").to_owned();
        let limit = input.limit.unwrap_or(20);
        let key = json!([
            ctx.pacer_home.to_string_lossy(),
            repo.key,
            gh.owner,
            gh.name,
            query,
            state,
            limit
        ])
        .to_string();
        let cell = cached_search(key);
        let result = cell
            .get_or_init(|| run_search(ctx, &repo, &gh, &query, &state, limit))
            .await
            .clone();
        if result.is_err() {
            forget_search(&cell);
        }
        result
    })
}

#[cfg(test)]
pub(crate) fn patterns_compile() -> bool {
    text::patterns_compile()
        && [&GITHUB_KEY, &PLAIN_REF, &ISSUE_PATH, &SCOPE_QUALIFIER]
            .iter()
            .all(|p| p.is_some())
}
