//! `loadStrategy` failures Rust reproduces (`src/config/strategy.ts`): a missing file, schema
//! problems and `validateStrategy`'s own errors. YAML syntax and I/O errors carry Bun or Node
//! text, so callers forward them.
use pacer_config::strategy::StrategyError;
use std::path::Path;

/// `path.join` normalizes `.`, `..` and repeated separators; Rust prints the path as built.
fn joined_like_node(path: &Path) -> bool {
    path.to_str().is_some_and(|text| {
        !text.contains("//") && !text.split('/').any(|part| part == "." || part == "..")
    })
}

/// Whether TypeScript must produce the reply for this strategy load failure.
pub(crate) fn needs_core(error: &StrategyError) -> bool {
    match error {
        StrategyError::Missing(path) => !joined_like_node(path),
        StrategyError::Invalid { path, problems, .. } => {
            !joined_like_node(path)
                || problems
                    .iter()
                    .any(|problem| problem.starts_with("YAML syntax error: "))
        }
        StrategyError::Other(_) => false,
        StrategyError::Io(_) => true,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use pacer_config::strategy::load_strategy;
    use std::fs;

    fn load(home: &Path) -> StrategyError {
        load_strategy(home).unwrap_err()
    }

    #[test]
    fn forwards_only_runtime_text_and_unnormalized_paths() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        assert!(!needs_core(&load(home)));
        assert!(needs_core(&load(&home.join("x/../y"))));
        assert!(needs_core(&load(&home.join(".//y"))));
        fs::write(home.join("strategy.yaml"), "planner: nobody\n").unwrap();
        assert!(!needs_core(&load(home)));
        for text in ["planner: [\n", ""] {
            fs::write(home.join("strategy.yaml"), text).unwrap();
            assert!(needs_core(&load(home)), "{text:?}");
        }
        fs::write(
            home.join("strategy.yaml"),
            "planner: claude-code\nproviders: {claude-code: {}}\nterminal: {open: \"x {cmd} '\"}\n",
        )
        .unwrap();
        assert!(matches!(load(home), StrategyError::Other(_)));
        assert!(!needs_core(&load(home)));
        fs::remove_file(home.join("strategy.yaml")).unwrap();
        fs::create_dir(home.join("strategy.yaml")).unwrap();
        assert!(needs_core(&load(home)));
    }
}
