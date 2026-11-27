//! Smoke coverage that the setup and doctor operation modules landed in this crate.
use pacer_setup_ops::doctor_ops::needs_setup_doctor_bridge;
use pacer_setup_ops::setup_ops;

#[test]
fn doctor_bridge_flags_the_setup_doctor_ops() {
    assert!(needs_setup_doctor_bridge("doctor.run"));
    assert!(needs_setup_doctor_bridge("setup.health"));
    assert!(!needs_setup_doctor_bridge("setup.check"));
    assert!(!needs_setup_doctor_bridge("onboarding.skip"));
}

#[test]
fn setup_ops_include_onboarding_skip() {
    assert!(
        setup_ops::ops()
            .iter()
            .any(|op| op.name == "onboarding.skip")
    );
}
