#![allow(clippy::unwrap_used)]
//! Transcribed from test/plugin-sdk-install-blocks.test.ts.
use pacer_plugin::install::{BlockStyle, block_text, has_block, remove_block, upsert_block};
use std::time::Instant;

fn marks(style: BlockStyle) -> (&'static str, &'static str) {
    match style {
        BlockStyle::Md => ("<!-- >>> pacer >>> -->", "<!-- <<< pacer <<< -->"),
        BlockStyle::Hash => ("# >>> pacer >>>", "# <<< pacer <<<"),
    }
}

// test/plugin-sdk-install-blocks.test.ts:8 blockText normalizes trailing body newlines
#[test]
fn block_text_normalizes_trailing_newlines() {
    for style in [BlockStyle::Md, BlockStyle::Hash] {
        let (open, close) = marks(style);
        assert_eq!(
            block_text("v1\n\n", style),
            format!("{open}\nv1\n{close}\n")
        );
        assert_eq!(block_text("", style), format!("{open}\n\n{close}\n"));
    }
}

// test/plugin-sdk-install-blocks.test.ts:14 upsert and remove round-trip
#[test]
fn upsert_and_remove_round_trip() {
    for style in [BlockStyle::Md, BlockStyle::Hash] {
        let (open, close) = marks(style);
        for original in ["", "# notes\n", "# notes\n\n", "line one\nline two\n"] {
            let v1 = upsert_block(original, "v1", style).unwrap();
            let v2 = upsert_block(&v1, "v2", style).unwrap();
            let prefix = if original.is_empty() {
                String::new()
            } else {
                format!("{original}\n")
            };
            assert_eq!(v1, format!("{prefix}{open}\nv1\n{close}\n"));
            assert_eq!(v2, format!("{prefix}{open}\nv2\n{close}\n"));
            assert_eq!(v2, upsert_block(original, "v2", style).unwrap());
            assert_eq!(remove_block(&v2, style).unwrap(), original);
        }
    }
}

// test/plugin-sdk-install-blocks.test.ts:25 middle block replaced and removed in place
#[test]
fn middle_block_replaced_and_removed_in_place() {
    for style in [BlockStyle::Md, BlockStyle::Hash] {
        let (open, close) = marks(style);
        let original = format!("before\n{open}\nv1\n{close}\nafter\n");
        assert_eq!(
            upsert_block(&original, "v2", style).unwrap(),
            format!("before\n{open}\nv2\n{close}\nafter\n")
        );
        assert_eq!(remove_block(&original, style).unwrap(), "before\nafter\n");
    }
}

// test/plugin-sdk-install-blocks.test.ts:31 missing trailing newline added
#[test]
fn missing_trailing_newline_added() {
    for style in [BlockStyle::Md, BlockStyle::Hash] {
        let installed = upsert_block("abc", "v1", style).unwrap();
        assert_eq!(remove_block(&installed, style).unwrap(), "abc\n");
    }
}

// test/plugin-sdk-install-blocks.test.ts:35 detects complete blocks only
#[test]
fn detects_complete_blocks_only() {
    for style in [BlockStyle::Md, BlockStyle::Hash] {
        let (open, close) = marks(style);
        let text = format!("{open}\nv1\n{close}");
        assert!(has_block(&text, style).unwrap());
        assert_eq!(remove_block(&text, style).unwrap(), "");
        assert_eq!(remove_block("unrelated\n", style).unwrap(), "unrelated\n");
    }
}

// test/plugin-sdk-install-blocks.test.ts:46 orphan open markers reject detection, upsert and remove
#[test]
fn orphan_open_markers_reject() {
    for (style, open, close) in [
        (
            BlockStyle::Md,
            "<!-- >>> pacer >>> -->",
            "<!-- <<< pacer <<< -->",
        ),
        (BlockStyle::Hash, "# >>> pacer >>>", "# <<< pacer <<<"),
    ] {
        for text in [
            format!("before\n{open}\nuser text\n"),
            format!("{close}\nuser text\n{open}"),
        ] {
            assert_eq!(
                has_block(&text, style).unwrap_err(),
                format!("unmatched open marker: {open}")
            );
            assert_eq!(
                upsert_block(&text, "new", style).unwrap_err(),
                format!("unmatched open marker: {open}")
            );
            assert_eq!(
                remove_block(&text, style).unwrap_err(),
                format!("unmatched open marker: {open}")
            );
        }
    }
}

// test/plugin-sdk-install-blocks.test.ts:57 LF-only trimming across mixed endings
// Adjusted: the TS case uses a lone surrogate, which Rust strings cannot hold.
#[test]
fn lf_only_trimming_across_mixed_endings() {
    let alphabet = ["\n", "\r", "x", "界", "\u{2028}"];
    let mut bodies = vec![String::new()];
    for _ in 0..=4 {
        for body in &bodies {
            let trimmed = body.trim_end_matches('\n');
            assert_eq!(
                block_text(body, BlockStyle::Md),
                format!("<!-- >>> pacer >>> -->\n{trimmed}\n<!-- <<< pacer <<< -->\n")
            );
            assert_eq!(
                block_text(body, BlockStyle::Hash),
                format!("# >>> pacer >>>\n{trimmed}\n# <<< pacer <<<\n")
            );
        }
        bodies = bodies
            .iter()
            .flat_map(|body| alphabet.iter().map(move |c| format!("{body}{c}")))
            .collect();
    }
}

// test/plugin-sdk-install-blocks.test.ts:72 long LF run is linear
#[test]
fn long_lf_run_is_linear() {
    let body = "\n".repeat(1_000_000) + "x";
    let start = Instant::now();
    for style in [BlockStyle::Md, BlockStyle::Hash] {
        let (open, close) = marks(style);
        assert_eq!(
            block_text(&body, style),
            format!("{open}\n{body}\n{close}\n")
        );
    }
    assert!(start.elapsed().as_secs() < 1, "block_text was not linear");
}
