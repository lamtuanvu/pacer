#![allow(clippy::unwrap_used)]
use super::*;

pub(crate) fn outputs(pairs: &[(&str, &str)]) -> Option<HashMap<String, String>> {
    Some(
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
    )
}

#[test]
fn parsers_follow_the_typescript_patterns() {
    assert_eq!(norm_mac("A:b:0C:d:e:F"), "0a:0b:0c:0d:0e:0f");
    assert_eq!(link_local(Some("FE80::1%en0")).as_deref(), Some("fe80::1"));
    assert_eq!(link_local(Some("2001:db8::1")), None);
    let route6 = "gateway: fe80::abcd%en0\ninterface: en0\n";
    assert_eq!(
        default_router6(Some(route6), "en0").as_deref(),
        Some("fe80::abcd")
    );
    assert_eq!(default_router6(Some(route6), "en1"), None);
    assert_eq!(unescape(r"Caf\:e\\x\"), r"Caf:e\x\");
}

#[test]
fn keys_groups_and_continuations_match_typescript() {
    let mut memory = Memory::default();
    let found = |identity: &str, ssid: Option<&str>| Found {
        identity: identity.into(),
        iface: "en0".into(),
        gw: "192.168.1.1".into(),
        ssid: ssid.map(str::to_owned),
        incomplete: false,
    };
    let first = remember(&mut memory, found("ra:fe80::1", Some("Home")), 1000.0);
    assert_eq!(first.key, digest("pacer-network/v2\0ra:fe80::1\0Home"));
    assert_eq!(
        first.group.as_deref(),
        Some(digest("pacer-network-group/v1\x00192.168.1.1\x00Home").as_str())
    );
    assert_eq!(first.label, "Home");
    assert!(first.continues.is_empty());
    let second = remember(&mut memory, found("ra:fe80::2", Some("Home")), 1500.0);
    assert_eq!(second.continues, vec![first.key.clone()]);
    let stale = remember(&mut memory, found("ra:fe80::3", Some("Home")), 2200.0);
    assert!(stale.continues.is_empty());
    let bare = remember(&mut memory, found("mac:aa:bb:cc:dd:ee:ff", None), 2300.0);
    assert_eq!(bare.label, format!("Network {}", &bare.key[..6]));
    assert_eq!((bare.group, bare.kind), (None, "mac"));
    for at in 0..20 {
        remember(&mut memory, found(&format!("mac:{at}"), None), 3000.0);
    }
    assert_eq!(memory.sightings.len(), SIGHTINGS_MAX);
}

#[tokio::test]
async fn probe_uses_fixed_outputs_and_falls_back_on_incomplete_probes() {
    let _guard = TEST_PROBE.lock().await;
    if !cfg!(target_os = "macos") {
        return;
    }
    let route = (
        "/sbin/route -n get default",
        "gateway: 10.0.0.1\ninterface: en0\n",
    );
    let arp = (
        "/usr/sbin/arp -n 10.0.0.1",
        "? (10.0.0.1) at a:b:c:d:e:f on en0",
    );
    let ports = (
        "/usr/sbin/networksetup -listallhardwareports",
        "Hardware Port: Wi-Fi\nDevice: en0\n\nHardware Port: USB\nDevice: en5\n",
    );
    let summary = ("/usr/sbin/ipconfig getsummary en0", "  SSID : Office \n");
    set_probe_outputs_for_tests(outputs(&[route, arp, ports, summary]));
    let full = current_network().await.unwrap();
    assert_eq!(full.label, "Office");
    assert_eq!(
        full.key,
        digest("pacer-network/v2\0mac:0a:0b:0c:0d:0e:0f\0Office")
    );
    memory().outputs = outputs(&[route, arp, ports]);
    assert_eq!(current_network().await, Some(full));
    set_probe_outputs_for_tests(outputs(&[route, arp, ports]));
    assert_eq!(current_network().await, None);
    set_probe_outputs_for_tests(outputs(&[]));
    assert_eq!(current_network().await, None);
    set_probe_outputs_for_tests(None);
}
