#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::Map;

fn effect_action(label: &str) -> Effect {
    let mut params = Map::new();
    params.insert("op_label".to_string(), Value::String(label.to_string()));
    Effect::Action {
        action: Action {
            label: label.to_string(),
            op: format!("op.{label}"),
            params,
            style: None,
            confirm: None,
        },
        fallback: None,
    }
}

fn act(label: &str) -> Act {
    Act {
        label: label.to_string(),
        effect: effect_action(label),
        confirm: None,
        danger: None,
        subject: None,
    }
}

fn items() -> Vec<Item> {
    let mut stop = act("stop");
    stop.confirm = Some(Confirm {
        title: "Stop?".to_string(),
        body: vec![],
        yes: Some("Stop".to_string()),
        alt: None,
    });
    let mut a = Item {
        id: "a".to_string(),
        primary: Some(act("first")),
        actions: vec![act("second")],
        keys: std::collections::BTreeMap::new(),
    };
    a.keys.insert("x".to_string(), act("dismiss"));
    vec![
        a,
        Item {
            id: "b".to_string(),
            primary: None,
            actions: vec![],
            keys: std::collections::BTreeMap::new(),
        },
        Item {
            id: "c".to_string(),
            primary: Some(stop),
            actions: vec![],
            keys: std::collections::BTreeMap::new(),
        },
    ]
}

fn ctx() -> KeyContext {
    KeyContext {
        items: items(),
        tabs: vec![
            "home".into(),
            "review".into(),
            "sessions".into(),
            "settings".into(),
        ],
        sections: None,
        page: 10,
        wide: true,
        has_detail: false,
        repos: vec!["r1".into(), "r2".into()],
        ops: vec![],
        initial: None,
    }
}

fn press(state: &UiState, keys: &[&str], c: &KeyContext) -> UiState {
    keys.iter()
        .fold(state.clone(), |s, k| reduce_key(&s, k, c).state)
}

#[test]
fn number_keys_tab_and_comma_switch_screens_unknown_tabs_are_ignored() {
    assert_eq!(press(&initial_state(), &["2"], &ctx()).screen, "review");
    assert_eq!(press(&initial_state(), &["4"], &ctx()).screen, "settings");
    assert_eq!(press(&initial_state(), &["5"], &ctx()).screen, "home");
    let mut c = ctx();
    c.tabs.push("setup".into());
    assert_eq!(press(&initial_state(), &["5"], &c).screen, "setup");
    assert_eq!(
        press(&initial_state(), &["tab", "tab"], &ctx()).screen,
        "sessions"
    );
    assert_eq!(
        press(&initial_state(), &["backtab"], &ctx()).screen,
        "settings"
    );
    assert_eq!(press(&initial_state(), &[","], &ctx()).screen, "settings");
}

#[test]
fn selection_moves_by_id_within_bounds_and_pages() {
    let state = press(&initial_state(), &["j", "j", "j", "down"], &ctx());
    assert_eq!(state.selected.get("home").map(String::as_str), Some("c"));
    assert_eq!(
        press(&state, &["k", "up", "up"], &ctx())
            .selected
            .get("home")
            .map(String::as_str),
        Some("a")
    );
    assert_eq!(
        press(&initial_state(), &["pagedown"], &ctx())
            .selected
            .get("home")
            .map(String::as_str),
        Some("c")
    );
    assert_eq!(
        press(&initial_state(), &["end"], &ctx())
            .selected
            .get("home")
            .map(String::as_str),
        Some("c")
    );
}

#[test]
fn enter_triggers_primary_consequential_actions_confirm_first() {
    let first = reduce_key(&initial_state(), "enter", &ctx());
    assert_eq!(first.effect, Some(effect_action("first")));
    let at_stop = press(&initial_state(), &["j", "j"], &ctx());
    let asked = reduce_key(&at_stop, "enter", &ctx());
    assert!(asked.effect.is_none());
    assert!(
        matches!(&asked.state.overlay, Some(Overlay::Confirm { title, yes, .. }) if title == "Stop?" && yes == "Stop")
    );
    let denied = reduce_key(&asked.state, "n", &ctx());
    assert!(denied.state.overlay.is_none());
    let confirmed = reduce_key(&asked.state, "y", &ctx());
    assert_eq!(confirmed.effect, Some(effect_action("stop")));
    assert!(confirmed.state.overlay.is_none());
}

#[test]
fn row_keys_and_actions_menu_reach_every_action_menu_numbers_choose() {
    assert_eq!(
        reduce_key(&initial_state(), "x", &ctx()).effect,
        Some(effect_action("dismiss"))
    );
    let menu = reduce_key(&initial_state(), ".", &ctx()).state;
    assert!(
        matches!(&menu.overlay, Some(Overlay::Menu { actions, .. }) if actions.len() == 2 && actions[0].label == "first" && actions[1].label == "second")
    );
    assert_eq!(
        reduce_key(&menu, "2", &ctx()).effect,
        Some(effect_action("second"))
    );
    let moved = reduce_key(&menu, "j", &ctx()).state;
    assert_eq!(
        reduce_key(&moved, "enter", &ctx()).effect,
        Some(effect_action("second"))
    );
    assert!(reduce_key(&menu, "escape", &ctx()).state.overlay.is_none());
    assert!(
        reduce_key(&press(&initial_state(), &["j"], &ctx()), ".", &ctx())
            .state
            .overlay
            .is_none()
    );
}

fn chained_prompt() -> PromptSpec {
    PromptSpec {
        title: "Two".into(),
        label: "Second".into(),
        help: None,
        value: None,
        required: None,
        submit: Submit::Action(Action {
            label: "done".into(),
            op: "op.done".into(),
            params: Map::new(),
            style: None,
            confirm: None,
        }),
    }
}

