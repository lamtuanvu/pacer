//! Minimal POSIX path join, mirroring `node:path.join` for the paths the
//! plugin builds (`{pacerHome}/opencode/opencode.json`). Node's join strips a
//! trailing separator from the left argument before appending the right one;
//! this replicates that without normalization/special handling, which the
//! plugin never needs for these two clean, host-projected segments.

/// `join(left, right)` in node:path semantics (no `..` resolution needed here).
pub fn join(left: &str, right: &str) -> String {
    if left.is_empty() {
        right.to_owned()
    } else if left.ends_with('/') {
        format!("{left}{right}")
    } else {
        format!("{left}/{right}")
    }
}

#[cfg(test)]
mod tests {
    use super::join;

    #[test]
    fn joins_with_separator() {
        assert_eq!(join("/home/u/.pacer", "opencode"), "/home/u/.pacer/opencode");
        assert_eq!(
            join("/home/u/.pacer/opencode", "opencode.json"),
            "/home/u/.pacer/opencode/opencode.json"
        );
    }

    #[test]
    fn does_not_double_separator() {
        assert_eq!(join("/home/u/.pacer/", "opencode"), "/home/u/.pacer/opencode");
    }

    #[test]
    fn empty_left_uses_right() {
        assert_eq!(join("", "opencode"), "opencode");
    }
}