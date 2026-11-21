#![allow(clippy::unwrap_used)]
use super::*;
use std::{fs, io::Write};
fn line(seq: u64, kind: &str, id: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({"seq":seq,"envelope":{"type":"entity","data":{"kind":kind,"id":id,"value":{"attention":5}}}})
    )
}
#[test]
fn replay_reads_only_lines_after_cursor_and_maintains_counts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("outbox");
    fs::write(
        &path,
        line(1, "attention", "discovery:a")
            + &line(2, "counts", "counts")
            + &line(3, "counts", "counts"),
    )
    .unwrap();
    let mut index = Index::default();
    let mut file = fs::File::open(&path).unwrap();
    index.refresh(&mut file).unwrap();
    let (start, end) = index.range(2.0);
    assert_eq!(end - start, line(3, "counts", "counts").len() as u64);
    assert_eq!(index.at.get(&3), Some(&1));
    assert_eq!(index.oldest(), Some(1.0));
}
#[test]
fn inode_reuse_rewrite_detected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("outbox");
    fs::write(&path, line(1, "counts", "counts")).unwrap();
    let mut index = Index::default();
    let mut file = fs::File::open(&path).unwrap();
    index.refresh(&mut file).unwrap();
    let signature = index.signature.clone();
    fs::write(&path, line(9, "counts", "counts")).unwrap();
    // Simulate identical metadata after inode reuse/coarse timestamps.
    index.signature = Some(signature.unwrap().with_metadata(&file.metadata().unwrap()));
    index.refresh(&mut file).unwrap();
    assert_eq!(index.oldest(), Some(9.0));
}
#[test]
fn append_racing_tail_read_keeps_counts_right() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("outbox");
    fs::write(&path, line(1, "attention", "discovery:a")).unwrap();
    let mut index = Index::default();
    let mut file = fs::File::open(&path).unwrap();
    index.refresh(&mut file).unwrap();
    let (start, end) = index.range(0.0);
    let mut writer = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writer
        .write_all((line(2, "counts", "counts") + &line(3, "counts", "counts")).as_bytes())
        .unwrap();
    let tail = bytes(&mut file, start, end).unwrap();
    assert_eq!(tail, line(1, "attention", "discovery:a").as_bytes());
    index.refresh(&mut file).unwrap();
    assert_eq!(index.at.get(&2), Some(&1));
    assert_eq!(index.at.get(&3), Some(&1));
}
#[test]
fn fifty_appends_past_limit_rebuild_at_most_once() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = pacer_foundation::Ctx::with(
        dir.path().to_path_buf(),
        dir.path().to_path_buf(),
        Default::default(),
        1.0,
    );
    let path = dir.path().join("link/outbox.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        (1..=1000)
            .map(|n| line(n, "counts", "counts"))
            .collect::<String>(),
    )
    .unwrap();
    let mut index = Index::default();
    index.refresh(&mut fs::File::open(&path).unwrap()).unwrap();
    let mut rebuilds = 0;
    for seq in 1001..=1050 {
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(line(seq, "counts", "counts").as_bytes())
            .unwrap();
        crate::outbox::rotate_outbox(&ctx).unwrap();
        let old = index.signature.clone();
        index.refresh(&mut fs::File::open(&path).unwrap()).unwrap();
        if old.unwrap().inode != index.signature.as_ref().unwrap().inode {
            rebuilds += 1;
        }
    }
    assert!(rebuilds <= 1, "{rebuilds} rebuilds");
}

