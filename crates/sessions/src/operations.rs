//! Pure conversation-operation contracts captured from TypeScript. No dispatch,
//! admission, task mutation, attachment storage, or file opening is implemented.
//! Strings use UTF-16 code units to preserve JS lone surrogates as well as length.

#[derive(Debug, Clone, PartialEq)]
pub struct FileReference<'a> {
    pub name: &'a [u16],
    pub line: Option<u64>,
    pub column: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, thiserror::Error)]
pub enum ReferenceError {
    #[error("Invalid file reference")]
    Reference,
    #[error("Invalid file location")]
    Location,
}

fn digits(text: &[u16]) -> bool {
    !text.is_empty() && text.iter().all(|c| (48..=57).contains(c))
}
fn split_colon(text: &[u16]) -> Option<(&[u16], &[u16])> {
    let at = text.iter().rposition(|c| *c == 58)?;
    Some((&text[..at], &text[at + 1..]))
}

// Number(decimal digits), then Number.isSafeInteger, as in readSessionFile.
fn location_number(text: &[u16]) -> Result<u64, ReferenceError> {
    let decimal: String = text.iter().map(|c| char::from(*c as u8)).collect();
    let value = decimal
        .parse::<f64>()
        .map_err(|_| ReferenceError::Location)?;
    if !value.is_finite() || !(1.0..=9_007_199_254_740_991.0).contains(&value) {
        return Err(ReferenceError::Location);
    }
    Ok(value as u64)
}

/// Parse only the TS reference syntax. Callers must still authorize the attempt,
/// resolve the workspace, and use the secure workspace reader before opening it.
pub fn file_reference(reference: &[u16]) -> Result<FileReference<'_>, ReferenceError> {
    if reference.is_empty()
        || reference.len() > 4096
        || reference.iter().any(|c| *c <= 31 || *c == 127)
    {
        return Err(ReferenceError::Reference);
    }
    let Some((prefix, last)) = split_colon(reference).filter(|(_, last)| digits(last)) else {
        return Ok(FileReference {
            name: reference,
            line: None,
            column: None,
        });
    };
    let (name, line, column) = match split_colon(prefix).filter(|(_, line)| digits(line)) {
        Some((name, line)) => (name, location_number(line)?, Some(location_number(last)?)),
        None => (prefix, location_number(last)?, None),
    };
    if name.is_empty() {
        return Err(ReferenceError::Location);
    }
    Ok(FileReference {
        name,
        line: Some(line),
        column,
    })
}

/// `cleanSummary`: retains TAB/LF but strips the TS C0/C1 control ranges.
pub fn clean_summary(summary: &[u16]) -> Vec<u16> {
    summary
        .iter()
        .copied()
        .filter(|c| !matches!(*c, 0..=8 | 11..=31 | 127..=159))
        .collect()
}

// ECMAScript WhiteSpace + LineTerminator, deliberately not Rust is_whitespace
// (which includes U+0085, and omits U+FEFF).
fn js_whitespace(c: &u16) -> bool {
    matches!(*c, 9..=13 | 32 | 160 | 5760 | 8192..=8202 | 8232 | 8233 | 8239 | 8287 | 12288 | 65279)
}
fn trim_js(text: &[u16]) -> &[u16] {
    let start = text
        .iter()
        .position(|c| !js_whitespace(c))
        .unwrap_or(text.len());
    let end = text
        .iter()
        .rposition(|c| !js_whitespace(c))
        .map_or(start, |at| at + 1);
    &text[start..end]
}

/// Summary portion of parseReport (read) or writeReport/storeReport (write).
/// Status, timestamp, source, terminal precedence and persistence remain TS-owned.
pub fn report_summary(summary: &[u16], writing: bool) -> Option<Vec<u16>> {
    let clean = clean_summary(summary);
    let validated = if writing { &clean } else { summary };
    if trim_js(validated).is_empty() || validated.len() > 16_000 {
        return None;
    }
    Some(if writing {
        trim_js(&clean).to_vec()
    } else {
        clean
    })
}
