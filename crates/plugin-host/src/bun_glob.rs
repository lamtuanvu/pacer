//! Bun.Glob brace expansion and component matching shared by declared-scope checks and native reads.
use crate::BrokerError;
use std::{path::Path, time::Instant};

pub struct ScanPattern {
    glob: String,
    explicit_dot: Vec<bool>,
}

pub fn expand_braces(input: &str, deadline: Instant) -> Result<Vec<ScanPattern>, BrokerError> {
    expand_braces_mode(input, deadline, true)
}

pub fn matches_bun_scope(pattern: &str, path: &str) -> Result<bool, BrokerError> {
    let alternatives = expand_braces_mode(
        pattern,
        Instant::now() + std::time::Duration::from_secs(5),
        false,
    )?;
    Ok(alternatives
        .iter()
        .any(|alternative| pattern_reaches(alternative, Path::new(path), true, false)))
}

fn expand_braces_mode(
    input: &str,
    deadline: Instant,
    scan: bool,
) -> Result<Vec<ScanPattern>, BrokerError> {
    // Keep each byte's original component visibility. A dot introduced by brace
    // expansion is not an explicit dot in Bun.Glob.scan's source pattern.
    let mut source_dot = Vec::with_capacity(input.len());
    let mut component_dot = false;
    let mut at_start = true;
    for byte in input.bytes() {
        if at_start {
            component_dot = byte == b'.';
            at_start = false;
        }
        source_dot.push(component_dot);
        if byte == b'/' {
            at_start = true;
        }
    }
    let mut pending = vec![(input.to_owned(), source_dot)];
    let mut expanded = Vec::new();
    while let Some((pattern, source_dot)) = pending.pop() {
        if Instant::now() >= deadline {
            return Err(BrokerError::Timeout);
        }
        let bytes = pattern.as_bytes();
        let mut escaped = false;
        let mut bracket = false;
        let mut opening = None;
        let mut closing = None;
        let mut depth = 0usize;
        for (index, byte) in bytes.iter().copied().enumerate() {
            if escaped {
                escaped = false;
                continue;
            }
            if byte == b'\\' {
                escaped = true;
                continue;
            }
            if byte == b'[' {
                bracket = true;
                continue;
            }
            if byte == b']' {
                bracket = false;
                continue;
            }
            if bracket {
                continue;
            }
            if byte == b'{' {
                if opening.is_none() {
                    opening = Some(index);
                }
                depth += 1;
            } else if byte == b'}' && depth > 0 {
                depth -= 1;
                if depth == 0 {
                    closing = Some(index);
                    break;
                }
            }
        }
        let (Some(start), Some(end)) = (opening, closing) else {
            let mut explicit_dot = Vec::new();
            let mut at_start = true;
            for (index, byte) in pattern.bytes().enumerate() {
                if at_start {
                    explicit_dot.push(source_dot[index]);
                    at_start = false;
                }
                if byte == b'/' {
                    at_start = true;
                }
            }
            expanded.push(ScanPattern {
                glob: pattern,
                explicit_dot,
            });
            continue;
        };
        // Bun.Glob.scan does not enumerate patterns whose brace expression
        // spans path components, even when another alternative has no slash.
        if scan && bytes[start..=end].contains(&b'/') {
            return Ok(Vec::new());
        }
        let mut start_alt = start + 1;
        let mut depth = 0usize;
        let mut escaped = false;
        let mut bracket = false;
        for index in start + 1..=end {
            let byte = bytes[index];
            if escaped {
                escaped = false;
                continue;
            }
            if byte == b'\\' {
                escaped = true;
                continue;
            }
            if byte == b'[' {
                bracket = true;
                continue;
            }
            if byte == b']' {
                bracket = false;
                continue;
            }
            if bracket {
                continue;
            }
            if byte == b'{' {
                depth += 1;
            }
            if byte == b'}' && index != end {
                depth -= 1;
            }
            if index == end || (byte == b',' && depth == 0) {
                let next = format!(
                    "{}{}{}",
                    &pattern[..start],
                    &pattern[start_alt..index],
                    &pattern[end + 1..]
                );
                let mut next_source = Vec::with_capacity(next.len());
                next_source.extend_from_slice(&source_dot[..start]);
                next_source.extend_from_slice(&source_dot[start_alt..index]);
                next_source.extend_from_slice(&source_dot[end + 1..]);
                pending.push((next, next_source));
                start_alt = index + 1;
            }
        }
    }
    Ok(expanded)
}

