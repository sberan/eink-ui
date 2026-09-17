//! eink-core: retained scene tree + flexbox layout + grayscale rasterizer with damage tracking.
//! Platform-agnostic: compiles natively (Kindle host, tests) and to wasm32 (simulator).
mod raster;
mod text;

use serde::Deserialize;
use std::collections::HashMap;
use taffy::prelude::*;

pub use raster::Rect;
pub use text::TextEngine;

pub const SCREEN_W: u32 = 1072;
pub const SCREEN_H: u32 = 1448;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Box,
    Text,
}

/// Paint properties; layout lives in Taffy. Everything is optional in `set_props` JSON.
#[derive(Clone, Debug, PartialEq)]
pub struct Paint {
    pub bg: Option<u8>,      // fill gray (0 black .. 255 white), None = transparent
    pub border: u8,          // border width in px
    pub border_color: u8,
    pub color: u8,           // text color
    pub text: String,
    pub font_size: f32,
    pub bold: bool,
    pub align: Align,
    pub hit: bool,           // participates in hit testing
    pub radius: u8,          // corner radius (boxes)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    Left,
    Center,
    Right,
}

impl Default for Paint {
    fn default() -> Self {
        Paint { bg: None, border: 0, border_color: 0, color: 0, text: String::new(), font_size: 32.0, bold: false, align: Align::Left, hit: false, radius: 0 }
    }
}

#[derive(Deserialize, Default, Debug)]
#[serde(default)]
pub struct Props {
    pub style: Option<StyleProps>,
    pub bg: Option<Option<u8>>,
    pub border: Option<u8>,
    pub border_color: Option<u8>,
    pub color: Option<u8>,
    pub text: Option<String>,
    pub font_size: Option<f32>,
    pub bold: Option<bool>,
    pub align: Option<Align>,
    pub hit: Option<bool>,
    pub radius: Option<u8>,
}

/// The flexbox subset exposed to JS. Lengths are pixels; strings like "50%" are percentages; "auto".
#[derive(Deserialize, Default, Debug)]
#[serde(default)]
pub struct StyleProps {
    pub width: Option<serde_json::Value>,
    pub height: Option<serde_json::Value>,
    pub min_width: Option<serde_json::Value>,
    pub min_height: Option<serde_json::Value>,
    pub max_width: Option<serde_json::Value>,
    pub max_height: Option<serde_json::Value>,
    pub flex_direction: Option<String>, // row | column
    pub flex_wrap: Option<String>,      // nowrap | wrap
    pub justify_content: Option<String>,
    pub align_items: Option<String>,
    pub align_self: Option<String>,
    pub flex_grow: Option<f32>,
    pub flex_shrink: Option<f32>,
    pub flex_basis: Option<serde_json::Value>,
    pub gap: Option<f32>,
    pub padding: Option<serde_json::Value>, // number or [top,right,bottom,left]
    pub margin: Option<serde_json::Value>,
    pub position: Option<String>, // relative | absolute
    pub top: Option<f32>,
    pub left: Option<f32>,
    pub right: Option<f32>,
    pub bottom: Option<f32>,
    pub display: Option<String>, // flex | none
}

struct Node {
    kind: Kind,
    paint: Paint,
    layout: NodeId,
    parent: u32,
    children: Vec<u32>,
    dirty: bool,
    last_rect: Option<Rect>, // absolute rect at the last commit
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Du,
    Gc16,
}

#[derive(Clone, Copy, Debug)]
pub struct Damage {
    pub rect: Rect,
    pub mode: Mode,
}

pub struct Scene {
    tree: TaffyTree<u32>,
    nodes: HashMap<u32, Node>,
    next_id: u32,
    root: u32,
    fb: Vec<u8>,
    text: TextEngine,
    full_requested: bool,
    partials: u32,
    pub full_every: u32,
    committed_once: bool,
    pending_holes: Vec<Rect>,
}

fn dim(v: &serde_json::Value) -> Dimension {
    match v {
        serde_json::Value::Number(n) => Dimension::length(n.as_f64().unwrap_or(0.0) as f32),
        serde_json::Value::String(s) if s == "auto" => Dimension::auto(),
        serde_json::Value::String(s) if s.ends_with('%') => Dimension::percent(s.trim_end_matches('%').parse::<f32>().unwrap_or(0.0) / 100.0),
        serde_json::Value::String(s) => Dimension::length(s.trim_end_matches("px").parse::<f32>().unwrap_or(0.0)),
        _ => Dimension::auto(),
    }
}

fn lp(v: f32) -> LengthPercentage {
    LengthPercentage::length(v)
}

