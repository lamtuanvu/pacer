#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{TransferError as E, TransferKind as K, Transfers};
#[test]
fn limits_canonical_base64_and_slot_independence() {
    let mut t = Transfers::default();
    assert_eq!(t.begin(K::FileWrite, 4_194_305), Err(E::Invalid));
    let f = t.begin(K::FileWrite, 3).unwrap();
    let u = t.begin(K::HttpUpload, 3).unwrap();
    assert_eq!(t.begin(K::FileWrite, 1), Err(E::Conflict));
    for text in ["YQ", "YQ=", "YR==", "YQ==\n", " YQ==", "_w==", ""] {
        assert!(t.append(K::FileWrite, &f, 0, text).is_err(), "{text:?}");
    }
    assert_eq!(t.append(K::HttpUpload, &u, 0, ""), Ok(0));
    assert_eq!(t.append(K::FileWrite, &f, 0, "YWJj"), Ok(3));
    assert_eq!(t.append(K::HttpUpload, &f, 0, "YWJj"), Err(E::Denied));
    assert_eq!(t.consume(K::FileWrite, &f).unwrap(), b"abc");
    t.release(K::FileWrite, &f).unwrap();
    let next = t.begin(K::FileWrite, 0).unwrap();
    t.consume(K::FileWrite, &next).unwrap();
    assert_eq!(t.release(K::FileWrite, &f), Err(E::Denied));
}
#[test]
fn invalid_utf8_upload_retains_slot_and_bom_is_preserved() {
    let mut t = Transfers::default();
    let h = t.begin(K::HttpUpload, 1).unwrap();
    t.append(K::HttpUpload, &h, 0, "/w==").unwrap();
    assert_eq!(t.consume_text(K::HttpUpload, &h), Err(E::Invalid));
    assert_eq!(t.begin(K::HttpUpload, 1), Err(E::Conflict));
    t.release(K::HttpUpload, &h).unwrap();
    let h = t.begin(K::HttpUpload, 3).unwrap();
    t.append(K::HttpUpload, &h, 0, "77u/").unwrap();
    assert_eq!(t.consume_text(K::HttpUpload, &h).unwrap(), "\u{feff}");
}
#[test]
fn responses_are_sequential_zero_length_reads_do_not_advance_and_revoke_erases_all_handles() {
    let mut t = Transfers::default();
    let h = t.publish(K::HttpResponse, b"abcdef").unwrap();
    assert_eq!(t.read(K::HttpResponse, &h, 1, 1), Err(E::Invalid));
    assert_eq!(t.read(K::HttpResponse, &h, 0, 0), Ok("".into()));
    assert_eq!(t.read(K::HttpResponse, &h, 0, 3), Ok("YWJj".into()));
    assert_eq!(t.read(K::HttpResponse, &h, 0, 3), Err(E::Invalid));
    assert_eq!(t.read(K::HttpResponse, &h, 3, 262_144), Ok("ZGVm".into()));
    t.revoke();
    assert_eq!(t.read(K::HttpResponse, &h, 6, 0), Err(E::Denied));
    assert_eq!(t.release(K::HttpResponse, &h), Err(E::Denied));
}

#[test]
fn exact_four_mib_preserves_bom_nul_and_split_utf8_without_cross_owner_authority() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let mut bytes = "\u{feff}😀\0界".as_bytes().to_vec();
    bytes.resize(4194304, b'x');
    for kind in [K::FileWrite, K::HttpUpload] {
        let mut t = Transfers::default();
        let mut other = Transfers::default();
        let handle = t.begin(kind, bytes.len()).unwrap();
        for (offset, chunk) in bytes.chunks(262144).enumerate() {
            let encoded = STANDARD.encode(chunk);
            assert_eq!(
                t.append(kind, &handle, offset * 262144, &encoded).unwrap(),
                (offset * 262144 + chunk.len())
            );
            assert!(
                other
                    .append(kind, &handle, offset * 262144, &encoded)
                    .is_err()
            );
        }
        assert_eq!(t.consume_text(kind, &handle).unwrap().as_bytes(), bytes);
        assert!(t.consume_text(kind, &handle).is_err());
    }
}

#[test]
fn malformed_utf8_http_payload_is_not_consumed_or_reactivated_by_a_successor() {
    for encoded in ["/w==", "wK8=", "7aCA", "9JCAgA==", "8J+Y"] {
        let mut t = Transfers::default();
        let bytes =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).unwrap();
        let h = t.begin(K::HttpUpload, bytes.len()).unwrap();
        t.append(K::HttpUpload, &h, 0, encoded).unwrap();
        assert_eq!(t.consume_text(K::HttpUpload, &h), Err(E::Invalid));
        assert_eq!(t.begin(K::HttpUpload, 0), Err(E::Conflict));
        t.release(K::HttpUpload, &h).unwrap();
        let successor = t.begin(K::HttpUpload, 0).unwrap();
        t.release(K::HttpUpload, &h).unwrap();
        assert!(t.consume_text(K::HttpUpload, &successor).is_ok());
    }
}
