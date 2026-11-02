#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{OrcaAttempt, OrcaAttemptSpec, OrcaPlacement, OrcaSessionOwner};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::PermissionsExt,
    time::{Duration, Instant},
};
const ID: &str = "t-20261102-175253-93d8";
fn fixture(scenario: &str) -> (std::path::PathBuf, OrcaAttempt) {
    let root = std::env::temp_dir().join(format!("pacer-orca-attempt-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let repo = root.join("repo");
    fs::create_dir(&repo).unwrap();
    let bin = root.join("bin");
    fs::create_dir(&bin).unwrap();
    let executable = bin.join("orca");
    fs::write(&executable,r##"#!/usr/bin/env python3
import sys,json,os,subprocess
args=sys.argv[1:]
home=os.environ['FIXTURE_HOME'];scenario=os.environ['SCENARIO']
with open(home+'/calls.jsonl','a') as f: f.write(json.dumps(args)+'\n')
if args[0]=='status': result={'runtime':{'state':'ready','reachable':True}}
elif args[:2]==['repo','list']: result={'repos':[{'id':'repo','path':home+'/repo'}]}
elif args[:2]==['orchestration','run-create']:
 assert '--from' in args
 result={'run':{'id':'run'}}
elif args[:2]==['orchestration','run-show']:
 assert '--id' in args
 result={'run':{'id':'run','coordinator_handle':'coordinator'}}
elif args[:2]==['worktree','show']:
 path=args[args.index('--worktree')+1].split('::',1)[-1].removeprefix('path:') if scenario=='lane' else home+'/repo'
 if not os.path.isdir(path):
  print(json.dumps({'ok':False,'error':{'code':'selector_not_found','message':'gone'}}));sys.exit(0)
 result={'worktree':{'id':'repo::'+path,'path':path,'displayName':os.path.basename(path),'isMainWorktree':path==home+'/repo','childWorktreeIds':[]}}
elif args[:2]==['worktree','create']:
 name=args[args.index('--name')+1];path=home+'/'+name
 subprocess.run(['git','-C',home+'/repo','worktree','add','--detach',path,'HEAD'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 result={'worktree':{'id':'repo::'+path,'path':path}}
elif args[:2]==['worktree','rm']:
 path=args[args.index('--worktree')+1].split('::',1)[-1]
 subprocess.run(['git','-C',home+'/repo','worktree','remove','--force',path],check=True)
 result={}
elif args[:2]==['terminal','list']: result={'terminals':[],'truncated':False}
elif args[:2]==['terminal','create']: result={'terminal':{'handle':'coordinator' if 'pacer coordinator' in args else 'agent-terminal','incarnationId':'first'}}
elif args[:2]==['terminal','wait']: result={'wait':{'satisfied':True}}
elif args[:2]==['terminal','close']: result={'close':{'handle':'foreign' if scenario=='unclosed' else 'agent-terminal','ptyKilled':True}}
elif args[:2]==['terminal','show']: result={'terminal':{'handle':'agent-terminal','incarnationId':'first','connected':True,'writable':True,'agentIdentity':'codex'}}
elif args[:2]==['orchestration','worker-start']:
 state=json.load(open(home+'/orca.json'))
 assert state['starting']['agent-terminal']['taskId']=='t-20261102-175253-93d8'
 if scenario.startswith('lost-'):
  print('{not-json');sys.exit(0)
 if scenario=='refused':
  print(json.dumps({'ok':False,'error':{'code':'task_not_startable','message':'refused'}}));sys.exit(0)
 result={'dispatchId':'dispatch-owned','state':'failed' if scenario=='failed-launch' else 'ready','failedStage':'agent_launch' if scenario=='failed-launch' else None,'lastError':'launch failed' if scenario=='failed-launch' else None}
elif args[:2]==['orchestration','reply']: result={}
elif args[:2]==['orchestration','check'] and scenario=='question-utf16': result={'messages':[{'id':'question','type':'question','subject':'question','body':'x'*999+'😀','payload':json.dumps({'dispatchId':'dispatch-owned'})}]}
elif args[:2]==['orchestration','check']: result={'messages':[{'id':'done-1','type':'worker_done','subject':('😀'+'x'*31999) if scenario=='utf16' else 'finished','body':'verified','payload':json.dumps({'dispatchId':'dispatch-owned','outcome':'succeeded','filesModified':[]})}]}
elif args[:2]==['orchestration','worker-list']:
 result={'workers':[{'dispatchId':'dispatch-owned','agentTerminalHandle':'agent-terminal','workerState':'ready'}] if scenario=='lost-found' else [],'scope':{'run':'run'}}
 if scenario!='lost-incomplete': result['page']={'hasMore':False}
elif args[:2]==['orchestration','worker-read']: result={'terminal':{'tail':['usage limit']}}
elif args[:2]==['orchestration','worker-release']: result={'dispatchId':'dispatch-owned','state':'succeeded'}
elif args[:2]==['orchestration','worker-stop']: result={'dispatchId':'dispatch-owned','state':'stopped'}
else: raise Exception(args)
if args[:2]==['orchestration','worker-start'] and os.path.exists(home+'/dispatch.json'): result['dispatchId']=json.load(open(home+'/dispatch.json'))
if args[:2]==['orchestration','worker-list'] and os.path.exists(home+'/dispatch.json'):
 for worker in result['workers']: worker['dispatchId']=json.load(open(home+'/dispatch.json'))
print(json.dumps({'ok':True,'result':result}))
"##).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    pacer_store::TaskStore::open(&root).unwrap().insert(&json!({"id":ID,"rev":1,"createdAt":1,"state":"running","executorProvider":"pacer-exec-orca","executor":"codex","attempts":[],"brief":{"repo":repo},"timeoutS":1}),1.0).unwrap();
    let spec = OrcaAttemptSpec {
        executor: "codex".into(),
        agent: "codex".into(),
        model: None,
        coordinator: "coordinator".into(),
        run: "run".into(),
        top: repo.to_str().unwrap().into(),
        base: "HEAD".into(),
        sub: String::new(),
        placement: OrcaPlacement::Existing {
            path: repo.to_str().unwrap().into(),
        },
        notes: vec![],
        prompt: "Do the task".into(),
        launch: vec!["codex".into(), "--unattended".into()],
        account_env: HashMap::new(),
    };
    let env = HashMap::from([
        ("PATH".into(), std::env::var("PATH").unwrap()),
        ("SCENARIO".into(), scenario.into()),
        ("FIXTURE_HOME".into(), root.to_str().unwrap().into()),
    ]);
    let attempt = OrcaAttempt::issue(
        &root,
        ID,
        spec,
        executable.to_str().unwrap(),
        env,
        Instant::now() + Duration::from_secs(10),
    )
    .unwrap();
    (root, attempt)
}
#[tokio::test]
async fn concrete_attempt_journals_before_start_and_checks_its_own_outcome() {
    let (root, mut attempt) = fixture("success");
    assert!(attempt.invoke("start", json!({})).await.is_err());
    for method in ["liveAnswer", "prepare", "place", "terminal"] {
        assert!(
            !attempt
                .invoke(method, json!({}))
                .await
                .unwrap_or_else(|e| panic!("{method}: {e}"))
                .is_null()
        );
    }
    assert_eq!(
        attempt.invoke("start", json!({})).await.unwrap()["dispatchId"],
        "dispatch-owned"
    );
    assert!(attempt.invoke("start", json!({})).await.is_err());
    assert_eq!(
        attempt.invoke("wait", json!({})).await.unwrap()["kind"],
        "done"
    );
    assert!(attempt.invoke("finish",json!({"code":1,"timedOut":false,"settled":true,"summary":"forged","keepAlive":false})).await.is_err());
    let result = attempt
        .invoke(
            "finish",
            json!({"code":0.0,"timedOut":false,"settled":true,"summary":"forged","keepAlive":false}),
        )
        .await
        .unwrap();
    assert_eq!(result["exec"]["stdout"], "finished\n\nverified");
    assert_eq!(
        attempt.rescue("late provider failure").await.unwrap()["outcome"],
        result
    );
    let journal: Value =
        serde_json::from_slice(&fs::read(root.join("orca.json")).unwrap()).unwrap();
    assert!(journal["workers"].as_object().unwrap().is_empty());
    assert_eq!(
        fs::metadata(root.join("orca.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    fs::remove_dir_all(root).unwrap();
}
async fn terminal(attempt: &mut OrcaAttempt) {
    for m in ["liveAnswer", "prepare", "place", "terminal"] {
        attempt.invoke(m, json!({})).await.unwrap();
    }
}
#[tokio::test]
async fn uncertain_start_adopts_only_an_exact_terminal_and_never_falls_back() {
    for scenario in ["lost-found", "lost-absent", "lost-incomplete"] {
        let (root, mut attempt) = fixture(scenario);
        terminal(&mut attempt).await;
        assert_eq!(
            attempt.invoke("start", json!({})).await.unwrap()["kind"],
            "uncertain"
        );
        assert!(attempt.invoke("start", json!({})).await.is_err());
        let found = attempt.invoke("lookup", json!({})).await.unwrap();
        if scenario == "lost-found" {
            assert_eq!(found["kind"], "found");
            assert!(attempt.invoke("unstarted", json!({})).await.is_err());
            assert_eq!(
                attempt.invoke("adopt", json!({})).await.unwrap()["dispatchId"],
                "dispatch-owned"
            );
            attempt.abort().await.unwrap();
        } else {
            assert!(attempt.invoke("adopt", json!({})).await.is_err());
            let outcome = attempt.invoke("unstarted", json!({})).await.unwrap();
            assert_eq!(outcome["backend"], "orca");
            assert!(
                outcome["report"]
                    .as_str()
                    .unwrap()
                    .contains("Direct fallback was skipped")
            );
            let journal: Value =
                serde_json::from_slice(&fs::read(root.join("orca.json")).unwrap()).unwrap();
            assert_eq!(
                journal["uncertain"].as_object().unwrap().is_empty(),
                scenario == "lost-absent"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}
#[tokio::test]
async fn definite_refusal_can_abandon_but_ambiguous_closure_retains_lease() {
    for scenario in ["refused", "unclosed"] {
        let (root, mut attempt) = fixture(scenario);
        terminal(&mut attempt).await;
        if scenario == "refused" {
            assert_eq!(
                attempt.invoke("start", json!({})).await.unwrap()["kind"],
                "refused"
            );
        }
        attempt
            .invoke("abandon", json!({"reason":"fallback"}))
            .await
            .unwrap();
        let state: Value = {
            let output=std::process::Command::new("bun").args(["-e","import {Database} from 'bun:sqlite';const db=new Database(Bun.argv.at(-1));console.log(db.query('SELECT state FROM admission').get().state);",root.join("desktop-updates/admission.sqlite").to_str().unwrap()]).output().unwrap();
            assert!(output.status.success());
            serde_json::from_slice(&output.stdout).unwrap()
        };
        assert_eq!(
            state["leases"].as_array().unwrap().is_empty(),
            scenario == "refused"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn placement_identity_matrix_refuses_foreign_repo_name_main_and_sibling_prefix() {
    use pacer_plugin_host::checked_worktree;
    let child = OrcaPlacement::NewChild {
        repo_id: "repo".into(),
        name: "owned".into(),
        base_sha: "a".repeat(40),
        parent: None,
    };
    for w in [
        json!({}),
        json!({"id":"repo::relative"}),
        json!({"id":"other::/tmp/owned"}),
        json!({"id":"repo::/tmp/other"}),
        json!({"id":"repo::/tmp/owned","path":"/foreign"}),
    ] {
        assert!(checked_worktree(&child, "/source", &w).is_err());
    }
    assert!(checked_worktree(&child, "/tmp/owned", &json!({"id":"repo::/tmp/owned"})).is_err());
    let existing = OrcaPlacement::Existing {
        path: "/source/repo/sub".into(),
    };
    assert!(
        checked_worktree(
            &existing,
            "/source/repo",
            &json!({"id":"repo::/source/repo"})
        )
        .is_ok()
    );
    assert!(
        checked_worktree(
            &existing,
            "/source/repo",
            &json!({"id":"repo::/source/rep"})
        )
        .is_err()
    );
}
#[tokio::test]
async fn expired_provider_budget_does_not_prevent_host_owned_abort_cleanup() {
    let (root, mut attempt) = fixture("success");
    terminal(&mut attempt).await;
    attempt.invoke("start", json!({})).await.unwrap();
    tokio::time::sleep(Duration::from_secs(10)).await;
    attempt.abort().await.unwrap();
    let journal: Value =
        serde_json::from_slice(&fs::read(root.join("orca.json")).unwrap()).unwrap();
    assert!(journal["workers"].as_object().unwrap().is_empty());
    fs::remove_dir_all(root).unwrap();
}

fn git_fixture(root: &std::path::Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(["-C", root.join("repo").to_str().unwrap()])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@invalid.test")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@invalid.test")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().into()
}
fn policy_fixture(root: &std::path::Path, group: bool) -> OrcaAttempt {
    use pacer_plugin_host::orca_policy::{LoginEnvironment, OrcaPolicy};
    git_fixture(root, &["init", "-q"]);
    git_fixture(
        root,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-qm",
            "base",
        ],
    );
    let mut store = pacer_store::TaskStore::open(root).unwrap();
    let task = store.read(ID).unwrap().unwrap();
    store
        .update(ID, task["rev"].as_i64().unwrap(), 1.0, |t| {
            t["brief"]["goal"] = json!("Do the task");
            t["placement"] = json!({"requested":if group{"new"}else{"current"}});
            if group {
                t["brief"]["worktreeBase"] = json!("head");
                t["group"] = json!("batch");
                t["interactionMode"] = json!("conversation");
            }
        })
        .unwrap();
    OrcaAttempt::from_policy(
        root,
        ID,
        OrcaPolicy {
            provider: json!({"id":"codex","model":"selected"}),
            execution: json!({"worktree":"child-of-current"}),
            strategy: json!({}),
            user_home: root.into(),
            login: LoginEnvironment {
                env: HashMap::from([(
                    "CODEX_HOME".into(),
                    root.join("profile").to_string_lossy().into_owned(),
                )]),
                profile_keys: vec!["CODEX_HOME".into()],
                login_shell: true,
            },
        },
        root.join("bin/orca").to_str().unwrap(),
        HashMap::from([
            ("PATH".into(), std::env::var("PATH").unwrap()),
            ("FIXTURE_HOME".into(), root.to_string_lossy().into_owned()),
            (
                "SCENARIO".into(),
                if group { "lane" } else { "policy" }.into(),
            ),
        ]),
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap()
}
#[tokio::test]
async fn native_policy_composes_coordinator_placement_prompt_launch_and_private_folder_record() {
    let (root, old) = fixture("policy");
    drop(old);
    let mut a = policy_fixture(&root, false);
    terminal(&mut a).await;
    let calls: Vec<Value> = fs::read_to_string(root.join("calls.jsonl"))
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert!(calls.iter().any(|a| a[0] == "repo" && a[1] == "list"));
    assert!(
        calls
            .iter()
            .any(|a| a[0] == "orchestration" && a[1] == "run-create")
    );
    let command = calls
        .iter()
        .find(|a| {
            a[0] == "terminal"
                && a[1] == "create"
                && a.as_array().unwrap().iter().any(|v| v == "--command")
        })
        .unwrap()
        .as_array()
        .unwrap();
    let command = command[command.iter().position(|v| v == "--command").unwrap() + 1]
        .as_str()
        .unwrap();
    assert!(command.contains("--no-daemon"));
    assert!(command.contains("selected"));
    assert!(command.contains("CODEX_HOME="));
    let folders: Value =
        serde_json::from_slice(&fs::read(root.join("state/default-account-folders.json")).unwrap())
            .unwrap();
    assert_eq!(folders["codex"], root.join("profile").to_str().unwrap());
    assert_eq!(
        fs::metadata(root.join("state/default-account-folders.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    a.invoke("abandon", json!({"reason":"fixture complete"}))
        .await
        .unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn stopped_conversation_removes_only_its_unused_lane_and_empty_group() {
    let (root, old) = fixture("lane");
    drop(old);
    let mut a = policy_fixture(&root, true);
    terminal(&mut a).await;
    a.invoke("start", json!({})).await.unwrap();
    let mut store = pacer_store::TaskStore::open(&root).unwrap();
    let task = store.read(ID).unwrap().unwrap();
    let lane = task["worktree"].as_str().unwrap().to_owned();
    store
        .update(ID, task["rev"].as_i64().unwrap(), 1.0, |t| {
            t["state"] = json!("stopped")
        })
        .unwrap();
    assert_eq!(
        a.invoke("wait", json!({})).await.unwrap()["kind"],
        "stopped"
    );
    let result = a
        .invoke(
            "finish",
            json!({"code":1,"timedOut":false,"settled":false,"keepAlive":false}),
        )
        .await
        .unwrap();
    assert!(result.get("worktree").is_none());
    assert!(!std::path::Path::new(&lane).exists());
    assert!(!root.join("pacer-group-batch").exists());
    let task = store.read(ID).unwrap().unwrap();
    assert!(task.get("worktree").is_none());
    assert_eq!(task["worktreeReleased"]["path"], lane);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn real_attempt_wire_reply_keeps_the_js_slice_low_surrogate() {
    let (root, mut a) = fixture("utf16");
    terminal(&mut a).await;
    a.invoke("start", json!({})).await.unwrap();
    let reply = a.invoke_wire("wait", json!({})).await.unwrap();
    let json = reply.to_json().unwrap();
    assert!(json.contains("\\ude00"));
    assert!(!json.contains('�'));
    assert!(reply.into_value().is_err());
    a.abort().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn stopped_lane_with_uncommitted_work_is_preserved_for_review() {
    let (root, old) = fixture("lane");
    drop(old);
    let mut a = policy_fixture(&root, true);
    terminal(&mut a).await;
    a.invoke("start", json!({})).await.unwrap();
    let mut store = pacer_store::TaskStore::open(&root).unwrap();
    let task = store.read(ID).unwrap().unwrap();
    let lane = task["worktree"].as_str().unwrap().to_owned();
    fs::write(std::path::Path::new(&lane).join("work"), "keep").unwrap();
    store
        .update(ID, task["rev"].as_i64().unwrap(), 1.0, |t| {
            t["state"] = json!("stopped")
        })
        .unwrap();
    a.invoke("wait", json!({})).await.unwrap();
    let result = a
        .invoke(
            "finish",
            json!({"code":1,"timedOut":false,"settled":false,"keepAlive":false}),
        )
        .await
        .unwrap();
    assert_eq!(result["worktree"], lane);
    assert!(std::path::Path::new(&lane).exists());
    assert!(root.join("pacer-group-batch").exists());
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn stopping_a_live_owner_also_releases_its_proven_empty_lane() {
    use pacer_plugin_host::{OrcaLiveControl, OrcaLiveOwner};
    let (root, old) = fixture("lane");
    drop(old);
    let mut a = policy_fixture(&root, true);
    terminal(&mut a).await;
    a.invoke("start", json!({})).await.unwrap();
    let mut store = pacer_store::TaskStore::open(&root).unwrap();
    let task = store.read(ID).unwrap().unwrap();
    let lane = task["worktree"].as_str().unwrap().to_owned();
    store
        .update(ID, task["rev"].as_i64().unwrap(), 1.0, |t| {
            t["state"] = json!("stopped")
        })
        .unwrap();
    let mut live = OrcaLiveOwner::issue(
        &root,
        ID,
        root.join("bin/orca").to_str().unwrap(),
        HashMap::from([
            ("PATH".into(), std::env::var("PATH").unwrap()),
            ("FIXTURE_HOME".into(), root.to_string_lossy().into_owned()),
            ("SCENARIO".into(), "lane".into()),
        ]),
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    live.release("dispatch-owned", "agent-terminal", Some("first"), "stop")
        .await
        .unwrap();
    assert!(!std::path::Path::new(&lane).exists());
    assert!(!root.join("pacer-group-batch").exists());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn question_slice_keeps_lone_surrogate_through_settlement_and_reopening() {
    let (root, mut a) = fixture("question-utf16");
    terminal(&mut a).await;
    a.invoke("start", json!({})).await.unwrap();
    let waited = a.invoke("wait", json!({})).await.unwrap();
    assert_eq!(waited["state"], "needs_input");
    a.invoke(
        "finish",
        json!({"code":1,"timedOut":false,"settled":false,"keepAlive":false}),
    )
    .await
    .unwrap();
    let mut store = pacer_store::TaskStore::open(&root).unwrap();
    let record = store.read_wire(ID).unwrap().unwrap().to_json().unwrap();
    assert!(record.contains("\\ud83d"));
    assert!(!record.contains('�'));
    let json_file = fs::read_to_string(root.join("tasks").join(format!("{ID}.json"))).unwrap();
    assert!(json_file.contains("\\ud83d"));
    let mut child=std::process::Command::new("bun").args(["-e","const x=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify([x.question.text.length,x.question.text.charCodeAt(999)]));"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
    use std::io::Write;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(record.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "[1000,55357]"
    );
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn unsupported_or_malformed_runner_is_refused_before_any_orca_effect() {
    use pacer_plugin_host::orca_policy::{LoginEnvironment, OrcaPolicy};
    for id in ["cursor", "codex##other", "claude-code#bad#other"] {
        let (root, old) = fixture("policy");
        drop(old);
        let mut a = OrcaAttempt::from_policy(
            &root,
            ID,
            OrcaPolicy {
                provider: json!({"id":id}),
                execution: json!({"worktree":"current"}),
                strategy: json!({}),
                user_home: root.clone(),
                login: LoginEnvironment::default(),
            },
            root.join("bin/orca").to_str().unwrap(),
            HashMap::from([
                ("PATH".into(), std::env::var("PATH").unwrap()),
                ("FIXTURE_HOME".into(), root.to_string_lossy().into_owned()),
                ("SCENARIO".into(), "policy".into()),
            ]),
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
        a.invoke("liveAnswer", json!({})).await.unwrap();
        let reply = a.invoke("prepare", json!({})).await.unwrap();
        assert_eq!(reply["ok"], false);
        assert_eq!(
            reply["reason"],
            format!("Orca terminal execution is not supported for provider \"{id}\"")
        );
        assert!(!root.join("calls.jsonl").exists());
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn unsafe_dispatch_ids_never_bind_or_adopt_a_worker() {
    let ids = [
        "",
        "../../orca",
        "../../tasks/victim",
        "/absolute",
        "a/b",
        "a\\b",
        "a\0b",
        "a∕b",
        "a／b",
        "a\u{2028}b",
        " dispatch",
        "dispatch\n",
    ];
    for dispatch in ids.into_iter().map(str::to_owned).chain(["a".repeat(101)]) {
        for scenario in ["success", "lost-found"] {
            let (root, mut attempt) = fixture(scenario);
            fs::write(
                root.join("dispatch.json"),
                serde_json::to_vec(&dispatch).unwrap(),
            )
            .unwrap();
            terminal(&mut attempt).await;
            let started = attempt.invoke("start", json!({})).await.unwrap();
            assert_eq!(started["kind"], "uncertain", "{dispatch:?}");
            if scenario == "lost-found" {
                attempt.invoke("lookup", json!({})).await.unwrap();
                assert!(
                    attempt.invoke("adopt", json!({})).await.is_err(),
                    "{dispatch:?}"
                );
            }
            let journal: Value =
                serde_json::from_slice(&fs::read(root.join("orca.json")).unwrap()).unwrap();
            assert_eq!(journal["workers"], json!({}));
            assert!(!root.join("orca/inbox").exists());
            fs::remove_dir_all(root).unwrap();
        }
    }
}
