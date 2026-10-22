#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn process_metadata_binds_the_live_incarnation_and_canonical_executable() {
    let pid = std::process::id();
    let details = process_details(pid).unwrap();
    assert_eq!(details.process.pid, pid);
    assert_eq!(details.uid, nix::unistd::getuid().as_raw());
    assert_eq!(details.parent_pid, nix::unistd::getppid().as_raw() as u32);
    assert_eq!(
        details.executable,
        std::env::current_exe().unwrap().canonicalize().unwrap()
    );
    assert_eq!(details.process.boot_id.len(), 36);
    let (seconds, micros) = details.process.birth.split_once(':').unwrap();
    assert!(seconds.parse::<u64>().unwrap() > 0);
    assert!(micros.parse::<u64>().unwrap() < 1_000_000);
    assert_eq!(details, process_details(pid).unwrap());
    assert!(process_details(0).is_err());
    assert!(process_details(u32::MAX).is_err());
}

#[test]
fn absent_pins_disable_native_authority() {
    assert_eq!(
        signer_requirement(None, None, "dev.pacer.cli").unwrap(),
        None
    );
    assert_eq!(
        signer_requirement(Some(""), Some(""), "dev.pacer.cli").unwrap(),
        None
    );
}
#[test]
fn requirements_match_existing_desktop_and_core_verifiers() {
    let cert = "A".repeat(40);
    assert_eq!(
        signer_requirement(Some("ABCDE12345"), None, "dev.pacer.cli")
            .unwrap()
            .unwrap(),
        "anchor apple generic and identifier \"dev.pacer.cli\" and certificate leaf[subject.OU] = \"ABCDE12345\""
    );
    assert_eq!(
        signer_requirement(None, Some(&cert), "dev.pacer.cli")
            .unwrap()
            .unwrap(),
        format!("identifier \"dev.pacer.cli\" and certificate leaf = H\"{cert}\"")
    );
    assert_eq!(
        signer_requirement(Some("ABCDE12345"), Some(&cert), "dev.pacer.desktop")
            .unwrap()
            .unwrap(),
        format!(
            "identifier \"dev.pacer.desktop\" and ((anchor apple generic and certificate leaf[subject.OU] = \"ABCDE12345\") or certificate leaf = H\"{cert}\")"
        )
    );
}
#[test]
fn malformed_pins_and_role_identifiers_are_rejected() {
    for team in ["short", "abcde12345", "ABCDE12345\" or always"] {
        assert!(signer_requirement(Some(team), None, "dev.pacer.cli").is_err());
    }
    for cert in ["bad".to_string(), "a".repeat(40), "G".repeat(40)] {
        assert!(signer_requirement(None, Some(&cert), "dev.pacer.cli").is_err());
    }
    assert!(signer_requirement(Some("ABCDE12345"), None, "dev.pacer.cli\" or always").is_err());
}
