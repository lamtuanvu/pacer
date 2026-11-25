use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockStyle {
    Md,
    Hash,
}

impl BlockStyle {
    fn marks(self) -> (&'static str, &'static str) {
        match self {
            Self::Md => ("<!-- >>> pacer >>> -->", "<!-- <<< pacer <<< -->"),
            Self::Hash => ("# >>> pacer >>>", "# <<< pacer <<<"),
        }
    }
}

/// Trailing LF only: CR is body content, as in the TypeScript implementation.
pub fn block_text(body: &str, style: BlockStyle) -> String {
    let (open, close) = style.marks();
    let end = body.trim_end_matches('\n').len();
    format!("{open}\n{}\n{close}\n", &body[..end])
}

fn find_block(text: &str, style: BlockStyle) -> Result<Option<(usize, usize)>, String> {
    let (open, close) = style.marks();
    let Some(start) = text.find(open) else {
        return Ok(None);
    };
    let Some(closing) = text[start..].find(close).map(|i| start + i) else {
        return Err(format!("unmatched open marker: {open}"));
    };
    let mut end = closing + close.len();
    if text.as_bytes().get(end) == Some(&b'\n') {
        end += 1;
    }
    Ok(Some((start, end)))
}

pub fn has_block(text: &str, style: BlockStyle) -> Result<bool, String> {
    Ok(find_block(text, style)?.is_some())
}

pub fn upsert_block(text: &str, body: &str, style: BlockStyle) -> Result<String, String> {
    let block = block_text(body, style);
    match find_block(text, style)? {
        Some((start, end)) => Ok(format!("{}{}{}", &text[..start], block, &text[end..])),
        None if text.is_empty() => Ok(block),
        None => {
            let separator = if text.ends_with('\n') { "\n" } else { "\n\n" };
            Ok(format!("{text}{separator}{block}"))
        }
    }
}

pub fn remove_block(text: &str, style: BlockStyle) -> Result<String, String> {
    let Some((start, end)) = find_block(text, style)? else {
        return Ok(text.to_string());
    };
    let before = &text[..start];
    let rest = &text[end..];
    if rest.is_empty() && before.ends_with("\n\n") {
        return Ok(before[..before.len() - 1].to_string());
    }
    Ok(format!("{before}{rest}"))
}
