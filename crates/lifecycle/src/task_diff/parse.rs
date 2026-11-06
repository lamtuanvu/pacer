use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffFile {
    pub path: String,
    pub status: String,
    pub added: u64,
    pub removed: u64,
    pub binary: bool,
}

pub fn cap_patch(output: &str, max_mb: u32) -> String {
    let bytes = output.as_bytes();
    let max = (max_mb as usize) * 1024 * 1024;
    if bytes.len() <= max {
        return output.to_owned();
    }
    String::from_utf8_lossy(&bytes[..max]).into_owned()
}

pub fn parse_name_status(
    output: &str,
) -> (
    std::collections::HashMap<String, String>,
    std::collections::HashMap<String, String>,
) {
    let mut statuses = std::collections::HashMap::new();
    let mut renamed_from = std::collections::HashMap::new();
    let names: Vec<&str> = output.split('\0').collect();
    let mut i = 0;
    while i < names.len() && !names[i].is_empty() {
        let status = names[i];
        i += 1;
        let mut path = names.get(i).copied().unwrap_or("").to_owned();
        i += 1;
        if status.starts_with('R') || status.starts_with('C') {
            let source = path;
            path = names.get(i).copied().unwrap_or("").to_owned();
            i += 1;
            renamed_from.insert(path.clone(), source);
        }
        let mapped = if status.starts_with('R') {
            "renamed"
        } else if status == "A" || status.starts_with('C') {
            "added"
        } else if status == "D" {
            "deleted"
        } else {
            "modified"
        };
        statuses.insert(path, mapped.to_owned());
    }
    (statuses, renamed_from)
}

pub fn parse_numstat(
    output: &str,
    statuses: &std::collections::HashMap<String, String>,
) -> Vec<DiffFile> {
    let stats: Vec<&str> = output.split('\0').collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < stats.len() && !stats[i].is_empty() {
        let entry = stats[i];
        i += 1;
        let Some(first) = entry.find('\t') else {
            continue;
        };
        let second = entry[first + 1..].find('\t').map(|p| first + 1 + p);
        let Some(second) = second else {
            continue;
        };
        let added = &entry[..first];
        let removed = &entry[first + 1..second];
        let mut path = entry[second + 1..].to_owned();
        if path.is_empty() {
            // Git `-z` rename records: `0\t0\t\0old\0new\0` — skip `old`, keep `new`.
            i += 1;
            path = stats.get(i).copied().unwrap_or("").to_owned();
            i += 1;
        }
        let binary = added == "-" || removed == "-";
        files.push(DiffFile {
            path: path.clone(),
            status: statuses
                .get(&path)
                .cloned()
                .unwrap_or_else(|| "modified".into()),
            added: if added == "-" {
                0
            } else {
                added.parse().unwrap_or(0)
            },
            removed: if removed == "-" {
                0
            } else {
                removed.parse().unwrap_or(0)
            },
            binary,
        });
    }
    files
}

pub fn patch_sections(full_patch: &str) -> Vec<String> {
    if full_patch.is_empty() {
        return vec![];
    }
    let mut out = Vec::new();
    let mut start = 0;
    for (idx, _) in full_patch.match_indices("\ndiff --git ") {
        out.push(full_patch[start..idx].to_owned());
        start = idx + 1;
    }
    out.push(full_patch[start..].to_owned());
    out.into_iter().filter(|s| !s.is_empty()).collect()
}

pub fn select_patch_section(full_patch: &str, files: &[DiffFile], path: &str) -> String {
    let index = files.iter().position(|f| f.path == path);
    let Some(index) = index else {
        return String::new();
    };
    patch_sections(full_patch)
        .get(index)
        .cloned()
        .unwrap_or_default()
}