// Match one Bun glob component. Adjacent stars are ordinary wildcards and a
// backslash escapes the following character, including a literal star.
fn component_matches(pattern: &str, value: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let value: Vec<char> = value.chars().collect();
    let mut memo = vec![vec![None; value.len() + 1]; pattern.len() + 1];
    fn matches(
        p: &[char],
        v: &[char],
        pi: usize,
        vi: usize,
        memo: &mut [Vec<Option<bool>>],
    ) -> bool {
        if let Some(result) = memo[pi][vi] {
            return result;
        }
        let result = if pi == p.len() {
            vi == v.len()
        } else {
            match p[pi] {
                '*' => {
                    matches(p, v, pi + 1, vi, memo)
                        || (vi < v.len() && matches(p, v, pi, vi + 1, memo))
                }
                '?' => vi < v.len() && matches(p, v, pi + 1, vi + 1, memo),
                '\\' => {
                    pi + 1 < p.len()
                        && vi < v.len()
                        && p[pi + 1] == v[vi]
                        && matches(p, v, pi + 2, vi + 1, memo)
                }
                '[' => {
                    let end = p[pi + 1..]
                        .iter()
                        .position(|c| *c == ']')
                        .map(|i| pi + 1 + i);
                    if let Some(end) = end {
                        let start = pi + 1;
                        let negated = matches!(p.get(start), Some('!' | '^'));
                        let mut i = start + usize::from(negated);
                        let mut found = false;
                        while i < end {
                            if i + 2 < end && p[i + 1] == '-' {
                                found |= vi < v.len() && p[i] <= v[vi] && v[vi] <= p[i + 2];
                                i += 3;
                            } else {
                                found |= vi < v.len() && p[i] == v[vi];
                                i += 1;
                            }
                        }
                        vi < v.len() && (found != negated) && matches(p, v, end + 1, vi + 1, memo)
                    } else {
                        vi < v.len() && v[vi] == '[' && matches(p, v, pi + 1, vi + 1, memo)
                    }
                }
                literal => vi < v.len() && literal == v[vi] && matches(p, v, pi + 1, vi + 1, memo),
            }
        };
        memo[pi][vi] = Some(result);
        result
    }
    matches(&pattern, &value, 0, 0, &mut memo)
}

fn pattern_reaches(pattern: &ScanPattern, path: &Path, complete: bool, scan: bool) -> bool {
    let patterns: Vec<_> = if scan {
        pattern
            .glob
            .split('/')
            .filter(|part| !part.is_empty())
            .collect()
    } else {
        pattern
            .glob
            .split('/')
            .skip(usize::from(pattern.glob.starts_with('/')))
            .collect()
    };
    let parts: Vec<_> = path
        .components()
        .filter_map(|part| match part {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect();
    fn reachable(
        patterns: &[&str],
        explicit_dot: &[bool],
        parts: &[&str],
        pi: usize,
        di: usize,
        complete: bool,
        scan: bool,
    ) -> bool {
        if di == parts.len() {
            return if complete {
                patterns[pi..].iter().all(|part| *part == "**")
            } else {
                pi < patterns.len()
            };
        }
        if pi >= patterns.len() {
            return false;
        }
        if patterns[pi] == "**" {
            return reachable(patterns, explicit_dot, parts, pi + 1, di, complete, scan)
                || ((!scan || !parts[di].starts_with('.'))
                    && reachable(patterns, explicit_dot, parts, pi, di + 1, complete, scan));
        }
        (!scan || !parts[di].starts_with('.') || explicit_dot.get(pi) == Some(&true))
            && component_matches(patterns[pi], parts[di])
            && reachable(
                patterns,
                explicit_dot,
                parts,
                pi + 1,
                di + 1,
                complete,
                scan,
            )
    }
    reachable(
        &patterns,
        &pattern.explicit_dot,
        &parts,
        0,
        0,
        complete,
        scan,
    )
}

pub fn may_descend(pattern: &ScanPattern, directory: &Path) -> bool {
    pattern_reaches(pattern, directory, false, true)
}

pub fn matches_visible(pattern: &ScanPattern, file: &Path) -> bool {
    pattern_reaches(pattern, file, true, true)
}
