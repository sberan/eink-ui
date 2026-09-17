//! Markdown as one node: parsed, laid out and painted here, so a page of tasks is a single
//! scene node instead of a React tree of a hundred. The block subset and the layout rules match
//! `js/components/markdown.tsx`; the JS side keeps the parser only for editing (which line a tap
//! toggles is reported by the host as `line`).
use crate::{raster::{self, Rect}, Paint, TextEngine};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlockKind {
    Heading(u8),
    Para,
    Task { checked: bool, indent: u8 },
    Bullet { indent: u8 },
    Number { n: String, indent: u8 },
    Quote,
    Hr,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    pub kind: BlockKind,
    pub text: String,
    /// Source line, for edits.
    pub line: u32,
}

const HEADING_SIZE: [f32; 7] = [0.0, 52.0, 42.0, 36.0, 32.0, 32.0, 32.0];
pub const TASK_ROW: f32 = 56.0;
const TASK_PAD: f32 = 4.0;
const BOX: f32 = 30.0;
const BOX_GAP: f32 = 16.0;
const BULLET_COL: f32 = 24.0;
const NUMBER_COL: f32 = 44.0;
const INLINE_GAP: f32 = 12.0;
const QUOTE_BAR: f32 = 4.0;
const QUOTE_GAP: f32 = 16.0;
const INDENT: f32 = 28.0;

fn is_emoji(c: char) -> bool {
    matches!(c as u32, 0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0xFE0F)
}

/// Inline markup the panel cannot show becomes plain text: one style per text run.
pub fn inline_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // [[page|alias]] and [[page]]
        if c == '[' && chars.get(i + 1) == Some(&'[') {
            if let Some(end) = find(&chars, i + 2, "]]") {
                let inner: String = chars[i + 2..end].iter().collect();
                out.push_str(inner.split('|').next_back().unwrap_or(""));
                i = end + 2;
                continue;
            }
        }
        // [text](url) and ![alt](url)
        if c == '[' || (c == '!' && chars.get(i + 1) == Some(&'[')) {
            let start = if c == '!' { i + 1 } else { i };
            if let Some(close) = find(&chars, start + 1, "]") {
                if chars.get(close + 1) == Some(&'(') {
                    if let Some(end) = find(&chars, close + 2, ")") {
                        out.extend(&chars[start + 1..close]);
                        i = end + 1;
                        continue;
                    }
                }
            }
        }
        if c == '*' || c == '_' || c == '`' {
            i += 1;
            continue;
        }
        if is_emoji(c) {
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn find(chars: &[char], from: usize, pat: &str) -> Option<usize> {
    let p: Vec<char> = pat.chars().collect();
    (from..chars.len().saturating_sub(p.len() - 1)).find(|&i| chars[i..i + p.len()] == p[..])
}

fn indent_of(line: &str) -> u8 {
    ((line.len() - line.trim_start().len()) / 2).min(8) as u8
}

pub fn parse(text: &str) -> Vec<Block> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut blocks = Vec::new();
    let mut i = 0;
    if lines.first() == Some(&"---") {
        if let Some(end) = lines.iter().skip(1).position(|l| *l == "---") {
            i = end + 2;
        }
    }
    let mut para: Option<(String, u32)> = None;
    let flush = |para: &mut Option<(String, u32)>, blocks: &mut Vec<Block>| {
        if let Some((text, line)) = para.take() {
            blocks.push(Block { kind: BlockKind::Para, text, line });
        }
    };
    while i < lines.len() {
        let raw = lines[i].replace('\t', "    ");
        let line = i as u32;
        i += 1;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            flush(&mut para, &mut blocks);
            continue;
        }
        let indent = indent_of(&raw);
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
            flush(&mut para, &mut blocks);
            blocks.push(Block { kind: BlockKind::Heading(hashes as u8), text: inline_text(&trimmed[hashes..]), line });
            continue;
        }
        if trimmed.len() >= 3 && (trimmed.chars().all(|c| c == '-') || trimmed.chars().all(|c| c == '*') || trimmed.chars().all(|c| c == '_')) {
            flush(&mut para, &mut blocks);
            blocks.push(Block { kind: BlockKind::Hr, text: String::new(), line });
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")).or_else(|| trimmed.strip_prefix("+ ")) {
            flush(&mut para, &mut blocks);
            let rest = rest.trim_start();
            let task = rest.strip_prefix("[ ]").map(|r| (false, r)).or_else(|| rest.strip_prefix("[x]").or_else(|| rest.strip_prefix("[X]")).map(|r| (true, r)));
            match task {
                Some((checked, r)) => blocks.push(Block { kind: BlockKind::Task { checked, indent }, text: inline_text(r), line }),
                None => blocks.push(Block { kind: BlockKind::Bullet { indent }, text: inline_text(rest), line }),
            }
            continue;
        }
        let digits = trimmed.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits > 0 && (trimmed[digits..].starts_with(". ") || trimmed[digits..].starts_with(") ")) {
            flush(&mut para, &mut blocks);
            blocks.push(Block { kind: BlockKind::Number { n: trimmed[..digits].to_string(), indent }, text: inline_text(&trimmed[digits + 2..]), line });
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix('>') {
            flush(&mut para, &mut blocks);
            blocks.push(Block { kind: BlockKind::Quote, text: inline_text(rest), line });
            continue;
        }
        match &mut para {
            Some((t, _)) => { t.push(' '); t.push_str(&inline_text(trimmed)); }
            None => para = Some((inline_text(trimmed), line)),
        }
    }
    flush(&mut para, &mut blocks);
    blocks
}

