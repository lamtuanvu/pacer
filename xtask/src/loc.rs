//! Rust source line accounting (CRATE-1, CRATE-2, CRATE-3, CRATE-7).
use std::{fs, io, path::Path};

#[derive(Debug, Default)]
pub struct Loc {
    pub code: usize,
    pub generated: usize,
}

pub fn count(crate_dir: &Path) -> Loc {
    try_count(crate_dir)
        .unwrap_or_else(|error| panic!("cannot count {}: {error}", crate_dir.display()))
}

pub fn try_count(crate_dir: &Path) -> io::Result<Loc> {
    let mut loc = Loc::default();
    walk(&crate_dir.join("src"), &mut loc)?;
    Ok(loc)
}

fn walk(dir: &Path, loc: &mut Loc) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            if entry.file_name() != "tests" {
                walk(&path, loc)?;
            }
        } else if path.extension().is_some_and(|ext| ext == "rs") && entry.file_name() != "tests.rs"
        {
            let source = fs::read_to_string(&path)?;
            let lines = code_lines(&source);
            if source
                .lines()
                .next()
                .is_some_and(|line| line.starts_with("// @generated"))
            {
                loc.generated += lines;
            } else {
                loc.code += lines;
            }
        }
    }
    Ok(())
}

fn code_lines(source: &str) -> usize {
    let mut depth = 0usize;
    let mut string = false;
    let mut escaped = false;
    source
        .lines()
        .filter(|line| {
            let mut chars = line.chars().peekable();
            let mut code = false;
            while let Some(c) = chars.next() {
                if depth > 0 {
                    if c == '/' && chars.peek() == Some(&'*') {
                        chars.next();
                        depth += 1;
                    } else if c == '*' && chars.peek() == Some(&'/') {
                        chars.next();
                        depth -= 1;
                    }
                } else if string {
                    code = true;
                    if escaped {
                        escaped = false;
                    } else if c == '\\' {
                        escaped = true;
                    } else if c == '"' {
                        string = false;
                    }
                } else if c == '/' && chars.peek() == Some(&'/') {
                    break;
                } else if c == '/' && chars.peek() == Some(&'*') {
                    chars.next();
                    depth += 1;
                } else if !c.is_whitespace() {
                    code = true;
                    if c == '"' {
                        string = true;
                    }
                }
            }
            code
        })
        .count()
}

/// Whether a crate exceeds a hard size limit or contains misplaced generated code.
pub fn exceeds_budget(
    limits: &crate::deps::Limits,
    rules: &crate::deps::CratePolicy,
    name: &str,
    loc: &Loc,
) -> bool {
    let max = if rules.binary {
        limits.binary_max
    } else if name == "pacer-foundation" {
        limits.foundation_max
    } else {
        limits.max
    };
    loc.code > max
        || loc.generated > limits.generated_max
        || (loc.generated > 0 && !rules.generated)
}
