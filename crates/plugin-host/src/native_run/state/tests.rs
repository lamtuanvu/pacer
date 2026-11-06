use super::published_pid;

#[test]
fn published_pid_accepts_only_the_exact_pid_or_the_wrapper_newline() {
    assert!(published_pid(b"4242", 4242));
    assert!(published_pid(b"4242\n", 4242));
    assert!(!published_pid(b"4242\n\n", 4242));
    assert!(!published_pid(b"4242 ", 4242));
    assert!(!published_pid(b"4242\njunk", 4242));
    assert!(!published_pid(b"4243\n", 4242));
    assert!(!published_pid(b"junk4242\n", 4242));
    assert!(!published_pid(b"", 4242));
}
