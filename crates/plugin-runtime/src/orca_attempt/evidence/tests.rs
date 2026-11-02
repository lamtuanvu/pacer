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
    let env = HashMap::from([
        ("PATH".into(), std::env::var("PATH").unwrap()),
        ("HOME".into(), home.to_str().unwrap().into()),
    ]);
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
