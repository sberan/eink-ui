use crate::{Align, Kind, Paint, TextEngine, SCREEN_H, SCREEN_W};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Rect { x, y, w, h }
    }
    pub fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && py >= self.y && px < self.x + self.w && py < self.y + self.h
    }
    pub fn intersects(&self, o: Rect) -> bool {
        self.x < o.x + o.w && o.x < self.x + self.w && self.y < o.y + o.h && o.y < self.y + self.h
    }
    pub fn intersection(&self, o: Rect) -> Rect {
        let x = self.x.max(o.x);
        let y = self.y.max(o.y);
        let x2 = (self.x + self.w).min(o.x + o.w);
        let y2 = (self.y + self.h).min(o.y + o.h);
        Rect::new(x, y, (x2 - x).max(0), (y2 - y).max(0))
    }
    pub fn union(&self, o: Rect) -> Rect {
        let x = self.x.min(o.x);
        let y = self.y.min(o.y);
        let x2 = (self.x + self.w).max(o.x + o.w);
        let y2 = (self.y + self.h).max(o.y + o.h);
        Rect::new(x, y, x2 - x, y2 - y)
    }
    pub fn area(&self) -> i64 {
        self.w as i64 * self.h as i64
    }
    fn clipped(&self) -> Rect {
        self.intersection(Rect::new(0, 0, SCREEN_W as i32, SCREEN_H as i32))
    }
}

/// Merge overlapping/near rects; keeps the total refreshed area small without issuing dozens of updates.
pub fn coalesce(mut rects: Vec<Rect>) -> Vec<Rect> {
    rects = rects.into_iter().map(|r| r.clipped()).filter(|r| r.w > 0 && r.h > 0).collect();
    loop {
        let mut merged = false;
        'outer: for i in 0..rects.len() {
            for j in (i + 1)..rects.len() {
                let a = rects[i];
                let b = rects[j];
                let u = a.union(b);
                // merge when the union wastes less than 30% or they touch/overlap
                if a.intersects(b) || u.area() <= (a.area() + b.area()) * 13 / 10 {
                    rects[i] = u;
                    rects.remove(j);
                    merged = true;
                    break 'outer;
                }
            }
        }
        if !merged {
            break;
        }
    }
    rects
}

pub fn fill(fb: &mut [u8], r: Rect, gray: u8) {
    let r = r.clipped();
    for y in r.y..r.y + r.h {
        let row = (y as u32 * SCREEN_W) as usize;
        fb[row + r.x as usize..row + (r.x + r.w) as usize].fill(gray);
    }
}

fn fill_rounded(fb: &mut [u8], r: Rect, clip: Rect, gray: u8, radius: i32) {
    let c = r.intersection(clip).clipped();
    if c.w <= 0 || c.h <= 0 {
        return;
    }
    let rad = radius.min(r.w / 2).min(r.h / 2);
    for y in c.y..c.y + c.h {
        for x in c.x..c.x + c.w {
            if rad > 0 {
                // corner test
                let dx = if x < r.x + rad { r.x + rad - x } else if x >= r.x + r.w - rad { x - (r.x + r.w - rad - 1) } else { 0 };
                let dy = if y < r.y + rad { r.y + rad - y } else if y >= r.y + r.h - rad { y - (r.y + r.h - rad - 1) } else { 0 };
                if dx > 0 && dy > 0 && dx * dx + dy * dy > rad * rad {
                    continue;
                }
            }
            fb[(y as u32 * SCREEN_W + x as u32) as usize] = gray;
        }
    }
}

/// A clipped solid fill, for the markdown painter.
pub fn fill_clipped(fb: &mut [u8], r: Rect, clip: Rect, gray: u8) {
    fill_rounded(fb, r, clip, gray, 0);
}

pub fn paint_node(fb: &mut [u8], kind: Kind, p: &Paint, r: Rect, clip: Rect, text: &mut TextEngine) {
    if kind == Kind::Markdown {
        crate::markdown::paint(fb, text, p, r, clip);
        return;
    }
    if let Some(bg) = p.bg {
        fill_rounded(fb, r, clip, bg, p.radius as i32);
    }
    if p.border > 0 {
        let b = p.border as i32;
        let bc = p.border_color;
        fill_rounded(fb, Rect::new(r.x, r.y, r.w, b), clip, bc, 0);
        fill_rounded(fb, Rect::new(r.x, r.y + r.h - b, r.w, b), clip, bc, 0);
        fill_rounded(fb, Rect::new(r.x, r.y, b, r.h), clip, bc, 0);
        fill_rounded(fb, Rect::new(r.x + r.w - b, r.y, b, r.h), clip, bc, 0);
    }
    if kind == Kind::Text && !p.text.is_empty() {
        text.draw(fb, &p.text, p.font_size, p.bold, p.color, r, clip, p.align == Align::Center, p.align == Align::Right);
    }
}
