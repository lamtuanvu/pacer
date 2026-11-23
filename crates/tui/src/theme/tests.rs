#![allow(clippy::unwrap_used)]
use super::*;

fn env(pairs: &[(&str, &str)]) -> Env {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn every_terminal_role_resolves_to_an_authored_token_in_both_appearances() {
    for (role, name) in ROLE_TOKENS {
        for appearance in [Appearance::Light, Appearance::Dark] {
            let hex = token_hex(name, appearance).unwrap_or_else(|| panic!("{role:?} -> {name}"));
            assert_eq!(hex.len(), 7);
            assert!(hex.starts_with('#'));
            let [r, g, b] = rgb(hex);
            let theme = detect_theme(
                &env(&[
                    ("COLORTERM", "truecolor"),
                    (
                        "PACER_THEME",
                        match appearance {
                            Appearance::Light => "light",
                            Appearance::Dark => "dark",
                        },
                    ),
                ]),
                true,
                false,
            );
            let got = sgr(
                &theme,
                &Style {
                    fg: Some(*role),
                    ..Style::default()
                },
            )
            .open;
            assert_eq!(got, format!("\x1b[38;2;{r};{g};{b}m"), "{role:?}");
        }
    }
}

#[test]
fn color_depth_follows_no_color_term_colorterm_and_force_color() {
    assert_eq!(
        detect_theme(
            &env(&[("NO_COLOR", ""), ("COLORTERM", "truecolor")]),
            true,
            false
        )
        .depth,
        ColorDepth::None
    );
    assert_eq!(
        detect_theme(&env(&[("TERM", "dumb")]), true, false).depth,
        ColorDepth::None
    );
    assert_eq!(
        detect_theme(&env(&[("TERM", "xterm-256color")]), false, false).depth,
        ColorDepth::None
    );
    assert_eq!(
        detect_theme(&env(&[("TERM", "xterm")]), true, false).depth,
        ColorDepth::D16
    );
    assert_eq!(
        detect_theme(&env(&[("TERM", "xterm-256color")]), true, false).depth,
        ColorDepth::D256
    );
    assert_eq!(
        detect_theme(
            &env(&[("TERM", "xterm"), ("COLORTERM", "24bit")]),
            true,
            false
        )
        .depth,
        ColorDepth::Truecolor
    );
    assert_eq!(
        detect_theme(
            &env(&[("TERM", "xterm"), ("FORCE_COLOR", "2")]),
            false,
            false
        )
        .depth,
        ColorDepth::D256
    );
    assert_eq!(
        detect_theme(
            &env(&[("FORCE_COLOR", "0"), ("COLORTERM", "truecolor")]),
            true,
            false
        )
        .depth,
        ColorDepth::None
    );
    assert_eq!(
        detect_theme(
            &env(&[("PACER_COLOR", "16"), ("COLORTERM", "truecolor")]),
            true,
            false
        )
        .depth,
        ColorDepth::D16
    );
}

#[test]
fn appearance_motion_and_plain_mode_come_from_the_environment() {
    assert_eq!(
        detect_theme(&env(&[]), true, false).appearance,
        Appearance::Dark
    );
    assert_eq!(
        detect_theme(&env(&[("COLORFGBG", "0;15")]), true, false).appearance,
        Appearance::Light
    );
    assert_eq!(
        detect_theme(&env(&[("COLORFGBG", "15;0")]), true, false).appearance,
        Appearance::Dark
    );
    assert_eq!(
        detect_theme(
            &env(&[("COLORFGBG", "0;15"), ("PACER_THEME", "dark")]),
            true,
            false
        )
        .appearance,
        Appearance::Dark
    );
    assert!(detect_theme(&env(&[]), true, false).motion);
    assert!(!detect_theme(&env(&[("PACER_NO_ANIM", "1")]), true, false).motion);
    let plain = detect_theme(&env(&[("COLORTERM", "truecolor")]), true, true);
    assert_eq!(plain.depth, ColorDepth::None);
    assert!(!plain.unicode);
    assert!(!plain.motion);
    assert!(plain.plain);
    assert!(!detect_theme(&env(&[("LANG", "C")]), true, false).unicode);
    assert!(detect_theme(&env(&[("LANG", "en_US.UTF-8")]), true, false).unicode);
}

#[test]
fn sixteen_and_256_color_fallbacks_keep_status_roles_distinct_and_never_emit_color_under_no_color()
{
    let sixteen = detect_theme(&env(&[("TERM", "xterm")]), true, false);
    assert_eq!(
        sgr(
            &sixteen,
            &Style {
                fg: Some(Role::Good),
                ..Style::default()
            }
        )
        .open,
        "\x1b[32m"
    );
    assert_eq!(
        sgr(
            &sixteen,
            &Style {
                fg: Some(Role::Warn),
                ..Style::default()
            }
        )
        .open,
        "\x1b[33m"
    );
    assert_eq!(
        sgr(
            &sixteen,
            &Style {
                fg: Some(Role::Bad),
                ..Style::default()
            }
        )
        .open,
        "\x1b[31m"
    );
    assert_eq!(
        sgr(
            &sixteen,
            &Style {
                fg: Some(Role::Info),
                ..Style::default()
            }
        )
        .open,
        "\x1b[36m"
    );
    assert_eq!(
        sgr(
            &sixteen,
            &Style {
                fg: Some(Role::Muted),
                ..Style::default()
            }
        )
        .open,
        "\x1b[2m"
    );
    assert_eq!(
        sgr(
            &sixteen,
            &Style {
                selected: true,
                ..Style::default()
            }
        )
        .open,
        "\x1b[7m"
    );
    let palette = detect_theme(&env(&[("TERM", "xterm-256color")]), true, false);
    let codes: Vec<String> = [Role::Good, Role::Warn, Role::Bad, Role::Info]
        .iter()
        .map(|r| {
            sgr(
                &palette,
                &Style {
                    fg: Some(*r),
                    ..Style::default()
                },
            )
            .open
        })
        .collect();
    let unique: std::collections::HashSet<_> = codes.iter().collect();
    assert_eq!(unique.len(), 4);
    for code in &codes {
        assert!(code.starts_with("\x1b[38;5;") && code.ends_with('m'));
    }
    let none = detect_theme(&env(&[("NO_COLOR", "1")]), true, false);
    let got = sgr(
        &none,
        &Style {
            fg: Some(Role::Bad),
            bold: true,
            selected: true,
            ..Style::default()
        },
    );
    assert_eq!(got.open, "");
    assert_eq!(got.close, "");
}

#[test]
fn hex_to_256_picks_the_nearest_cube_or_grey_entry() {
    assert_eq!(hex_to_256("#000000"), 16);
    assert_eq!(hex_to_256("#ffffff"), 231);
    assert_eq!(hex_to_256("#ff0000"), 196);
    assert_eq!(hex_to_256("#808080"), 244);
}

fn luminance(c: &[u32; 3]) -> f64 {
    let lin = c.map(|v| {
        let s = v as f64 / 255.0;
        if s <= 0.03928 {
            s / 12.92
        } else {
            ((s + 0.055) / 1.055).powf(2.4)
        }
    });
    0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

fn ratio(a: &[u32; 3], b: &[u32; 3]) -> f64 {
    let (x, y) = match (luminance(a), luminance(b)) {
        (x, y) if x >= y => (x, y),
        (x, y) => (y, x),
    };
    (x + 0.05) / (y + 0.05)
}

fn parse_rgb(s: &str, tag: &str) -> Option<[u32; 3]> {
    let start = s.find(tag)? + tag.len();
    let rest = &s[start..];
    let end = rest.find('m').unwrap_or(rest.len());
    let parts: Vec<u32> = rest[..end]
        .split(';')
        .filter_map(|p| p.parse().ok())
        .collect();
    (parts.len() == 3).then(|| [parts[0], parts[1], parts[2]])
}

#[test]
fn text_on_the_selected_row_keeps_at_least_4_5_to_1_contrast_in_both_appearances() {
    let mut failures = Vec::new();
    for appearance in [Appearance::Light, Appearance::Dark] {
        let theme = detect_theme(
            &env(&[
                ("COLORTERM", "truecolor"),
                (
                    "PACER_THEME",
                    match appearance {
                        Appearance::Light => "light",
                        Appearance::Dark => "dark",
                    },
                ),
            ]),
            true,
            false,
        );
        for role in [
            Role::Ink,
            Role::Secondary,
            Role::Muted,
            Role::Good,
            Role::Warn,
            Role::Bad,
            Role::Info,
            Role::Focus,
        ] {
            let open = sgr(
                &theme,
                &Style {
                    fg: Some(role),
                    selected: true,
                    ..Style::default()
                },
            )
            .open;
            let Some(fg) = parse_rgb(&open, "38;2;") else {
                continue;
            };
            let Some(bg) = parse_rgb(&open, "48;2;") else {
                continue;
            };
            let r = ratio(&fg, &bg);
            if r < 4.5 {
                failures.push(format!("{appearance:?} {role:?} {r:.2}:1"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join(", "));
}