/// A block placed inside the node: rect relative to the node's origin.
#[derive(Clone, Debug)]
pub struct Laid {
    pub rect: Rect,
    pub block: Block,
    /// Where the text run starts, relative to the node's origin, and its width.
    text_x: f32,
    text_w: f32,
    text_size: f32,
    bold: bool,
}

/// Lays the blocks out for a width; returns them with the total height.
pub fn layout(engine: &TextEngine, text: &str, font: f32, width: f32) -> (Vec<Laid>, f32) {
    let gap = (font * 0.4).round();
    let mut y = 0.0f32;
    let mut out = Vec::new();
    for (i, b) in parse(text).into_iter().enumerate() {
        let space = if i == 0 { 0.0 } else { gap };
        match &b.kind {
            BlockKind::Heading(level) => {
                let size = HEADING_SIZE[*level as usize];
                let extra = if *level == 1 { 0.0 } else { gap };
                let h = engine.measure(&b.text, size, true, Some(width)).1;
                let top = y + space + extra;
                out.push(Laid { rect: Rect::new(0, top.round() as i32, width as i32, h.round() as i32), block: b, text_x: 0.0, text_w: width, text_size: size, bold: true });
                y = top + h;
            }
            BlockKind::Para => {
                let h = engine.measure(&b.text, font, false, Some(width)).1;
                let top = y + space;
                out.push(Laid { rect: Rect::new(0, top.round() as i32, width as i32, h.round() as i32), block: b, text_x: 0.0, text_w: width, text_size: font, bold: false });
                y = top + h;
            }
            BlockKind::Task { indent, .. } => {
                let x0 = *indent as f32 * INDENT;
                let tx = x0 + BOX + BOX_GAP;
                let tw = (width - tx).max(1.0);
                let th = engine.measure(&b.text, font, false, Some(tw)).1;
                let h = (th + TASK_PAD * 2.0).max(TASK_ROW);
                // task rows tile: no gap between consecutive tasks (a finger never lands between two)
                let top = y;
                out.push(Laid { rect: Rect::new(0, top.round() as i32, width as i32, h.round() as i32), block: b, text_x: tx, text_w: tw, text_size: font, bold: false });
                y = top + h;
            }
            BlockKind::Bullet { indent } | BlockKind::Number { indent, .. } => {
                let col = if matches!(b.kind, BlockKind::Bullet { .. }) { BULLET_COL } else { NUMBER_COL };
                let x0 = *indent as f32 * INDENT;
                let tx = x0 + col + INLINE_GAP;
                let tw = (width - tx).max(1.0);
                let h = engine.measure(&b.text, font, false, Some(tw)).1;
                let top = y + space;
                out.push(Laid { rect: Rect::new(0, top.round() as i32, width as i32, h.round() as i32), block: b, text_x: tx, text_w: tw, text_size: font, bold: false });
                y = top + h;
            }
            BlockKind::Quote => {
                let tx = QUOTE_BAR + QUOTE_GAP;
                let tw = (width - tx).max(1.0);
                let h = engine.measure(&b.text, font, false, Some(tw)).1;
                let top = y + space;
                out.push(Laid { rect: Rect::new(0, top.round() as i32, width as i32, h.round() as i32), block: b, text_x: tx, text_w: tw, text_size: font, bold: false });
                y = top + h;
            }
            BlockKind::Hr => {
                let top = y + space + gap;
                out.push(Laid { rect: Rect::new(0, top.round() as i32, width as i32, 2), block: b, text_x: 0.0, text_w: width, text_size: font, bold: false });
                y = top + 2.0 + gap;
            }
        }
    }
    (out, y.ceil())
}

