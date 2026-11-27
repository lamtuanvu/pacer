//! Smoke coverage that the host effect operation module landed in this crate.

#[test]
fn host_check_needs_host_effects() {
    assert!(pacer_host_ops::needs_host_effects("host.check"));
}
