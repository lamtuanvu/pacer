#![allow(clippy::unwrap_used)]
use super::*;
use std::process::Command;
#[test]
fn launch_and_limit_classification_match_the_ts_reference() {
    let mut cases = Vec::new();
    for provider in [
        "codex",
        "claude-code",
        "claude-code@box",
        "claude-code#work",
        "claude-code#work@local",
        "claude-code#work@box",
        "CLAUDE-code",
        "claude-code@box@extra",
        "claude-code\n",
        "unknown#work",
    ] {
        for code in [0, 1, 126, 127] {
            for timed in [true, false] {
                for durable in [None, Some(true), Some(false)] {
                    for text in [
                        "",
                        "usage limit",
                        "you’ve hit your pro limit",
                        "invalid option value",
                        "invalid optionX",
                        "connection refused",
                        "usage:\u{feff}codex",
                        "option x\rrequires",
                        "option x requires",
                        "é429é",
                        "ENOENT",
                        "usage:\u{0085}codex",
                    ] {
                        cases.push(json!({"provider":provider,"code":code,"timed":timed,"durable":durable,"text":text}));
                    }
                }
            }
        }
    }
    let script = "const {brokenReason}=await import('./src/exec/broken.ts');const {detectLimit}=await import('./src/exec/limits.ts');console.log(JSON.stringify(JSON.parse(await Bun.stdin.text()).map(c=>{const e={code:c.code,timedOut:c.timed,stderr:c.text,stdout:''};return [brokenReason(e,1,c.durable),detectLimit(c.provider,e)]})));";
    let result = Command::new("bun")
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .args(["-e", script])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut child = result;
    std::io::Write::write_all(
        &mut child.stdin.take().unwrap(),
        json!(cases).to_string().as_bytes(),
    )
    .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let expected: Vec<(Option<String>, bool)> = serde_json::from_slice(&result.stdout).unwrap();
    for (c, (broken, limited)) in cases.iter().zip(expected) {
        let code = c["code"].as_i64().unwrap();
        let timed = c["timed"].as_bool().unwrap();
        let text = c["text"].as_str().unwrap();
        assert_eq!(
            broken_reason(code, timed, 1.0, c["durable"].as_bool(), text),
            broken,
            "{c}"
        );
        assert_eq!(
            detect_limit(c["provider"].as_str().unwrap(), code, timed, text, ""),
            limited,
            "{c}"
        );
    }
}

