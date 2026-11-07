#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn wire_limit_counts_complete_utf8_frame() {
    assert_eq!(
        frame(json!({"jsonrpc":"2.0","id":1,"result":"界"}))
            .unwrap()
            .last(),
        Some(&b'\n')
    );
    assert!(matches!(
        frame(json!({"body":"a".repeat(MAX_LINE_BYTES)})),
        Err(ProcessError::TooLarge)
    ));
    assert!(matches!(parse_frame(b"{bad"), Err(ProcessError::Malformed)));
}

#[test]
fn frame_number_spellings_and_envelope_size_match_javascript() {
    assert_eq!(frame(json!({"n":1.0})).unwrap(), b"{\"n\":1}\n");
    assert_eq!(frame(json!({"n":-0.0})).unwrap(), b"{\"n\":0}\n");
}
