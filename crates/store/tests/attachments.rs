//! Transcribed from `test/attachments-store.test.ts`: the same quotas, names,
//! expiry and cleanup contract, exercised directly against the shared store.
#![allow(clippy::unwrap_used)]
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.
use pacer_foundation::api::{Code, CoreError};
use pacer_store::{
    TaskStore,
    attachments::{
        AttachmentMeta, BATCH_LIMIT, FILE_LIMIT, SESSION_LIMIT, UploadInput, create_draft, delete,
        expire_drafts, list_draft, read, store_upload,
    },
};
use std::os::unix::fs::PermissionsExt;

const NOW: f64 = 1_800_000_000.0;

fn store() -> (tempfile::TempDir, TaskStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = TaskStore::open(dir.path()).unwrap();
    (dir, store)
}

fn body(size: usize) -> Vec<u8> {
    vec![0; size]
}

fn upload<'a>(
    home: &std::path::Path,
    draft: &'a str,
    batch: &'a str,
    name: &'a str,
    mime: &'a str,
    bytes: Vec<u8>,
) -> Result<AttachmentMeta, CoreError> {
    store_upload(
        home,
        NOW,
        UploadInput {
            draft_id: draft,
            batch_id: batch,
            name,
            mime,
        },
        [Ok(bytes)],
    )
}

#[test]
fn the_service_retention_tick_removes_expired_private_drafts() {
    let (dir, mut store) = store();
    let draft = create_draft(&mut store, NOW).unwrap();
    let file = upload(
        dir.path(),
        &draft,
        "one",
        "private.txt",
        "text/plain",
        body(3),
    )
    .unwrap();
    assert_eq!(expire_drafts(&mut store, NOW + 86_401.0).unwrap(), 1);
    assert_eq!(list_draft(&mut store, &draft, NOW).unwrap(), None);
    assert!(
        !dir.path()
            .join("attachments")
            .join(&draft)
            .join(file.id)
            .exists()
    );
}

#[test]
fn uploads_enforce_per_file_and_batch_limits_while_retaining_safe_display_names() {
    let (dir, mut store) = store();
    let draft = create_draft(&mut store, NOW).unwrap();
    let first = upload(
        dir.path(),
        &draft,
        "batch",
        "../../secret.txt",
        "text/plain",
        body(1),
    )
    .unwrap();
    assert_eq!(first.name, "secret.txt");

    for _ in 1..BATCH_LIMIT {
        upload(
            dir.path(),
            &draft,
            "batch",
            "file.txt",
            "text/plain",
            body(0),
        )
        .unwrap();
    }
    let error = upload(dir.path(), &draft, "batch", "extra", "text/plain", body(0)).unwrap_err();
    assert_eq!(error.code, Code::TooLarge);
    assert_eq!(error.message, "A batch can contain at most 20 files");

    let error = upload(
        dir.path(),
        &draft,
        "other",
        "large",
        "text/plain",
        body(FILE_LIMIT as usize + 1),
    )
    .unwrap_err();
    assert_eq!(error.code, Code::TooLarge);
    assert_eq!(error.message, "Attachment exceeds 25 MiB");
    assert_eq!(
        list_draft(&mut store, &draft, NOW).unwrap().unwrap().len(),
        20
    );
}

#[test]
fn a_cancelled_stream_releases_reservations_and_a_foreign_draft_cannot_remove_files() {
    let (dir, mut store) = store();
    let draft = create_draft(&mut store, NOW).unwrap();
    let foreign = create_draft(&mut store, NOW).unwrap();

    let error = store_upload(
        dir.path(),
        NOW,
        UploadInput {
            draft_id: &draft,
            batch_id: "one",
            name: "bad",
            mime: "text/plain",
        },
        [Err(CoreError::new(Code::Internal, "cancelled"))],
    )
    .unwrap_err();
    assert_eq!(error.message, "cancelled");
    assert_eq!(
        list_draft(&mut store, &draft, NOW).unwrap().unwrap(),
        Vec::new()
    );

    let file = upload(dir.path(), &draft, "one", "fine", "text/plain", body(3)).unwrap();
    let error = delete(&mut store, &foreign, &file.id, NOW).unwrap_err();
    assert_eq!(error.code, Code::NotFound);
    assert_eq!(
        list_draft(&mut store, &draft, NOW).unwrap().unwrap().len(),
        1
    );

    assert_eq!(expire_drafts(&mut store, NOW + 86_401.0).unwrap(), 2);
    assert_eq!(list_draft(&mut store, &draft, NOW).unwrap(), None);
}

#[test]
fn concurrent_uploads_cannot_exceed_aggregate_quota() {
    let (dir, mut store) = store();
    let draft = create_draft(&mut store, NOW).unwrap();
    let home = dir.path().to_path_buf();
    let results = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for _ in 0..5 {
            let home = home.clone();
            let draft = draft.clone();
            handles.push(scope.spawn(move || {
                store_upload(
                    &home,
                    NOW,
                    UploadInput {
                        draft_id: &draft,
                        batch_id: "one",
                        name: "big",
                        mime: "application/octet-stream",
                    },
                    [Ok(body(SESSION_LIMIT as usize / 4))],
                )
            }));
        }
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(
        results.iter().filter(|result| result.is_ok()).count(),
        4,
        "{results:?}"
    );
    assert!(
        results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| error.code == Code::TooLarge
                && error.message == "Session attachments exceed 100 MiB")
    );
    let listed = list_draft(&mut store, &draft, NOW).unwrap().unwrap();
    assert_eq!(listed.len(), 4);
    assert_eq!(
        listed.iter().map(|file| file.size).sum::<u64>(),
        SESSION_LIMIT
    );
}

#[test]
fn metadata_is_validated_before_a_file_is_reserved() {
    let (dir, mut store) = store();
    let draft = create_draft(&mut store, NOW).unwrap();
    let batches = vec![String::new(), "../escape".into(), "x".repeat(129)];
    for batch in &batches {
        let error = upload(dir.path(), &draft, batch, "name", "text/plain", body(0)).unwrap_err();
        assert_eq!(error.code, Code::InvalidInput);
        assert_eq!(error.message, "Invalid attachment metadata");
    }
    let error = upload(
        dir.path(),
        &draft,
        "one",
        &"n".repeat(4097),
        "text/plain",
        body(0),
    )
    .unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    let error = upload(dir.path(), &draft, "one", "name", &"m".repeat(129), body(0)).unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    assert_eq!(
        list_draft(&mut store, &draft, NOW).unwrap().unwrap().len(),
        0
    );
}

#[test]
fn private_paths_use_seventeen_hundred_dirs_and_six_hundred_files() {
    let (dir, mut store) = store();
    let draft = create_draft(&mut store, NOW).unwrap();
    let file = upload(
        dir.path(),
        &draft,
        "one",
        "private.png",
        "image/png",
        body(4),
    )
    .unwrap();
    let attachments = dir.path().join("attachments");
    assert_eq!(
        std::fs::metadata(&attachments)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(attachments.join(&draft))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let path = attachments.join(&draft).join(&file.id);
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(!path.with_extension("upload").exists());

    // A ready file replaced by a symlink is refused by the reader.
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(dir.path().join("outside"), &path).unwrap();
    let error = read(&mut store, &draft, &file.id, NOW).unwrap_err();
    assert_eq!(error.code, Code::NotAllowed);
    assert_eq!(error.message, "Attachment is not a regular private file");
}
