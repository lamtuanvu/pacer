#![allow(clippy::unwrap_used)]
use super::*;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::fs::symlink;
use std::process::Command;

#[test]
fn exact_file_range_and_changed_name() {
    let root = std::env::temp_dir().join(format!("pacer-native-read-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let path = root.join("telemetry.json");
    fs::write(&path, b"abc\xff").unwrap();
    let resource = ReadResource {
        path: path.to_str().unwrap().into(),
        kind: "file".into(),
    };
    let mut reader = NativeRead::prepare(&[resource]).unwrap();
    let stat = reader
        .answer("capability.fs.stat", &json!({"path":path}))
        .unwrap();
    let expected = stat["info"].clone();
    let ranged = reader
        .answer(
            "capability.fs.readRange",
            &json!({"path":path,"offset":1,"length":3,"expected":expected}),
        )
        .unwrap();
    assert_eq!(ranged["base64"], "YmP/");
    assert!(
        reader
            .answer(
                "capability.fs.readRange",
                &json!({"path":path,"offset":0,"length":1,"expected":{"size":0}})
            )
            .is_err()
    );
    fs::rename(&path, root.join("old")).unwrap();
    symlink(root.join("old"), &path).unwrap();
    assert!(
        reader
            .answer("capability.fs.read", &json!({"path":path}))
            .is_err()
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn new_file_under_issued_root_is_readable_but_new_root_is_not() {
    let root = std::env::temp_dir().join(format!("pacer-native-read-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let path = root.join("later");
    let resource = ReadResource {
        path: path.to_str().unwrap().into(),
        kind: "file".into(),
    };
    let mut reader = NativeRead::prepare(&[resource]).unwrap();
    assert_eq!(
        reader
            .answer("capability.fs.read", &json!({"path":path}))
            .unwrap(),
        json!({"missing":true})
    );
    fs::write(&path, "created").unwrap();
    assert_eq!(
        reader
            .answer("capability.fs.read", &json!({"path":path}))
            .unwrap()["text"],
        "created"
    );
    let absent = root.join("new-root").join("later");
    let mut missing_root = NativeRead::prepare(&[ReadResource {
        path: absent.to_str().unwrap().into(),
        kind: "file".into(),
    }])
    .unwrap();
    fs::create_dir(root.join("new-root")).unwrap();
    fs::write(&absent, "new content").unwrap();
    assert_eq!(
        missing_root
            .answer("capability.fs.read", &json!({"path":absent}))
            .unwrap(),
        json!({"missing":true})
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn listing_enforces_issued_root_scope_regular_files_and_limit() {
    let home = std::env::temp_dir().join(format!("pacer-list-{}", uuid::Uuid::new_v4()));
    let root = home.join("logs");
    fs::create_dir_all(root.join("nested")).unwrap();
    fs::write(root.join("rollout-a.jsonl"), "a").unwrap();
    fs::write(root.join("nested/rollout-b.jsonl"), "b").unwrap();
    fs::write(root.join("rollout-c.jsonl"), "c").unwrap();
    fs::write(root.join("private.jsonl"), "secret").unwrap();
    symlink(
        root.join("rollout-a.jsonl"),
        root.join("rollout-link.jsonl"),
    )
    .unwrap();
    let resource = ReadResource {
        path: root.to_str().unwrap().into(),
        kind: "codex-logs".into(),
    };
    let reader = NativeRead::prepare(std::slice::from_ref(&resource)).unwrap();
    let authority = CallAuthority::new(
        crate::CallResources {
            reads: vec![resource],
            ..Default::default()
        },
        ["fs.read".into()],
        std::time::Instant::now() + std::time::Duration::from_secs(5),
    );
    let scopes = vec![
        "${HOME}/logs/**/rollout-*.jsonl".into(),
        "${HOME}/logs/rollout-*.jsonl".into(),
    ];
    let roots = ScopeRoots {
        home: Some(home.to_str().unwrap().into()),
        ..Default::default()
    };
    let listed = reader
        .list(
            &json!({"dir":root,"glob":"**/rollout-*.jsonl","limit":1}),
            &scopes,
            &roots,
            &authority,
            std::time::Instant::now() + std::time::Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(listed["files"].as_array().unwrap().len(), 1);
    assert_eq!(listed["complete"], false);
    let listed = reader
        .list(
            &json!({"dir":root,"glob":"**/rollout-*.jsonl"}),
            &scopes,
            &roots,
            &authority,
            std::time::Instant::now() + std::time::Duration::from_secs(5),
        )
        .unwrap();
    let paths: Vec<_> = listed["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths.len(), 3);
    assert!(
        paths
            .iter()
            .all(|p| p.contains("rollout-") && !p.contains("link"))
    );
    assert_eq!(listed["complete"], true);
    assert!(matches!(
        reader.list(
            &json!({"dir":root,"glob":"*"}),
            &scopes,
            &roots,
            &authority,
            std::time::Instant::now()
        ),
        Err(BrokerError::Timeout)
    ));
    fs::rename(&root, home.join("old")).unwrap();
    fs::create_dir(&root).unwrap();
    assert!(
        reader
            .list(
                &json!({"dir":root,"glob":"*"}),
                &scopes,
                &roots,
                &authority,
                std::time::Instant::now() + std::time::Duration::from_secs(5)
            )
            .is_err()
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn json_number_spellings_reach_listing_and_range_fields() {
    let root = std::env::temp_dir().join(format!("pacer-numbers-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let path = root.join("rollout-a.jsonl");
    fs::write(&path, vec![b'a'; 100]).unwrap();
    let resources = [
        ReadResource {
            path: root.to_str().unwrap().into(),
            kind: "codex-logs".into(),
        },
        ReadResource {
            path: path.to_str().unwrap().into(),
            kind: "file".into(),
        },
    ];
    let mut reader = NativeRead::prepare(&resources).unwrap();
    let authority = CallAuthority::new(
        crate::CallResources {
            reads: resources.to_vec(),
            ..Default::default()
        },
        ["fs.read".into()],
        Instant::now() + std::time::Duration::from_secs(5),
    );
    let scope = [format!("{}/rollout-*.jsonl", root.display())];
    for (number, accepted) in [
        ("1.0", true),
        ("1e2", true),
        ("1.5", false),
        ("9007199254740992", false),
    ] {
        let value: Value = serde_json::from_str(number).unwrap();
        let listed = reader.list(
            &json!({"dir":root,"glob":"rollout-*.jsonl","limit":value}),
            &scope,
            &ScopeRoots::default(),
            &authority,
            Instant::now() + std::time::Duration::from_secs(5),
        );
        assert_eq!(listed.is_ok(), accepted, "list.limit={number}");
    }
    let info = reader
        .answer("capability.fs.stat", &json!({"path":path}))
        .unwrap()["info"]
        .clone();
    let mut expected = json!({"size":info["size"],"mtimeMs":info["mtimeMs"],
        "inode":info["inode"],"device":info["device"],"mode":info["mode"]});
    for key in ["size", "inode", "device", "mode"] {
        let actual = expected[key].as_u64().unwrap();
        expected[key] = serde_json::from_str(&format!("{actual}.0")).unwrap();
        assert!(
            reader
                .answer(
                    "capability.fs.readRange",
                    &json!({"path":path,"offset":0,"length":1,"expected":expected})
                )
                .is_ok(),
            "expected.{key}"
        );
    }
    let mtime = expected["mtimeMs"].as_f64().unwrap();
    expected["mtimeMs"] = serde_json::from_str(&format!("{mtime:e}")).unwrap();
    for (offset, length, accepted) in [
        ("1.0", "1e2", true),
        ("1e2", "1.0", true),
        ("1.5", "1", false),
        ("1", "262145", false),
    ] {
        let offset: Value = serde_json::from_str(offset).unwrap();
        let length: Value = serde_json::from_str(length).unwrap();
        assert_eq!(
            reader
                .answer(
                    "capability.fs.readRange",
                    &json!({"path":path,"offset":offset,"length":length,"expected":expected})
                )
                .is_ok(),
            accepted
        );
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn listing_keeps_newest_after_more_than_one_thousand_matches() {
    let root = std::env::temp_dir().join(format!("pacer-list-many-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    for index in 0..1002 {
        fs::write(root.join(format!("rollout-{index}.jsonl")), "{}").unwrap();
    }
    std::thread::sleep(std::time::Duration::from_millis(20));
    let latest = root.join("rollout-zz-newest.jsonl");
    fs::write(&latest, "{}").unwrap();
    let resource = ReadResource {
        path: root.to_str().unwrap().into(),
        kind: "codex-logs".into(),
    };
    let reader = NativeRead::prepare(std::slice::from_ref(&resource)).unwrap();
    let authority = CallAuthority::new(
        crate::CallResources {
            reads: vec![resource],
            ..Default::default()
        },
        ["fs.read".into()],
        std::time::Instant::now() + std::time::Duration::from_secs(5),
    );
    let scopes = vec![format!("{}/**", root.display())];
    let result = reader
        .list(
            &json!({"dir":root,"glob":"**/rollout-*.jsonl","limit":15}),
            &scopes,
            &ScopeRoots::default(),
            &authority,
            std::time::Instant::now() + std::time::Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(result["files"].as_array().unwrap().len(), 15);
    assert_eq!(result["files"][0]["path"], latest.to_str().unwrap());
    assert_eq!(result["complete"], false);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn listing_skips_hidden_directories_and_prunes_nonrecursive_globs() {
    let root = std::env::temp_dir().join(format!("pacer-list-glob-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join(".hidden")).unwrap();
    fs::create_dir_all(root.join("nested")).unwrap();
    fs::write(root.join("rollout-root.jsonl"), "root").unwrap();
    fs::write(root.join(".hidden/rollout-hidden.jsonl"), "hidden").unwrap();
    fs::write(root.join("nested/rollout-nested.jsonl"), "nested").unwrap();
    let resource = ReadResource {
        path: root.to_str().unwrap().into(),
        kind: "codex-logs".into(),
    };
    let reader = NativeRead::prepare(std::slice::from_ref(&resource)).unwrap();
    let authority = CallAuthority::new(
        crate::CallResources {
            reads: vec![resource],
            ..Default::default()
        },
        ["fs.read".into()],
        std::time::Instant::now() + std::time::Duration::from_secs(5),
    );
    let scopes = vec![format!("{}/**", root.display())];
    let list = |glob| {
        reader
            .list(
                &json!({"dir":root,"glob":glob}),
                &scopes,
                &ScopeRoots::default(),
                &authority,
                std::time::Instant::now() + std::time::Duration::from_secs(5),
            )
            .unwrap()
    };
    let recursive = list("**/rollout-*.jsonl");
    assert_eq!(recursive["files"].as_array().unwrap().len(), 2);
    for (glob, expected) in [
        ("rollout-*.jsonl", 1),
        ("nested/rollout-*.jsonl", 1),
        ("*/rollout-*.jsonl", 1),
        ("missing/rollout-*.jsonl", 0),
        (".hidden/rollout-*.jsonl", 1),
    ] {
        assert_eq!(
            list(glob)["files"].as_array().unwrap().len(),
            expected,
            "{glob}"
        );
    }
    fs::set_permissions(root.join("nested"), fs::Permissions::from_mode(0o000)).unwrap();
    let flat = list("rollout-*.jsonl");
    assert_eq!(flat["files"].as_array().unwrap().len(), 1);
    fs::set_permissions(root.join("nested"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn directory_descriptor_does_not_follow_a_swapped_descendant() {
    let home = std::env::temp_dir().join(format!("pacer-list-swap-{}", uuid::Uuid::new_v4()));
    let root = home.join("root");
    let outside = home.join("outside");
    fs::create_dir_all(root.join("nested")).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(root.join("nested/rollout-safe.jsonl"), "safe").unwrap();
    fs::write(outside.join("rollout-secret.jsonl"), "secret").unwrap();
    let root_fd = open_directory(&root).unwrap();
    let mut child_fd = Dir::openat(&root_fd, "nested", directory_flags(), Mode::empty()).unwrap();
    fs::rename(root.join("nested"), root.join("saved")).unwrap();
    symlink(&outside, root.join("nested")).unwrap();
    let names: Vec<_> = child_fd
        .iter()
        .map(|entry| entry.unwrap().file_name().to_owned())
        .filter(|name| name.as_bytes() != b"." && name.as_bytes() != b"..")
        .collect();
    assert_eq!(
        names,
        vec![std::ffi::CString::new("rollout-safe.jsonl").unwrap()]
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn listing_brace_alternatives_include_both_descendants() {
    let home = std::env::temp_dir().join(format!("pacer-braces-{}", uuid::Uuid::new_v4()));
    let root = home.join("logs");
    fs::create_dir_all(root.join("a")).unwrap();
    fs::create_dir(root.join("b")).unwrap();
    fs::write(root.join("a/rollout-a.jsonl"), "a").unwrap();
    fs::write(root.join("b/rollout-b.jsonl"), "b").unwrap();
    let resource = ReadResource {
        path: root.to_str().unwrap().into(),
        kind: "codex-logs".into(),
    };
    let reader = NativeRead::prepare(std::slice::from_ref(&resource)).unwrap();
    let authority = CallAuthority::new(
        crate::CallResources {
            reads: vec![resource],
            ..Default::default()
        },
        ["fs.read".into()],
        Instant::now() + std::time::Duration::from_secs(5),
    );
    let listed = reader
        .list(
            &json!({"dir":root,"glob":"{a,b}/rollout-*.jsonl"}),
            &[format!("{}/**", root.display())],
            &ScopeRoots::default(),
            &authority,
            Instant::now() + std::time::Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(listed["files"].as_array().unwrap().len(), 2);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn listing_brace_expansion_does_not_reveal_hidden_directory() {
    let home = std::env::temp_dir().join(format!("pacer-brace-hidden-{}", uuid::Uuid::new_v4()));
    let root = home.join("logs");
    fs::create_dir_all(root.join(".hidden")).unwrap();
    fs::create_dir(root.join("x")).unwrap();
    fs::write(root.join(".hidden/rollout-a.jsonl"), "hidden").unwrap();
    fs::write(root.join("x/rollout-b.jsonl"), "visible").unwrap();
    let resource = ReadResource {
        path: root.to_str().unwrap().into(),
        kind: "codex-logs".into(),
    };
    let reader = NativeRead::prepare(std::slice::from_ref(&resource)).unwrap();
    let authority = CallAuthority::new(
        crate::CallResources {
            reads: vec![resource],
            ..Default::default()
        },
        ["fs.read".into()],
        Instant::now() + std::time::Duration::from_secs(5),
    );
    let listed = reader
        .list(
            &json!({"dir":root,"glob":"{.hidden,x}/rollout-*.jsonl"}),
            &[format!("{}/**", root.display())],
            &ScopeRoots::default(),
            &authority,
            Instant::now() + std::time::Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(
        listed["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["path"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![root.join("x/rollout-b.jsonl").to_str().unwrap()]
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn structured_glob_corpus_matches_bun() {
    let directory_patterns = [
        "a",
        "a**",
        "{a,b}",
        "{a,{b,c}}",
        "[ab]",
        "**",
        "a/**",
        "{a,b}/**",
        "**/**",
        "a/**/x",
    ];
    let file_patterns = [
        "rollout-*.jsonl",
        "rollout-\\*.jsonl",
        "rollout-?.jsonl",
        "rollout-[ab].jsonl",
        "rollout-[^a].jsonl",
        "rollout-[!a].jsonl",
        "rollout-{a,b}.jsonl",
    ];
    let directories = ["a", "b", "c", "a/x", "b/y", "c/z", "a/x/y"];
    let files = [
        "rollout-a.jsonl",
        "rollout-b.jsonl",
        "rollout-long.jsonl",
        "private.jsonl",
    ];
    let patterns: Vec<_> = directory_patterns
        .iter()
        .flat_map(|dir| {
            file_patterns
                .iter()
                .map(move |file| format!("{dir}/{file}"))
        })
        .collect();
    let mut paths: Vec<_> = directories
        .iter()
        .flat_map(|dir| files.iter().map(move |file| format!("{dir}/{file}")))
        .collect();
    paths.extend(files.iter().map(|file| (*file).to_owned()));
    let corpus = json!({"patterns":patterns,"paths":paths});
    let script = "const {patterns,paths}=JSON.parse(Bun.argv.at(-1)); console.log(JSON.stringify(patterns.map(p=>paths.map(x=>new Bun.Glob(p).match(x)))));";
    let output = Command::new("bun")
        .args(["-e", script, &corpus.to_string()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<Vec<bool>> = serde_json::from_slice(&output.stdout).unwrap();
    for (pattern, row) in patterns.iter().zip(expected) {
        let alternatives =
            expand_braces(pattern, Instant::now() + std::time::Duration::from_secs(5)).unwrap();
        for (path, bun_match) in paths.iter().zip(row) {
            let rust_match = alternatives
                .iter()
                .any(|alt| matches_visible(alt, Path::new(path)));
            assert_eq!(rust_match, bun_match, "pattern={pattern:?} path={path:?}");
        }
    }
}

#[test]
fn structured_scan_corpus_matches_bun_listing() {
    let home = std::env::temp_dir().join(format!("pacer-scan-corpus-{}", uuid::Uuid::new_v4()));
    let root = home.join("logs");
    for dir in ["a", "b", "x", ".hidden", "a/.hidden"] {
        fs::create_dir_all(root.join(dir)).unwrap();
        for name in ["rollout-a.jsonl", "rollout-b.jsonl", "rollout-c.jsonl"] {
            fs::write(root.join(dir).join(name), name).unwrap();
        }
    }
    fs::create_dir(root.join("aa")).unwrap();
    fs::write(root.join("aa/rollout-a.jsonl"), "a").unwrap();
    fs::write(root.join("a/rollout-*.jsonl"), "star").unwrap();
    for name in ["rollout-a.jsonl", "rollout-b.jsonl", "rollout-c.jsonl"] {
        fs::write(root.join(name), name).unwrap();
    }
    let directory_patterns = [
        "",
        "a/",
        "a//",
        "a**/",
        "{a,b}/",
        "**/",
        ".hidden/",
        "{.hidden,x}/",
        "a/{.hidden,x}/",
        "{a/.hidden,b}/",
        "a/.hidden/",
        "{a,.hidden}/",
        "**/.hidden/",
    ];
    let file_patterns = [
        "rollout-*.jsonl",
        "rollout-\\*.jsonl",
        "rollout-[ab].jsonl",
        "rollout-[^a].jsonl",
        "rollout-[!a].jsonl",
        "rollout-[^ab].jsonl",
    ];
    let mut patterns: Vec<_> = directory_patterns
        .iter()
        .flat_map(|dir| file_patterns.iter().map(move |file| format!("{dir}{file}")))
        .collect();
    // A fixed seed explores grammar combinations while keeping failures reproducible.
    let mut seed = 0x5ca1_2026_u64;
    for _ in 0..32 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let dir = directory_patterns[(seed as usize) % directory_patterns.len()];
        let file = file_patterns[((seed >> 16) as usize) % file_patterns.len()];
        patterns.push(format!("{dir}{file}"));
    }
    let corpus = json!({"cwd":root,"patterns":patterns});
    let script = "const {cwd,patterns}=JSON.parse(Bun.argv.at(-1)); console.log(JSON.stringify(patterns.map(p=>[...new Bun.Glob(p).scanSync({cwd,onlyFiles:true,followSymlinks:false})].sort())));";
    let output = Command::new("bun")
        .args(["-e", script, &corpus.to_string()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<Vec<String>> = serde_json::from_slice(&output.stdout).unwrap();
    let resource = ReadResource {
        path: root.to_str().unwrap().into(),
        kind: "codex-logs".into(),
    };
    let reader = NativeRead::prepare(std::slice::from_ref(&resource)).unwrap();
    let authority = CallAuthority::new(
        crate::CallResources {
            reads: vec![resource],
            ..Default::default()
        },
        ["fs.read".into()],
        Instant::now() + std::time::Duration::from_secs(30),
    );
    for (pattern, bun_paths) in patterns.iter().zip(expected) {
        let result = reader
            .list(
                &json!({"dir":root,"glob":pattern}),
                &[format!("{}/**", root.display())],
                &ScopeRoots::default(),
                &authority,
                Instant::now() + std::time::Duration::from_secs(5),
            )
            .unwrap();
        let mut rust_paths: Vec<_> = result["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                Path::new(item["path"].as_str().unwrap())
                    .strip_prefix(&root)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        rust_paths.sort();
        assert_eq!(rust_paths, bun_paths, "pattern={pattern:?}");
    }
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn structured_scope_corpus_matches_bun_glob_match() {
    let components = ["a", "b", ".hidden", "rollout-a.jsonl", "rollout-b.jsonl"];
    let patterns = [
        "/tmp/logs/a**/rollout-*.jsonl",
        "/tmp/logs/a//rollout-*.jsonl",
        "/tmp/logs/a/rollout-\\*.jsonl",
        "/tmp/logs/{a,b}/rollout-*.jsonl",
        "/tmp/logs/{a,{b,.hidden}}/rollout-[^a].jsonl",
        "/tmp/logs/{a/b,b}/rollout-*.jsonl",
        "/tmp/logs/**/rollout-*.jsonl",
        "/tmp/logs/rollout-[^a].jsonl",
    ];
    let paths: Vec<_> = components
        .iter()
        .flat_map(|dir| {
            components
                .iter()
                .map(move |file| format!("/tmp/logs/{dir}/{file}"))
        })
        .chain(components.iter().map(|file| format!("/tmp/logs/{file}")))
        .collect();
    let corpus = json!({"patterns":patterns,"paths":paths});
    let script = "const {patterns,paths}=JSON.parse(Bun.argv.at(-1)); console.log(JSON.stringify(patterns.map(p=>paths.map(x=>new Bun.Glob(p).match(x)))));";
    let output = Command::new("bun")
        .args(["-e", script, &corpus.to_string()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<Vec<bool>> = serde_json::from_slice(&output.stdout).unwrap();
    for (pattern, row) in patterns.iter().zip(expected) {
        for (path, bun_match) in paths.iter().zip(row) {
            assert_eq!(
                matches_bun_scope(pattern, path).unwrap(),
                bun_match,
                "pattern={pattern:?} path={path:?}"
            );
        }
    }
}

#[test]
fn listing_rejects_descendant_moved_outside_root() {
    let home = std::env::temp_dir().join(format!("pacer-outside-swap-{}", uuid::Uuid::new_v4()));
    let root = home.join("logs");
    let outside = home.join("outside");
    fs::create_dir_all(root.join("nested")).unwrap();
    fs::write(root.join("nested/rollout-leak.jsonl"), "outside").unwrap();
    let resource = ReadResource {
        path: root.to_str().unwrap().into(),
        kind: "codex-logs".into(),
    };
    let reader = NativeRead::prepare(std::slice::from_ref(&resource)).unwrap();
    let authority = CallAuthority::new(
        crate::CallResources {
            reads: vec![resource],
            ..Default::default()
        },
        ["fs.read".into()],
        Instant::now() + std::time::Duration::from_secs(5),
    );
    let mut swapped = false;
    let result = reader.list_with_hook(
        &json!({"dir":root,"glob":"**/rollout-*.jsonl"}),
        &[format!("{}/**", root.display())],
        &ScopeRoots::default(),
        &authority,
        Instant::now() + std::time::Duration::from_secs(5),
        |relative| {
            if relative == Path::new("nested") {
                fs::rename(root.join("nested"), &outside).unwrap();
                swapped = true;
            }
        },
    );
    assert!(swapped);
    assert!(matches!(
        result,
        Err(BrokerError::Invalid("read descendant moved"))
    ));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn exact_read_descriptor_does_not_follow_a_swapped_parent() {
    let home = std::env::temp_dir().join(format!("pacer-read-swap-{}", uuid::Uuid::new_v4()));
    let root = home.join("root");
    let outside = home.join("outside");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(root.join("telemetry.json"), "safe").unwrap();
    fs::write(outside.join("telemetry.json"), "secret").unwrap();
    let root_fd = open_directory(&root).unwrap();
    fs::rename(&root, home.join("saved")).unwrap();
    symlink(&outside, &root).unwrap();
    let mut file = File::from(
        openat(
            &root_fd,
            "telemetry.json",
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW,
            Mode::empty(),
        )
        .unwrap(),
    );
    let mut text = String::new();
    file.read_to_string(&mut text).unwrap();
    assert_eq!(text, "safe");
    fs::remove_dir_all(home).unwrap();
}