#[test]
fn prompts_collect_text_validate_required_values_and_chain() {
    let ask = Act {
        label: "ask".into(),
        effect: Effect::Prompt {
            spec: PromptSpec {
                title: "One".into(),
                label: "First".into(),
                help: None,
                value: None,
                required: Some("Add a note first.".into()),
                submit: Submit::Prompt(Box::new(chained_prompt())),
            },
        },
        confirm: None,
        danger: None,
        subject: None,
    };
    let mut c = ctx();
    c.items = vec![Item {
        id: "a".into(),
        primary: Some(ask),
        actions: vec![],
        keys: std::collections::BTreeMap::new(),
    }];
    let mut state = reduce_key(&initial_state(), "enter", &c).state;
    state = reduce_key(&state, "enter", &c).state;
    assert!(
        matches!(&state.overlay, Some(Overlay::Prompt { error: Some(e), .. }) if e == "Add a note first.")
    );
    state = press(&state, &["h", "i", "x", "backspace"], &c);
    assert!(matches!(&state.overlay, Some(Overlay::Prompt { value, .. }) if value == "hi"));
    state = reduce_key(&state, "enter", &c).state;
    assert!(matches!(&state.overlay, Some(Overlay::Prompt { spec, .. }) if spec.title == "Two"));
    state = press(&state, &["o", "k"], &c);
    let result = reduce_key(&state, "enter", &c);
    match result.effect {
        Some(Effect::Action { action, .. }) => assert_eq!(action.op, "op.done"),
        other => panic!("expected action effect, got {other:?}"),
    }
    let opened = reduce_key(&initial_state(), "enter", &c).state;
    assert!(reduce_key(&opened, "escape", &c).state.overlay.is_none());
}

#[test]
fn q_quits_help_toggles_r_refreshes_and_f_cycles_repo_scope() {
    assert!(reduce_key(&initial_state(), "q", &ctx()).quit);
    assert!(reduce_key(&initial_state(), "interrupt", &ctx()).quit);
    let help = reduce_key(&initial_state(), "?", &ctx()).state;
    assert!(matches!(help.overlay, Some(Overlay::Help { .. })));
    assert!(!reduce_key(&help, "q", &ctx()).quit);
    assert!(reduce_key(&help, "?", &ctx()).state.overlay.is_none());
    assert!(reduce_key(&initial_state(), "R", &ctx()).refresh);
    assert_eq!(
        press(&initial_state(), &["f"], &ctx()).scope.as_deref(),
        Some("r1")
    );
    assert!(
        press(&initial_state(), &["f", "f", "f"], &ctx())
            .scope
            .is_none()
    );
}

#[test]
fn settings_sections_first_then_rows_row_keys_win_for_left_and_right() {
    let adjust = act("adjust");
    let mut c = ctx();
    c.sections = Some(vec!["planner".into(), "accounts".into()]);
    let mut row = Item {
        id: "row".into(),
        primary: None,
        actions: vec![],
        keys: std::collections::BTreeMap::new(),
    };
    row.keys.insert("left".into(), adjust.clone());
    row.keys.insert("right".into(), adjust);
    c.items = vec![row];
    let mut state = press(&initial_state_for("settings"), &["j"], &c);
    assert_eq!(state.section, "accounts");
    state = reduce_key(&state, "enter", &c).state;
    assert_eq!(state.focus, "detail");
    assert_eq!(
        reduce_key(&state, "right", &c).effect,
        Some(effect_action("adjust"))
    );
    let state = reduce_key(&state, "escape", &c).state;
    assert_eq!(state.focus, "list");
    assert_eq!(reduce_key(&state, "escape", &c).state.screen, "home");
}

#[test]
fn narrow_detail_screens_drill_in_and_scroll_escape_returns() {
    let mut c = ctx();
    c.wide = false;
    c.has_detail = true;
    c.items = vec![Item {
        id: "a".into(),
        primary: None,
        actions: vec![],
        keys: std::collections::BTreeMap::new(),
    }];
    let mut state = reduce_key(&initial_state_for("review"), "enter", &c).state;
    assert_eq!(state.focus, "detail");
    state = press(&state, &["j", "j"], &c);
    assert_eq!(state.scroll, 2);
    let back = reduce_key(&state, "escape", &c).state;
    assert_eq!(back.focus, "list");
    assert_eq!(back.scroll, 0);
}

#[test]
fn consequential_actions_confirm_whatever_screen_offers_them() {
    let mk = |op: &str, params: Map<String, Value>, style: Option<&str>| Act {
        label: op.into(),
        effect: Effect::Action {
            action: Action {
                label: op.into(),
                op: op.into(),
                params,
                style: style.map(str::to_string),
                confirm: None,
            },
            fallback: None,
        },
        confirm: None,
        danger: None,
        subject: None,
    };
    let mut verdict = Map::new();
    verdict.insert("verdict".into(), Value::String("accept".into()));
    for a in [
        mk("task.review", verdict.clone(), None),
        mk("task.stop", Map::new(), None),
        mk("account.remove", Map::new(), None),
        mk("update.apply", Map::new(), None),
        mk("host.set", Map::new(), Some("danger")),
    ] {
        assert!(matches!(
            trigger(&initial_state(), Some(&a), false).state.overlay,
            Some(Overlay::Confirm { .. })
        ));
        assert!(trigger(&initial_state(), Some(&a), false).effect.is_none());
    }
    assert!(matches!(
        trigger(
            &initial_state(),
            Some(&mk("host.check", Map::new(), None)),
            false
        )
        .effect,
        Some(Effect::Action { .. })
    ));
}
