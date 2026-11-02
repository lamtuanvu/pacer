//! Inactive, read-only dashboard frame renderer. Nothing registers native operations.
mod home;
mod layout;
mod model;
mod overlay;
mod render;
mod sessions;
mod settings;
mod titles;
mod updates;
mod work;

/// Render an explicit wire snapshot and UI state through a ratatui TestBackend.
/// The returned rows preserve the TS renderer's deliberate trailing spaces.
pub fn render_frame(
    input: &serde_json::Value,
    case: &serde_json::Value,
) -> std::io::Result<String> {
    use ratatui::{Terminal, backend::TestBackend};
    let rows = render::rows(input, case);
    let width = model::num(&case["width"])
        .floor()
        .clamp(1., u16::MAX as f64) as u16;
    let height = model::num(&case["height"])
        .floor()
        .clamp(1., u16::MAX as f64) as u16;
    let mut terminal = Terminal::new(TestBackend::new(width, height))?;
    terminal.draw(|frame| {
        let buffer = frame.buffer_mut();
        for (y, row) in rows.iter().enumerate().take(height as usize) {
            let mut x = 0usize;
            let mut last_start = 0usize;
            let mut leading = String::new();
            for ch in safe_text(&row.concat()).chars() {
                let size = char_width(ch);
                if size == 0 {
                    if x > 0 {
                        let cell = &mut buffer[(last_start as u16, y as u16)];
                        let s = format!("{}{ch}", cell.symbol());
                        cell.set_symbol(&s);
                    } else {
                        leading.push(ch);
                    }
                    continue;
                }
                if x + size > width as usize {
                    break;
                }
                last_start = x;
                let symbol = format!("{leading}{ch}");
                leading.clear();
                buffer[(x as u16, y as u16)].set_symbol(&symbol);
                for next in 1..size {
                    buffer[((x + next) as u16, y as u16)].set_symbol("");
                }
                x += size;
            }
        }
    })?;
    let buffer = terminal.backend().buffer();
    Ok(rows
        .iter()
        .enumerate()
        .map(|(y, row)| {
            let mut x = 0;
            let mut text = String::new();
            while x < layout::width(row).min(width as usize) {
                let symbol = buffer[(x as u16, y as u16)].symbol();
                text.push_str(symbol);
                x += cell_width(symbol).max(1);
            }
            text
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

use unicode_general_category::{GeneralCategory, get_general_category};

/// The dashboard strips C0, DEL, and C1 controls before measuring or painting.
pub fn safe_text(text: &str) -> String {
    text.chars()
        .filter(|&c| !matches!(c as u32, 0..=0x1f | 0x7f..=0x9f))
        .collect()
}

fn char_width(c: char) -> usize {
    if c.is_ascii() {
        return 1;
    }
    if matches!(
        get_general_category(c),
        GeneralCategory::NonspacingMark
            | GeneralCategory::SpacingMark
            | GeneralCategory::EnclosingMark
    ) {
        return 0;
    }
    let cp = c as u32;
    if (0x1100..=0x115f).contains(&cp)
        || (0x2e80..=0xa4cf).contains(&cp)
        || (0xac00..=0xd7af).contains(&cp)
        || (0xf900..=0xfaff).contains(&cp)
        || (0xfe10..=0xfe6f).contains(&cp)
        || (0xff01..=0xff60).contains(&cp)
        || cp >= 0x1f300
    {
        2
    } else {
        1
    }
}

pub fn cell_width(text: &str) -> usize {
    safe_text(text).chars().map(char_width).sum()
}

// ECMAScript WhiteSpace and LineTerminator, used by String.prototype.trimEnd.
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn clip(text: &str, width: usize, ellipsis: &str) -> String {
    let text = safe_text(text);
    if cell_width(&text) <= width {
        return text;
    }
    let Some(room) = width.checked_sub(cell_width(ellipsis)) else {
        return ".".repeat(width);
    };
    let mut result = String::new();
    let mut cells = 0;
    for c in text.chars() {
        let size = char_width(c);
        if cells + size > room {
            break;
        }
        result.push(c);
        cells += size;
    }
    format!("{}{ellipsis}", result.trim_end_matches(js_whitespace))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend, layout::Rect, widgets::Paragraph};

    #[test]
    fn ts_width_and_clip_semantics() {
        assert_eq!(safe_text("a\u{1b}b\u{85}c"), "abc");
        assert_eq!(cell_width("a界e\u{301}😀"), 6);
        assert_eq!(clip("a\u{feff}bc", 3, "…"), "a…");
        assert_eq!(clip("abc", 1, "..."), ".");
        assert_eq!(clip("界x", 1, "…"), "…");
    }

    #[test]
    fn clipped_text_can_be_painted_in_test_backend() -> Result<(), Box<dyn std::error::Error>> {
        let mut terminal = Terminal::new(TestBackend::new(6, 1))?;
        terminal.draw(|frame| {
            frame.render_widget(
                Paragraph::new(clip("abcdefg", 6, "…")),
                Rect::new(0, 0, 6, 1),
            )
        })?;
        let symbols: String = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert_eq!(symbols, "abcde…");
        Ok(())
    }
}

#[cfg(test)]
mod semantics_tests;