#[tokio::test]
async fn dirty_untracked_symlink_and_commit_fingerprints_match_typescript() {
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
    };
    let home =
        std::env::temp_dir().join(format!("pacer-orca-fingerprint-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&home).unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    let repo = home.join("repo");
    fs::create_dir(&repo).unwrap();
    let git_command = |args: &[&str]| {
        let r = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    };
    git_command(&["init", "-q"]);
    git_command(&["config", "user.email", "fixture@invalid.test"]);
    git_command(&["config", "user.name", "Fixture"]);
    fs::write(repo.join("file"), "base\n").unwrap();
    git_command(&["add", "."]);
    git_command(&["commit", "-qm", "base"]);
    // Owned, isolated Git config for the owner map: NOSYSTEM, an owned (empty)
    // global gitconfig, and an owned XDG dir, so ordinary git (the fingerprint
    // and Orca `text` users now run under the owner map, D-1) sees only the
    // fixture's config -- never the operator's system/user config.
    std::fs::write(home.join("owner.gitconfig"), b"").unwrap();
    std::fs::set_permissions(
        home.join("owner.gitconfig"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    std::fs::create_dir(home.join("xdg")).unwrap();
    // An owned git shim the owner map selects: `selected_git` pins the first
    // git on the owner's PATH, so we place it there and have it log argv+env
    // then delegate to /usr/bin/git. This proves the fingerprint (and the
    // Orca `text` callers it shares a path with) run under the owner env
    // exactly, against the owned shim -- not the machine's git.
    let shim_dir = home.join("bin");
    std::fs::create_dir(&shim_dir).unwrap();
    let log = home.join("git.log");
    let shim = format!(
        "#!/bin/sh\nlog={0}\n{{ for a in \"$@\"; do printf '%s\\000' \"$a\"; done; printf '\\037'; /usr/bin/env -0; printf '\\036\\n'; }} >> \"$log\"\nall=\"$*\"\nexec /usr/bin/git \"$@\"\n",
        single_quote(&log.to_string_lossy())
    );
    std::fs::write(shim_dir.join("git"), shim).unwrap();
    std::fs::set_permissions(shim_dir.join("git"), std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut path = shim_dir.to_string_lossy().into_owned();
    path.push(':');
    path.push_str(&std::env::var("PATH").unwrap());
    let env: std::collections::HashMap<String, String> = HashMap::from([
        ("PATH".into(), path),
        ("HOME".into(), home.to_str().unwrap().into()),
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        (
            "GIT_CONFIG_GLOBAL".into(),
            home.join("owner.gitconfig").to_str().unwrap().into(),
        ),
        (
            "XDG_CONFIG_HOME".into(),
            home.join("xdg").to_str().unwrap().into(),
        ),
        ("PACER_FIXTURE_MARKER".into(), "owner".into()),
        ("GIT_FIXTURE_MARKER".into(), "owner".into()),
    ]);
    let owner_clean: std::collections::BTreeMap<String, String> = env
        .iter()
        .filter(|(k, _)| !matches!(k.as_ref(), "PWD" | "SHLVL" | "_" | "OLDPWD"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let git = selected_git(&home, repo.to_str().unwrap(), &env).unwrap();
    let mut prior = None;
    for stage in 0..4 {
        match stage {
            1 => {
                fs::write(repo.join("file"), "dirty\n").unwrap();
            }
            2 => {
                fs::write(repo.join("untracked"), [0, 255, 1]).unwrap();
                symlink("untracked", repo.join("link")).unwrap();
            }
            3 => {
                git_command(&["add", "."]);
                git_command(&["commit", "-qm", "changed"]);
            }
            _ => {}
        }
        let actual = repo_fingerprint(&git, repo.to_str().unwrap())
            .await
            .unwrap();
        // Every fingerprint command ran under the owner env exactly (the owner
        // map's PATH selects the owned shim, so the whole set is logged and
        // proven -- not the machine's git with the operator's environment).
        let records = shim_calls(&log);
        assert!(
            records.iter().any(|(a, _)| a.contains(&"-C".to_string())
                && a.contains(&"rev-parse".to_string())),
            "stage {stage}: fingerprint must dispatch git through the owned shim"
        );
        for (args, recs_env) in &records {
            let clean: std::collections::BTreeMap<String, String> = recs_env
                .iter()
                .filter(|(k, _)| !matches!(k.as_ref(), "PWD" | "SHLVL" | "_" | "OLDPWD"))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            assert_eq!(
                clean,
                owner_clean,
                "stage {stage}: `{}` must run under the owner env exactly",
                args.join(" ")
            );
        }
        std::fs::write(&log, b"").unwrap();
        let script = "const {repoFingerprint}=await import('./src/exec/broken.ts');console.log(JSON.stringify(await repoFingerprint({run:async argv=>{const p=Bun.spawn(argv,{stdout:'pipe',stderr:'pipe',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});const [stdout,stderr,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);return {code,stdout,stderr,timedOut:false};}},Bun.argv.at(-1))));";
        let r = Command::new("bun")
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args(["-e", script, repo.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
        assert_eq!(serde_json::from_slice::<String>(&r.stdout).unwrap(), actual);
        assert_ne!(prior.as_ref(), Some(&actual));
        prior = Some(actual);
    }
    fs::remove_dir_all(home).unwrap();
}

/// Parse the owned shim's env log into `(argv, env)` records.
fn shim_calls(
    log: &std::path::Path,
) -> Vec<(Vec<String>, std::collections::HashMap<String, String>)> {
    let raw = std::fs::read(log).unwrap_or_default();
    let mut records = Vec::new();
    for record in raw.split(|b| *b == 0x1e) {
        let record = record.strip_suffix(b"\n").unwrap_or(record);
        let sep = match record.iter().position(|b| *b == 0x1f) {
            Some(i) => i,
            None => continue,
        };
        let (argv, env) = (&record[..sep], &record[sep + 1..]);
        let args = argv
            .split(|b| *b == 0)
            .filter(|f| !f.is_empty())
            .map(|f| String::from_utf8_lossy(f).into_owned())
            .collect();
        let mut map = std::collections::HashMap::new();
        for pair in env.split(|b| *b == 0).filter(|f| !f.is_empty()) {
            if let Some(eq) = pair.iter().position(|b| *b == b'=') {
                map.insert(
                    String::from_utf8_lossy(&pair[..eq]).into_owned(),
                    String::from_utf8_lossy(&pair[eq + 1..]).into_owned(),
                );
            }
        }
        records.push((args, map));
    }
    records
}

fn single_quote(s: &str) -> String {
    s.replace('\'', "'\\''")
}
