#![allow(clippy::unwrap_used)]
use std::path::Path;

#[test]
fn host_runner_and_host_capabilities_have_an_independent_generated_area() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let schema = root.join("docs/plugin-protocol.schema.json");
    let core = xtask::generate_for(
        &schema,
        &root.join("crates/plugin-protocol/src/generated.rs"),
    )
    .unwrap();
    let hosts = xtask::generate_for(
        &schema,
        &root.join("crates/plugin-hosts-protocol/src/generated.rs"),
    )
    .unwrap();
    assert!(core.contains("pub struct CallMetadata"));
    assert!(!core.contains("pub struct HostRunnerOpenParams"));
    assert!(!core.contains("pub struct CapabilityHostsRunParams"));
    assert!(hosts.contains("pub struct HostRunnerOpenParams"));
    assert!(hosts.contains("pub struct CapabilityHostsRunParams"));
    assert!(!hosts.contains("pub struct CallMetadata"));
    for area in [core, hosts] {
        let lines = area
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.trim().starts_with("//"))
            .count();
        assert!(lines <= 10_000, "area generated code has {lines} lines");
    }
}
