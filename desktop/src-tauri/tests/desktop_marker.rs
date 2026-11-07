//! Release staging rejects a package whose CLI or update helper carries the desktop marker.
use pacer_desktop::packaging::DESKTOP_EXECUTABLE_MARKER;

fn carries_marker(path: &str) -> bool {
    std::fs::read(path)
        .expect("built binary")
        .windows(DESKTOP_EXECUTABLE_MARKER.len())
        .any(|window| window == DESKTOP_EXECUTABLE_MARKER)
}

#[test]
fn only_the_desktop_executable_carries_the_marker() {
    assert!(carries_marker(env!("CARGO_BIN_EXE_pacer")));
    assert!(!carries_marker(env!("CARGO_BIN_EXE_pacer-update-helper")));
}