#[test]
fn malformed_utf8_matches_full_rescan() {
    let mut data = line(1, "counts", "counts")
        .replace("attention", "attentXon")
        .into_bytes();
    let offset = data.iter().position(|b| *b == b'X').unwrap();
    data[offset] = 0xff;
    assert!(parse(&data).is_some());
}
#[test]
fn aggregates_and_cursor_survive_append_and_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().to_path_buf(),
        dir.path().to_path_buf(),
        Default::default(),
        1.0,
    );
    let path = dir.path().join("link/outbox.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        line(1, "attention", "discovery:a") + &line(2, "counts", "counts"),
    )
    .unwrap();
    let replay = read_outbox_replay(&ctx, 1.0).unwrap();
    assert_eq!(replay.entries.len(), 1);
    assert_eq!(replay.discovery_at_counts.get(&2), Some(&1));
    let replacement = path.with_extension("new");
    fs::write(&replacement, line(8, "counts", "counts")).unwrap();
    fs::rename(replacement, &path).unwrap();
    let replay = read_outbox_replay(&ctx, 2.0).unwrap();
    assert_eq!(replay.oldest, Some(8.0));
    assert_eq!(replay.discovery_at_counts.get(&8), Some(&0));
    assert_eq!(replay.entries, crate::read_outbox_since(&ctx, 2.0).unwrap());
}

fn attention_line(seq: u64, id: &str, severity: &str, removed: bool) -> String {
    let data = if removed {
        serde_json::json!({"kind":"attention","id":id,"removed":true})
    } else {
        serde_json::json!({"kind":"attention","id":id,"value":{"id":id,"severity":severity}})
    };
    format!(
        "{}\n",
        serde_json::json!({"seq":seq,"envelope":{"type":"entity","data":data}})
    )
}

#[test]
fn workflow_attention_aggregates_track_open_and_problems() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().to_path_buf(),
        dir.path().to_path_buf(),
        Default::default(),
        1.0,
    );
    let path = dir.path().join("link/outbox.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        attention_line(1, "budget_spent:r1", "decide", false)
            + &attention_line(2, "budget_warn:r1", "problem", false)
            + &attention_line(3, "discovery:a", "decide", false)
            + &line(4, "counts", "counts"),
    )
    .unwrap();
    let replay = read_outbox_replay(&ctx, 0.0).unwrap();
    assert_eq!(replay.discovery_at_counts.get(&4), Some(&1));
    assert_eq!(replay.workflow_at_counts.get(&4), Some(&2));
    assert_eq!(replay.workflow_problems_at_counts.get(&4), Some(&1));

    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(
            (attention_line(5, "budget_spent:r1", "decide", true)
                + &attention_line(6, "budget_warn:r1", "problem", true)
                + &line(7, "counts", "counts"))
                .as_bytes(),
        )
        .unwrap();
    let replay = read_outbox_replay(&ctx, 0.0).unwrap();
    assert_eq!(replay.workflow_at_counts.get(&7), Some(&0));
    assert_eq!(replay.workflow_problems_at_counts.get(&7), Some(&0));
    assert_eq!(replay.discovery_at_counts.get(&7), Some(&1));
}

/// Publisher order after entityDiff: removal then counts last. Snapshot at the
/// counts line must already exclude the removed workflow item. The old
/// counts-then-removal order is no longer produced by the TypeScript publisher.
#[test]
fn workflow_aggregates_use_publisher_removal_before_counts_order() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().to_path_buf(),
        dir.path().to_path_buf(),
        Default::default(),
        1.0,
    );
    let path = dir.path().join("link/outbox.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        attention_line(1, "failed:t-1", "problem", false)
            + &attention_line(2, "budget_spent:r1", "decide", false)
            + &line(3, "counts", "counts"),
    )
    .unwrap();
    let replay = read_outbox_replay(&ctx, 0.0).unwrap();
    assert_eq!(replay.workflow_at_counts.get(&3), Some(&1));
    assert_eq!(replay.workflow_problems_at_counts.get(&3), Some(&0));

    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(
            (attention_line(4, "budget_spent:r1", "decide", true) + &line(5, "counts", "counts"))
                .as_bytes(),
        )
        .unwrap();
    let replay = read_outbox_replay(&ctx, 0.0).unwrap();
    assert_eq!(replay.workflow_at_counts.get(&5), Some(&0));
    assert_eq!(replay.workflow_problems_at_counts.get(&5), Some(&0));
}
