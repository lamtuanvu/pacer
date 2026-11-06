//! Path matching and ordering from `src/core/files-search.ts`, over UTF-16 code units.
use std::cmp::Ordering;

/// ECMAScript `WhiteSpace` and `LineTerminator` code units (`\s`, `String.prototype.trim`).
pub(crate) fn is_js_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0D
            | 0x20
            | 0xA0
            | 0x1680
            | 0x2000..=0x200A
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
            | 0xFEFF
    )
}

/// A git path is kept only when it is relative, has no `.`/`..`/empty segment and is not inside `.git`.
pub fn safe_repo_path(path: &str) -> bool {
    if path.is_empty() || path.contains('\0') || path.starts_with('/') || path.contains('\\') {
        return false;
    }
    let mut parts = path.split('/');
    parts.next() != Some(".git")
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scored {
    pub tier: u8,
    pub ranges: Vec<[usize; 2]>,
}

fn index_of(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    let from = from.min(hay.len());
    if needle.is_empty() {
        return Some(from);
    }
    hay.get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|at| at + from)
}

/// Basename substring, then path substring, then an in-order subsequence of the query's characters.
pub fn match_path(path: &str, query: &str) -> Option<Scored> {
    let lower: Vec<u16> = path.to_lowercase().encode_utf16().collect();
    let q: Vec<u16> = query.to_lowercase().encode_utf16().collect();
    let base = lower
        .iter()
        .rposition(|&u| u == u16::from(b'/'))
        .map_or(0, |at| at + 1);
    if let Some(at) = index_of(&lower, &q, base) {
        return Some(Scored {
            tier: 0,
            ranges: vec![[at, at + q.len()]],
        });
    }
    if let Some(at) = index_of(&lower, &q, 0) {
        return Some(Scored {
            tier: 1,
            ranges: vec![[at, at + q.len()]],
        });
    }
    let chars: Vec<u16> = q.into_iter().filter(|&u| !is_js_space(u)).collect();
    if chars.is_empty() {
        return None;
    }
    let mut ranges: Vec<[usize; 2]> = Vec::new();
    let mut i = 0;
    for (at, &unit) in lower.iter().enumerate() {
        if i >= chars.len() {
            break;
        }
        if chars.get(i) != Some(&unit) {
            continue;
        }
        match ranges.last_mut() {
            Some(last) if last[1] == at => last[1] = at + 1,
            _ => ranges.push([at, at + 1]),
        }
        i += 1;
    }
    (i == chars.len()).then_some(Scored { tier: 2, ranges })
}

/// `a < b` on JavaScript strings compares UTF-16 code units.
pub(crate) fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers_and_ranges() {
        assert_eq!(
            match_path("src/Remote/Access.ts", "ACCESS"),
            Some(Scored {
                tier: 0,
                ranges: vec![[11, 17]]
            })
        );
        assert_eq!(
            match_path("src/access/index.ts", "access").map(|s| (s.tier, s.ranges)),
            Some((1, vec![[4, 10]]))
        );
        assert_eq!(
            match_path("src/a/c/c/e/s/s.ts", "access").map(|s| s.ranges),
            Some(vec![[4, 5], [6, 7], [8, 9], [10, 11], [12, 13], [14, 15]])
        );
        assert_eq!(
            match_path("src/remote/access.ts", "rem acc").map(|s| s.tier),
            Some(2)
        );
        assert_eq!(match_path("src/remote/access.ts", "zzz"), None);
    }

    #[test]
    fn ranges_count_utf16_units() {
        assert_eq!(
            match_path("\u{1F600}/b.ts", "b").map(|s| s.ranges),
            Some(vec![[3, 4]])
        );
        assert_eq!(match_path("ab", "\u{3000}"), None);
    }

    #[test]
    fn unsafe_paths() {
        for bad in [
            "",
            "../etc/passwd",
            "/abs",
            ".git/config",
            "a/./b",
            "a//b",
            "a\\b",
            "a/..",
        ] {
            assert!(!safe_repo_path(bad), "{bad}");
        }
        assert!(safe_repo_path("src/a.ts"));
        assert!(safe_repo_path("a/.git"));
    }

    #[test]
    fn utf16_order_differs_from_utf8() {
        assert_eq!(cmp_utf16("\u{FF61}", "\u{1F600}"), Ordering::Greater);
    }
}
