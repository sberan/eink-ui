//! Text measurement and rasterization with fontdue and a glyph cache.
use crate::raster::Rect;
use crate::SCREEN_W;
use fontdue::{Font, FontSettings, Metrics};
use std::collections::HashMap;

static REGULAR: &[u8] = include_bytes!("../fonts/NotoSerif-Regular.ttf");
static BOLD: &[u8] = include_bytes!("../fonts/NotoSerif-Bold.ttf");

pub struct TextEngine {
    fonts: [Font; 2],
    cache: HashMap<(char, u32, bool), (Metrics, Vec<u8>)>,
}

struct Line {
    text: String,
    width: f32,
}

impl TextEngine {
    pub fn new() -> Self {
        let s = FontSettings { scale: 40.0, ..Default::default() };
        TextEngine { fonts: [Font::from_bytes(REGULAR, s.clone()).unwrap(), Font::from_bytes(BOLD, s).unwrap()], cache: HashMap::new() }
    }

    fn glyph(&mut self, c: char, size: f32, bold: bool) -> &(Metrics, Vec<u8>) {
        let key = (c, size as u32, bold);
        if !self.cache.contains_key(&key) {
            let g = self.fonts[bold as usize].rasterize(c, size);
            self.cache.insert(key, g);
        }
        &self.cache[&key]
    }

    fn advance(&self, c: char, size: f32, bold: bool) -> f32 {
        self.fonts[bold as usize].metrics(c, size).advance_width
    }

    fn line_height(&self, size: f32, bold: bool) -> f32 {
        self.fonts[bold as usize].horizontal_line_metrics(size).map(|m| m.new_line_size).unwrap_or(size * 1.3)
    }

    fn ascent(&self, size: f32, bold: bool) -> f32 {
        self.fonts[bold as usize].horizontal_line_metrics(size).map(|m| m.ascent).unwrap_or(size * 0.9)
    }

    /// Greedy word wrap at `max_w` (None = single line). Explicit '\n' breaks lines.
    fn wrap(&self, text: &str, size: f32, bold: bool, max_w: Option<f32>) -> Vec<Line> {
        let mut lines = Vec::new();
        for para in text.split('\n') {
            let mut cur = String::new();
            let mut cur_w = 0.0f32;
            for word in para.split(' ') {
                let ww: f32 = word.chars().map(|c| self.advance(c, size, bold)).sum();
                let space = if cur.is_empty() { 0.0 } else { self.advance(' ', size, bold) };
                if let Some(m) = max_w {
                    if !cur.is_empty() && cur_w + space + ww > m {
                        lines.push(Line { text: std::mem::take(&mut cur), width: cur_w });
                        cur_w = 0.0;
                        cur.push_str(word);
                        cur_w += ww;
                        continue;
                    }
                }
                if !cur.is_empty() {
                    cur.push(' ');
                    cur_w += space;
                }
                cur.push_str(word);
                cur_w += ww;
            }
            lines.push(Line { text: cur, width: cur_w });
        }
        lines
    }

    pub fn measure(&self, text: &str, size: f32, bold: bool, max_w: Option<f32>) -> (f32, f32) {
        if text.is_empty() {
            return (0.0, self.line_height(size, bold));
        }
        let lines = self.wrap(text, size, bold, max_w);
        let w = lines.iter().map(|l| l.width).fold(0.0, f32::max).ceil();
        let h = (self.line_height(size, bold) * lines.len() as f32).ceil();
        (w, h)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn draw(&mut self, fb: &mut [u8], text: &str, size: f32, bold: bool, color: u8, r: Rect, clip: Rect, center: bool, right: bool) {
        let lines = self.wrap(text, size, bold, Some(r.w as f32));
        let lh = self.line_height(size, bold);
        let ascent = self.ascent(size, bold);
        let clip = clip.intersection(r);
        for (i, line) in lines.iter().enumerate() {
            let mut pen_x = r.x as f32 + if center { ((r.w as f32 - line.width) / 2.0).max(0.0) } else if right { (r.w as f32 - line.width).max(0.0) } else { 0.0 };
            let baseline = r.y as f32 + lh * i as f32 + ascent;
            for c in line.text.chars() {
                let (m, bitmap) = self.glyph(c, size, bold).clone();
                let gx = pen_x.round() as i32 + m.xmin;
                let gy = baseline.round() as i32 - m.ymin - m.height as i32;
                for yy in 0..m.height as i32 {
                    let py = gy + yy;
                    if py < clip.y || py >= clip.y + clip.h {
                        continue;
                    }
                    for xx in 0..m.width as i32 {
                        let px = gx + xx;
                        if px < clip.x || px >= clip.x + clip.w {
                            continue;
                        }
                        let a = bitmap[(yy * m.width as i32 + xx) as usize] as u32;
                        if a == 0 {
                            continue;
                        }
                        let idx = (py as u32 * SCREEN_W + px as u32) as usize;
                        let dst = fb[idx] as u32;
                        fb[idx] = ((dst * (255 - a) + color as u32 * a) / 255) as u8;
                    }
                }
                pen_x += m.advance_width;
            }
        }
    }
}

impl Default for TextEngine {
    fn default() -> Self {
        Self::new()
    }
}