/// A stable digest of a laid block's look and place, for block-level damage.
pub fn digest(l: &Laid) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    let mut feed = |bytes: &[u8]| for b in bytes { h ^= *b as u64; h = h.wrapping_mul(0x100000001b3); };
    feed(format!("{:?}", l.block.kind).as_bytes());
    feed(l.block.text.as_bytes());
    feed(&l.rect.x.to_le_bytes());
    feed(&l.rect.y.to_le_bytes());
    feed(&l.rect.w.to_le_bytes());
    feed(&l.rect.h.to_le_bytes());
    h
}

pub fn paint(fb: &mut [u8], engine: &mut TextEngine, p: &Paint, r: Rect, clip: Rect) {
    let (laid, _) = layout(engine, &p.text, p.font_size, r.w as f32);
    let color = p.color;
    for l in &laid {
        let row = Rect::new(r.x + l.rect.x, r.y + l.rect.y, l.rect.w, l.rect.h);
        if !row.intersects(clip) {
            continue;
        }
        match &l.block.kind {
            BlockKind::Hr => raster::fill_clipped(fb, row, clip, color),
            BlockKind::Task { checked, indent } => {
                let bx = row.x + (*indent as f32 * INDENT) as i32;
                let by = row.y + ((row.h as f32 - BOX) / 2.0).round() as i32;
                let bx_rect = Rect::new(bx, by, BOX as i32, BOX as i32);
                raster::fill_clipped(fb, bx_rect, clip, color);
                if !*checked {
                    raster::fill_clipped(fb, Rect::new(bx + 3, by + 3, BOX as i32 - 6, BOX as i32 - 6), clip, 255);
                }
                draw_text_centered(fb, engine, l, row, clip, color);
            }
            BlockKind::Bullet { indent } => {
                let x0 = row.x + (*indent as f32 * INDENT) as i32;
                let th = engine.measure("•", l.text_size, false, None).1;
                engine.draw(fb, "•", l.text_size, false, color, Rect::new(x0, row.y, BULLET_COL as i32, th.round() as i32), clip, false, false);
                draw_text(fb, engine, l, row, clip, color);
            }
            BlockKind::Number { n, indent } => {
                let x0 = row.x + (*indent as f32 * INDENT) as i32;
                let label = format!("{n}.");
                let th = engine.measure(&label, l.text_size, false, None).1;
                engine.draw(fb, &label, l.text_size, false, color, Rect::new(x0, row.y, NUMBER_COL as i32, th.round() as i32), clip, false, true);
                draw_text(fb, engine, l, row, clip, color);
            }
            BlockKind::Quote => {
                raster::fill_clipped(fb, Rect::new(row.x, row.y, QUOTE_BAR as i32, row.h), clip, color);
                draw_text(fb, engine, l, row, clip, color);
            }
            BlockKind::Heading(_) | BlockKind::Para => draw_text(fb, engine, l, row, clip, color),
        }
    }
}

fn draw_text(fb: &mut [u8], engine: &mut TextEngine, l: &Laid, row: Rect, clip: Rect, color: u8) {
    if l.block.text.is_empty() {
        return;
    }
    let tr = Rect::new(row.x + l.text_x.round() as i32, row.y, l.text_w.round() as i32, row.h);
    engine.draw(fb, &l.block.text, l.text_size, l.bold, color, tr, clip, false, false);
}

fn draw_text_centered(fb: &mut [u8], engine: &mut TextEngine, l: &Laid, row: Rect, clip: Rect, color: u8) {
    if l.block.text.is_empty() {
        return;
    }
    let th = engine.measure(&l.block.text, l.text_size, l.bold, Some(l.text_w)).1;
    let ty = row.y + ((row.h as f32 - th) / 2.0).round() as i32;
    let tr = Rect::new(row.x + l.text_x.round() as i32, ty, l.text_w.round() as i32, th.round() as i32);
    engine.draw(fb, &l.block.text, l.text_size, l.bold, color, tr, clip, false, false);
}

/// The source line of the task under (x, y), relative to the node's origin.
pub fn task_line_at(engine: &TextEngine, text: &str, font: f32, width: f32, x: i32, y: i32) -> Option<u32> {
    let (laid, _) = layout(engine, text, font, width);
    laid.iter().find(|l| matches!(l.block.kind, BlockKind::Task { .. }) && l.rect.contains(x, y)).map(|l| l.block.line)
}
