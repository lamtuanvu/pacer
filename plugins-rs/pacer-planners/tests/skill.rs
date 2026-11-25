//! Skill installation tests (from `test/install-skill.test.ts:15-25`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support {
    pub mod fake_home;
}

use pacer_plugin::install::PreparedPlannerPlan;
use serde_json::Value;
use support::fake_home::{FakeHome, params};

fn texts() -> Value {
    serde_json::from_str(include_str!("fixtures/texts.json")).unwrap()
}

fn path(plan: &PreparedPlannerPlan, suffix: &str) -> Option<String> {
    plan.files
        .iter()
        .find(|file| file.path.ends_with(suffix))
        .map(|file| file.path.clone())
}

#[test]
fn skill_is_short_and_byte_equal_to_typescript() {
    let skill = pacer_bundled_planners::skill::PACER_SKILL;
    assert_eq!(skill, texts()["pacerSkill"].as_str().unwrap());
    assert!(skill.len() < 16_000, "skill must stay short");
}

#[tokio::test]
async fn default_installs_tracked_skill_exact_uninstall() {
    for agent in ["claude-code", "codex", "cursor", "opencode"] {
        let home = FakeHome::new();
        let folder = format!("/home/test/.{agent}");
        let plan = home
            .install(params(agent, &folder, "/home/test", Some(true)))
            .await;
        let skill = path(&plan, "skills/pacer/SKILL.md").expect("skill is installed");
        assert_eq!(home.get(&skill).as_deref(), Some(pacer_bundled_planners::skill::PACER_SKILL));
        let change = plan
            .record
            .files
            .iter()
            .find(|file| file.path == skill)
            .expect("tracked in the record");
        assert_eq!(change.action, "created");
        assert_eq!(change.exact, Some(true));

        let result = home.uninstall(agent, plan.record).await;
        assert!(!home.has(&skill), "uninstall removes the created skill");
        assert!(result.files.iter().any(|file| file.path == skill && file.after.is_none()));
    }
}

#[tokio::test]
async fn existing_skill_backed_up_user_changes_kept() {
    let home = FakeHome::new();
    let skill = "/home/test/.claude/skills/pacer/SKILL.md";
    home.put(skill, "# my own skill\n");
    let plan = home
        .install(params("claude-code", "/home/test/.claude", "/home/test", Some(false)))
        .await;
    assert_eq!(home.get(skill).as_deref(), Some(pacer_bundled_planners::skill::PACER_SKILL));
    let change = plan
        .record
        .files
        .iter()
        .find(|file| file.path == skill)
        .unwrap();
    assert_eq!(change.action, "edited");
    assert!(change.backup.is_some());
    let result = home.uninstall("claude-code", plan.record).await;
    assert_eq!(home.get(skill).as_deref(), Some("# my own skill\n"));
    assert!(result
        .uninstall_report
        .restored
        .iter()
        .any(|p| p == skill));
}
