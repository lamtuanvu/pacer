#![allow(clippy::unwrap_used)]
use super::*;

async fn pair(
    owner_key: OwnerKey,
    caller_key: OwnerKey,
) -> (Result<bool, BridgeError>, Result<(), AuthError>) {
    let (owner, caller) = tokio::net::UnixStream::pair().unwrap();
    let mut owner = BufReader::new(owner);
    // The caller hangs up once it is done, as a real one does.
    let caller = async move { authenticate(&mut BufReader::new(caller), &caller_key).await };
    tokio::join!(accept(&mut owner, &owner_key), caller)
}

#[tokio::test]
async fn both_sides_prove_the_same_key() {
    let key = OwnerKey::generate().unwrap();
    let (owner, caller) = pair(key.clone(), key).await;
    assert!(owner.unwrap());
    caller.unwrap();
}

#[tokio::test]
async fn a_caller_with_another_key_rejects_the_owner_and_never_proves() {
    let (owner, caller) = pair(OwnerKey::generate().unwrap(), OwnerKey::generate().unwrap()).await;
    assert!(matches!(caller, Err(AuthError::Unproven)), "{caller:?}");
    // The caller hung up instead of answering with a proof.
    assert!(!owner.unwrap());
}

#[test]
fn keys_round_trip_as_hex_and_never_print() {
    let key = OwnerKey::generate().unwrap();
    assert_eq!(OwnerKey::from_hex(&key.to_hex()), Some(key.clone()));
    assert_eq!(format!("{key:?}"), "OwnerKey(..)");
    assert!(OwnerKey::from_hex(&key.to_hex().to_uppercase()).is_none());
    assert!(OwnerKey::from_hex("00").is_none());
    // Proofs are domain-separated: the owner's proof never passes as the caller's.
    let proof = key.proof(OWNER_PROOF, "a", "b").unwrap();
    assert!(key.verify(OWNER_PROOF, "a", "b", &proof));
    assert!(!key.verify(CORE_PROOF, "a", "b", &proof));
}