fn sides(v: &serde_json::Value) -> Option<taffy::Rect<LengthPercentage>> {
    match v {
        serde_json::Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0) as f32;
            Some(taffy::Rect { top: lp(f), right: lp(f), bottom: lp(f), left: lp(f) })
        }
        serde_json::Value::Array(a) if a.len() == 4 => {
            let g = |i: usize| lp(a[i].as_f64().unwrap_or(0.0) as f32);
            Some(taffy::Rect { top: g(0), right: g(1), bottom: g(2), left: g(3) })
        }
        _ => None,
    }
}

fn sides_auto(v: &serde_json::Value) -> Option<taffy::Rect<LengthPercentageAuto>> {
    match v {
        serde_json::Value::Number(n) => {
            let f = LengthPercentageAuto::length(n.as_f64().unwrap_or(0.0) as f32);
            Some(taffy::Rect { top: f, right: f, bottom: f, left: f })
        }
        serde_json::Value::Array(a) if a.len() == 4 => {
            let g = |i: usize| LengthPercentageAuto::length(a[i].as_f64().unwrap_or(0.0) as f32);
            Some(taffy::Rect { top: g(0), right: g(1), bottom: g(2), left: g(3) })
        }
        _ => None,
    }
}

fn apply_style(style: &mut Style, p: &StyleProps) {
    if let Some(v) = &p.width { style.size.width = dim(v); }
    if let Some(v) = &p.height { style.size.height = dim(v); }
    if let Some(v) = &p.min_width { style.min_size.width = dim(v); }
    if let Some(v) = &p.min_height { style.min_size.height = dim(v); }
    if let Some(v) = &p.max_width { style.max_size.width = dim(v); }
    if let Some(v) = &p.max_height { style.max_size.height = dim(v); }
    if let Some(v) = &p.flex_direction {
        style.flex_direction = if v == "row" { FlexDirection::Row } else { FlexDirection::Column };
    }
    if let Some(v) = &p.flex_wrap {
        style.flex_wrap = if v == "wrap" { FlexWrap::Wrap } else { FlexWrap::NoWrap };
    }
    if let Some(v) = &p.justify_content {
        style.justify_content = Some(match v.as_str() {
            "center" => JustifyContent::Center,
            "end" | "flex-end" => JustifyContent::FlexEnd,
            "space-between" => JustifyContent::SpaceBetween,
            "space-around" => JustifyContent::SpaceAround,
            "space-evenly" => JustifyContent::SpaceEvenly,
            _ => JustifyContent::FlexStart,
        });
    }
    if let Some(v) = &p.align_items {
        style.align_items = Some(match v.as_str() {
            "center" => AlignItems::Center,
            "end" | "flex-end" => AlignItems::FlexEnd,
            "stretch" => AlignItems::Stretch,
            _ => AlignItems::FlexStart,
        });
    }
    if let Some(v) = &p.align_self {
        style.align_self = Some(match v.as_str() {
            "center" => AlignSelf::Center,
            "end" | "flex-end" => AlignSelf::FlexEnd,
            "stretch" => AlignSelf::Stretch,
            _ => AlignSelf::FlexStart,
        });
    }
    if let Some(v) = p.flex_grow { style.flex_grow = v; }
    if let Some(v) = p.flex_shrink { style.flex_shrink = v; }
    if let Some(v) = &p.flex_basis { style.flex_basis = dim(v); }
    if let Some(v) = p.gap { style.gap = Size { width: lp(v), height: lp(v) }; }
    if let Some(v) = &p.padding { if let Some(r) = sides(v) { style.padding = r; } }
    if let Some(v) = &p.margin { if let Some(r) = sides_auto(v) { style.margin = r; } }
    if let Some(v) = &p.position {
        style.position = if v == "absolute" { Position::Absolute } else { Position::Relative };
    }
    if p.top.is_some() || p.left.is_some() || p.right.is_some() || p.bottom.is_some() {
        let f = |o: Option<f32>| o.map(LengthPercentageAuto::length).unwrap_or(LengthPercentageAuto::auto());
        style.inset = taffy::Rect { top: f(p.top), left: f(p.left), right: f(p.right), bottom: f(p.bottom) };
    }
    if let Some(v) = &p.display {
        style.display = if v == "none" { Display::None } else { Display::Flex };
    }
}

impl Scene {
    pub fn new() -> Self {
        Scene {
            tree: TaffyTree::new(),
            nodes: HashMap::new(),
            next_id: 1,
            root: 0,
            fb: vec![255; (SCREEN_W * SCREEN_H) as usize],
            text: TextEngine::new(),
            full_requested: true,
            partials: 0,
            full_every: 64,
            committed_once: false,
            pending_holes: Vec::new(),
        }
    }

    pub fn fb(&self) -> &[u8] {
        &self.fb
    }

