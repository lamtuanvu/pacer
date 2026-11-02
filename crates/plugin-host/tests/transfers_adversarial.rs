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
