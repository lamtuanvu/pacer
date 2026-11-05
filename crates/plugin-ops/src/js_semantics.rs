pub(crate) fn codepoint_len(value: &str) -> usize {
    char::decode_utf16(crate::json::utf16(value)).count()
}