    pub fn create(&mut self, kind: Kind) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        let style = Style { display: Display::Flex, flex_direction: FlexDirection::Column, ..Default::default() };
        let layout = if kind == Kind::Text { self.tree.new_leaf_with_context(style, id).unwrap() } else { self.tree.new_leaf(style).unwrap() };
        self.nodes.insert(id, Node { kind, paint: Paint::default(), layout, parent: 0, children: Vec::new(), dirty: true, last_rect: None });
        id
    }

    pub fn set_root(&mut self, id: u32) {
        self.root = id;
        self.full_requested = true;
    }

    pub fn set_props(&mut self, id: u32, json: &str) -> Result<(), String> {
        let p: Props = serde_json::from_str(json).map_err(|e| e.to_string())?;
        let node = self.nodes.get_mut(&id).ok_or("no such node")?;
        let mut paint = node.paint.clone();
        if let Some(v) = p.bg { paint.bg = v; }
        if let Some(v) = p.border { paint.border = v; }
        if let Some(v) = p.border_color { paint.border_color = v; }
        if let Some(v) = p.color { paint.color = v; }
        if let Some(v) = p.text { paint.text = v; }
        if let Some(v) = p.font_size { paint.font_size = v; }
        if let Some(v) = p.bold { paint.bold = v; }
        if let Some(v) = p.align { paint.align = v; }
        if let Some(v) = p.hit { paint.hit = v; }
        if let Some(v) = p.radius { paint.radius = v; }
        let text_changed = paint.text != node.paint.text || paint.font_size != node.paint.font_size || paint.bold != node.paint.bold;
        if paint != node.paint {
            node.paint = paint;
            node.dirty = true;
        }
        let layout = node.layout;
        if let Some(sp) = p.style {
            let mut style = self.tree.style(layout).unwrap().clone();
            apply_style(&mut style, &sp);
            self.tree.set_style(layout, style).unwrap();
            self.nodes.get_mut(&id).unwrap().dirty = true;
        }
        if text_changed {
            self.tree.mark_dirty(layout).unwrap();
        }
        Ok(())
    }

    pub fn append(&mut self, parent: u32, child: u32) {
        self.detach(child);
        let (pl, cl) = match (self.nodes.get(&parent), self.nodes.get(&child)) {
            (Some(p), Some(c)) => (p.layout, c.layout),
            _ => return,
        };
        self.tree.add_child(pl, cl).unwrap();
        self.nodes.get_mut(&parent).unwrap().children.push(child);
        let c = self.nodes.get_mut(&child).unwrap();
        c.parent = parent;
        c.dirty = true;
    }

    pub fn insert_before(&mut self, parent: u32, child: u32, before: u32) {
        self.detach(child);
        let idx = match self.nodes.get(&parent) {
            Some(p) => p.children.iter().position(|&c| c == before),
            None => return,
        };
        let Some(idx) = idx else { return self.append(parent, child) };
        let (pl, cl) = (self.nodes[&parent].layout, self.nodes[&child].layout);
        self.tree.insert_child_at_index(pl, idx, cl).unwrap();
        self.nodes.get_mut(&parent).unwrap().children.insert(idx, child);
        let c = self.nodes.get_mut(&child).unwrap();
        c.parent = parent;
        c.dirty = true;
    }

    pub fn remove(&mut self, parent: u32, child: u32) {
        if self.nodes.get(&child).map(|c| c.parent) != Some(parent) {
            return;
        }
        self.detach(child);
        // a removed subtree leaves a hole: its old rect must be repainted
        self.orphaned_rect(child);
    }

    fn detach(&mut self, child: u32) {
        let Some(c) = self.nodes.get(&child) else { return };
        if c.parent == 0 {
            return;
        }
        let parent = c.parent;
        let (pl, cl) = (self.nodes[&parent].layout, c.layout);
        let _ = self.tree.remove_child(pl, cl);
        let p = self.nodes.get_mut(&parent).unwrap();
        p.children.retain(|&x| x != child);
        p.dirty = true;
        self.nodes.get_mut(&child).unwrap().parent = 0;
    }

    fn orphaned_rect(&mut self, id: u32) {
        if let Some(r) = self.nodes.get(&id).and_then(|n| n.last_rect) {
            self.pending_holes.push(r);
        }
    }

    /// Partial updates since the last full flash.
    pub fn partials_since_full(&self) -> u32 {
        self.partials
    }

    pub fn request_full(&mut self) {
        self.full_requested = true;
    }

    /// Hit test: deepest node with `hit` containing (x, y), searching front to back.
    pub fn hit(&self, x: i32, y: i32) -> u32 {
        fn walk(s: &Scene, id: u32, x: i32, y: i32) -> u32 {
            let Some(n) = s.nodes.get(&id) else { return 0 };
            let Some(r) = n.last_rect else { return 0 };
            if !r.contains(x, y) {
                return 0;
            }
            for &c in n.children.iter().rev() {
                let h = walk(s, c, x, y);
                if h != 0 {
                    return h;
                }
            }
            if n.paint.hit { id } else { 0 }
        }
        walk(self, self.root, x, y)
    }

    pub fn commit(&mut self) -> Vec<Damage> {
        if self.root == 0 {
            return Vec::new();
        }
        let root_layout = self.nodes[&self.root].layout;
        let text = &mut self.text;
        let nodes = &self.nodes;
        self.tree
            .compute_layout_with_measure(
                root_layout,
                Size { width: AvailableSpace::Definite(SCREEN_W as f32), height: AvailableSpace::Definite(SCREEN_H as f32) },
                |known, available, _node, ctx, _style| {
                    let Some(id) = ctx.map(|c| *c) else { return Size::ZERO };
                    let paint = &nodes[&id].paint;
                    // content-size contract: min-content = longest word, max-content = unwrapped
                    let (w, h) = match (known.width, available.width) {
                        (Some(w), _) | (None, AvailableSpace::Definite(w)) => text.measure(&paint.text, paint.font_size, paint.bold, Some(w)),
                        (None, AvailableSpace::MinContent) => text.measure(&paint.text, paint.font_size, paint.bold, Some(0.0)),
                        (None, AvailableSpace::MaxContent) => text.measure(&paint.text, paint.font_size, paint.bold, None),
                    };
                    Size { width: known.width.unwrap_or(w), height: known.height.unwrap_or(h) }
                },
            )
            .unwrap();

        // absolute rects + damage from moved/changed nodes
        let mut damage: Vec<Rect> = std::mem::take(&mut self.pending_holes);
        let mut rects: Vec<(u32, Rect)> = Vec::new();
        self.collect_rects(self.root, 0.0, 0.0, &mut rects);
        let mut changed: Vec<Rect> = Vec::new();
        for (id, r) in &rects {
            let n = self.nodes.get_mut(id).unwrap();
            let moved = n.last_rect != Some(*r);
            if n.dirty || moved {
                if let Some(old) = n.last_rect {
                    changed.push(old);
                }
                changed.push(*r);
                n.dirty = false;
            }
            n.last_rect = Some(*r);
        }
        // A full flash costs the user most of a second and inverts the whole panel, so it is
        // never triggered by a small change: only by request, the first paint, a change covering
        // most of the panel (a new page, where GC16 also looks better than DU), or a long run of
        // partials. Hosts clear ghosting on their own schedule, when the device is idle.
        damage.extend(changed);
        damage = raster::coalesce(damage);
        if damage.is_empty() && !self.full_requested && self.committed_once {
            return Vec::new();
        }
        let area: i64 = damage.iter().map(|r| r.w as i64 * r.h as i64).sum();
        let most_of_panel = area * 2 > (SCREEN_W as i64) * (SCREEN_H as i64);
        let full = self.full_requested || !self.committed_once || most_of_panel || self.partials >= self.full_every;
        let mode = if full { Mode::Gc16 } else { Mode::Du };
        if full {
            self.full_requested = false;
            self.partials = 0;
            self.committed_once = true;
            damage = vec![Rect::new(0, 0, SCREEN_W as i32, SCREEN_H as i32)];
        } else {
            self.partials += 1;
        }
        // repaint every damage rect from the root down (painter's order)
        for d in &damage {
            raster::fill(&mut self.fb, *d, 255);
            let order: Vec<u32> = rects.iter().map(|(id, _)| *id).collect();
            for id in order {
                let n = &self.nodes[&id];
                let Some(r) = n.last_rect else { continue };
                if !r.intersects(*d) {
                    continue;
                }
                raster::paint_node(&mut self.fb, n.kind, &n.paint, r, *d, &mut self.text);
            }
        }
        damage.into_iter().map(|rect| Damage { rect, mode }).collect()
    }

    fn collect_rects(&self, id: u32, ox: f32, oy: f32, out: &mut Vec<(u32, Rect)>) {
        let Some(n) = self.nodes.get(&id) else { return };
        let l = self.tree.layout(n.layout).unwrap();
        if self.tree.style(n.layout).unwrap().display == Display::None {
            return;
        }
        let (x, y) = (ox + l.location.x, oy + l.location.y);
        out.push((id, Rect::new(x.round() as i32, y.round() as i32, l.size.width.round() as i32, l.size.height.round() as i32)));
        for &c in &n.children {
            self.collect_rects(c, x, y, out);
        }
    }
}

impl Default for Scene {
    fn default() -> Self {
        Self::new()
    }
}
