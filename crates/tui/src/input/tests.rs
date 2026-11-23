use super::Keys;

fn keys(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn split_escape_sequences_are_buffered_until_complete() {
    let mut k = Keys::new();
    assert_eq!(k.feed("\x1b["), Vec::<String>::new());
    assert_eq!(k.feed("A"), keys(&["up"]));
    assert_eq!(k.feed("\x1b[D\x1b[C"), keys(&["left", "right"]));
    assert_eq!(
        k.feed("\x1b[1~\x1b[4~\x1bOH\x1bOF"),
        keys(&["home", "end", "home", "end"])
    );
}

#[test]
fn arrows_enter_backspace_interrupt_and_tab() {
    let mut k = Keys::new();
    assert_eq!(
        k.feed("\x1b[A\x1b[B\x1b[C\x1b[D"),
        keys(&["up", "down", "right", "left"])
    );
    assert_eq!(
        k.feed("\x1bOA\x1bOB\x1bOC\x1bOD"),
        keys(&["up", "down", "right", "left"])
    );
    // A pending escape prefix from an earlier chunk completes on the next feed.
    assert_eq!(k.feed("\x1b["), Vec::<String>::new());
    assert_eq!(
        k.feed("Ajk\r\x7f\x03"),
        keys(&["up", "j", "k", "enter", "backspace", "interrupt"])
    );
    assert_eq!(
        k.feed("\t\x1b[Z\x1b[5~\x1b[6~\x1b[H\x1b[F"),
        keys(&["tab", "backtab", "pageup", "pagedown", "home", "end"])
    );
}

#[test]
fn lone_escape_after_a_pause_is_escape() {
    let mut k = Keys::new();
    assert_eq!(k.feed("\x1b"), Vec::<String>::new());
    assert_eq!(k.flush(), keys(&["escape"]));
    assert_eq!(k.flush(), Vec::<String>::new());
}

#[test]
fn utf8_multibyte_input_is_kept_intact() {
    let mut k = Keys::new();
    assert_eq!(k.feed("goal "), keys(&["g", "o", "a", "l", " "]));
    assert_eq!(
        k.feed("héllo 日本"),
        keys(&["h", "é", "l", "l", "o", " ", "日", "本"])
    );
    assert_eq!(k.feed("😀"), keys(&["😀"]));
}

#[test]
fn paste_and_control_characters() {
    let mut k = Keys::new();
    assert_eq!(
        k.feed("goal text"),
        "goal text"
            .chars()
            .map(|c| c.to_string())
            .collect::<Vec<_>>()
    );
    assert_eq!(k.feed("\n"), keys(&["enter"]));
    assert_eq!(k.feed("\x08"), keys(&["backspace"]));
}
