use super::*;

fn request() -> UntrustedRequest {
    UntrustedRequest {
        version: 1,
        kind: "service-reconciliation".into(),
        transaction_id: "tx".into(),
        coordinator: "peer".into(),
        grant: "grant".into(),
        boot: "boot".into(),
        session: "session".into(),
        job: "job".into(),
        process: "pid-start-code".into(),
        source: "source-digest".into(),
        destination: "destination-digest".into(),
        reservation: "reservation-epoch".into(),
    }
}

#[test]
fn untrusted_requests_never_mint_authority_or_perform_effects() {
    let original = request();
    let mut variants = vec![original.clone(), original.clone()]; // includes replay
    for field in 0..11 {
        let mut changed = original.clone();
        match field {
            0 => changed.version = 2,
            1 => changed.kind = "adoption".into(),
            2 => changed.coordinator = "forged".into(),
            3 => changed.grant = "forged".into(),
            4 => changed.boot = "other".into(),
            5 => changed.session = "other".into(),
            6 => changed.job = "other".into(),
            7 => changed.process = "same-pid-new-start".into(),
            8 => changed.source = "same-path-new-code".into(),
            9 => changed.destination = "other".into(),
            _ => changed.reservation = "stale".into(),
        }
        variants.push(changed);
    }
    for request in variants {
        assert!(matches!(
            authenticate_coordinator(&request),
            Err(OtaError::Unavailable)
        ));
    }
}

#[test]
fn journal_rejects_unknown_formats_and_recovery_never_trusts_disk() {
    use super::journal::{Journal, RecoveryOutcome};
    let valid = r#"{"schema":1,"transactionKind":"service-reconciliation","transactionId":"tx-1","phase":"prepared"}"#;
    let journal = Journal::decode(valid.as_bytes()).unwrap();
    assert_eq!(journal.recovery_outcome(), RecoveryOutcome::RecoveryNeeded);
    for invalid in [
        valid.replace("\"schema\":1", "\"schema\":2"),
        valid.replace("service-reconciliation", "adoption"),
        valid.replace("prepared", "unknown"),
        valid.replace("tx-1", "../escape"),
        valid.replace("\"phase\"", "\"extra\":true,\"phase\""),
    ] {
        assert!(Journal::decode(invalid.as_bytes()).is_err());
    }
}

#[test]
fn journal_store_is_private_and_does_not_overwrite_existing_evidence() {
    use super::journal::{Journal, JournalStore};
    use std::os::unix::fs::PermissionsExt;
    let temp = crate::ota::journal::tests::Temp::new();
    let store = JournalStore::open(&temp.0).unwrap();
    let journal = Journal::decode(br#"{"schema":1,"transactionKind":"service-reconciliation","transactionId":"tx-1","phase":"prepared"}"#).unwrap();
    store.create(&journal).unwrap();
    assert_eq!(store.load().unwrap(), journal);
    assert!(store.create(&journal).is_err());
    assert_eq!(
        std::fs::metadata(temp.0.join("reconciliation-journal.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn peer_artifact_proof_rejects_each_missing_or_changed_fact() {
    use super::peer_identity::{check_evidence, Evidence};
    let valid = Evidence {
        static_valid: true,
        guest_valid: true,
        token_available: true,
        process_unchanged: true,
        file_unchanged: true,
        role_matches: true,
    };
    assert!(matches!(check_evidence(&valid), Err(OtaError::Unavailable)));
    for invalid in [
        Evidence {
            static_valid: false,
            ..valid
        },
        Evidence {
            guest_valid: false,
            ..valid
        }, // wrong cdhash
        Evidence {
            token_available: false,
            ..valid
        },
        Evidence {
            process_unchanged: false,
            ..valid
        },
        Evidence {
            file_unchanged: false,
            ..valid
        },
        Evidence {
            role_matches: false,
            ..valid
        },
    ] {
        assert!(check_evidence(&invalid).is_err());
    }
}
