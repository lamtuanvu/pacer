//! JSON wire documents retain JavaScript substring results that end with a lone
//! UTF-16 surrogate. serde_json::Value alone cannot represent those strings.
use crate::{Error, js::*};
use pacer_store::TaskStore;
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::collections::HashMap;
#[derive(Default)]
pub struct Document {
    pub value: Value,
    strings: HashMap<String, String>,
}
impl Document {
    pub fn new(value: Value) -> Self {
        Self {
            value,
            strings: HashMap::new(),
        }
    }
    pub fn substring(&mut self, path: String, source: &str, max: usize) {
        let units: Vec<_> = source.encode_utf16().take(max).collect();
        if units.last().is_some_and(|u| (0xd800..=0xdbff).contains(u)) {
            let mut encoded = String::from("\"");
            for decoded in char::decode_utf16(units) {
                match decoded {
                    Ok(c) => {
                        let escaped = stringify(&Value::String(c.to_string()));
                        encoded.push_str(&escaped[1..escaped.len() - 1]);
                    }
                    Err(e) => encoded.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
                }
            }
            encoded.push('"');
            self.strings.insert(path, encoded);
        }
    }
    pub fn at(&self, path: &str) -> Self {
        Self {
            value: self.value.pointer(path).cloned().unwrap_or(Value::Null),
            strings: self
                .strings
                .iter()
                .filter_map(|(key, value)| {
                    key.strip_prefix(path)
                        .filter(|suffix| suffix.is_empty() || suffix.starts_with('/'))
                        .map(|suffix| (suffix.into(), value.clone()))
                })
                .collect(),
        }
    }
    pub fn json(&self) -> String {
        self.render(&self.value, "")
    }
    fn render(&self, value: &Value, path: &str) -> String {
        if let Some(raw) = self.strings.get(path) {
            return raw.clone();
        }
        match value {
            Value::Array(a) => format!(
                "[{}]",
                a.iter()
                    .enumerate()
                    .map(|(i, v)| self.render(v, &format!("{path}/{i}")))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            Value::Object(m) => {
                let mut indices: Vec<_> = m
                    .keys()
                    .filter_map(|k| {
                        k.parse::<u32>()
                            .ok()
                            .filter(|n| *n < u32::MAX && n.to_string() == *k)
                            .map(|n| (n, k))
                    })
                    .collect();
                indices.sort_by_key(|(n, _)| *n);
                let keys = indices.iter().map(|(_, k)| *k).chain(
                    m.keys()
                        .filter(|k| !indices.iter().any(|(_, index)| *index == *k)),
                );
                format!(
                    "{{{}}}",
                    keys.map(|k| {
                        let key = k.replace('~', "~0").replace('/', "~1");
                        format!(
                            "{}:{}",
                            stringify(&Value::String(k.clone())),
                            self.render(&m[k], &format!("{path}/{key}"))
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",")
                )
            }
            _ => stringify(value),
        }
    }
}
/// Question bodies keyed by immutable message ID. Readers may mark a question
/// read or append another question between model assembly and serialization;
/// neither operation may replace the body paired with the selected question ID.
pub(crate) fn questions(store: &mut TaskStore) -> Result<HashMap<String, String>, Error> {
    let db = store.connection()?;
    let exists = db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !exists {
        return Ok(HashMap::new());
    }
    let mut stmt =
        db.prepare("SELECT id,body FROM messages WHERE recipient='human' AND kind='question'")?;
    Ok(stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<HashMap<_, _>, _>>()?)
}
pub(crate) fn task_strings(
    doc: &mut Document,
    rows: &[Value],
    prefix: &str,
    questions: &HashMap<String, String>,
) {
    for (i, t) in rows.iter().enumerate() {
        if let Some(body) = questions.get(text(&t["messages"]["question"]["id"]))
            && !t["messages"]["question"].is_null()
        {
            doc.substring(format!("{prefix}/{i}/messages/question/text"), body, 1000);
        }
    }
}
pub(crate) fn attention_strings(
    doc: &mut Document,
    rows: &[Value],
    prefix: &str,
    questions: &HashMap<String, String>,
    tasks: &[Value],
) {
    for (i, a) in rows.iter().enumerate() {
        let id = text(&a["taskId"]);
        if a["kind"] == "message" {
            if let Some(body) = tasks
                .iter()
                .find(|t| t["id"] == id)
                .and_then(|t| questions.get(text(&t["messages"]["question"]["id"])))
            {
                doc.substring(format!("{prefix}/{i}/detail"), body, 200);
            }
        } else if a["kind"] == "question"
            && let Some(task) = tasks.iter().find(|t| t["id"] == id)
        {
            doc.substring(
                format!("{prefix}/{i}/detail"),
                text(&task["question"]["text"]),
                200,
            );
        }
    }
}
