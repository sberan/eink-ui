//! C-ABI exports of eink-core for the browser simulator. No wasm-bindgen: strings cross the
//! boundary as (ptr, len) into linear memory; commit() returns damage as a flat i32 array.
use eink_core::{Kind, Mode, Scene};
use std::cell::RefCell;

thread_local! {
    static SCENE: RefCell<Scene> = RefCell::new(Scene::new());
    static DAMAGE: RefCell<Vec<i32>> = RefCell::new(Vec::new());
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn dealloc(p: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(p, 0, len)) };
}

fn s<'a>(p: *const u8, len: usize) -> &'a str {
    unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(p, len)) }
}

#[no_mangle]
pub extern "C" fn create(kind: u32) -> u32 {
    SCENE.with(|sc| sc.borrow_mut().create(match kind { 1 => Kind::Text, 2 => Kind::Markdown, _ => Kind::Box }))
}

#[no_mangle]
pub extern "C" fn set_props(id: u32, p: *const u8, len: usize) -> i32 {
    SCENE.with(|sc| match sc.borrow_mut().set_props(id, s(p, len)) {
        Ok(()) => 0,
        Err(_) => -1,
    })
}

#[no_mangle]
pub extern "C" fn append(parent: u32, child: u32) {
    SCENE.with(|sc| sc.borrow_mut().append(parent, child))
}

#[no_mangle]
pub extern "C" fn insert_before(parent: u32, child: u32, before: u32) {
    SCENE.with(|sc| sc.borrow_mut().insert_before(parent, child, before))
}

#[no_mangle]
pub extern "C" fn remove(parent: u32, child: u32) {
    SCENE.with(|sc| sc.borrow_mut().remove(parent, child))
}

#[no_mangle]
pub extern "C" fn set_root(id: u32) {
    SCENE.with(|sc| sc.borrow_mut().set_root(id))
}

#[no_mangle]
pub extern "C" fn request_full() {
    SCENE.with(|sc| sc.borrow_mut().request_full())
}

#[no_mangle]
pub extern "C" fn hit(x: i32, y: i32) -> u32 {
    SCENE.with(|sc| sc.borrow().hit(x, y))
}

/// Runs layout + paint; returns the number of damage rects. Read them with damage_ptr():
/// 5 i32 per rect: x, y, w, h, mode (0 = DU, 1 = GC16).
#[no_mangle]
pub extern "C" fn commit() -> u32 {
    let d = SCENE.with(|sc| sc.borrow_mut().commit());
    DAMAGE.with(|dm| {
        let mut v = dm.borrow_mut();
        v.clear();
        for x in &d {
            v.extend_from_slice(&[x.rect.x, x.rect.y, x.rect.w, x.rect.h, if x.mode == Mode::Gc16 { 1 } else { 0 }]);
        }
        (v.len() / 5) as u32
    })
}

#[no_mangle]
pub extern "C" fn damage_ptr() -> *const i32 {
    DAMAGE.with(|dm| dm.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn fb_ptr() -> *const u8 {
    SCENE.with(|sc| sc.borrow().fb().as_ptr())
}

#[no_mangle]
pub extern "C" fn fb_len() -> usize {
    SCENE.with(|sc| sc.borrow().fb().len())
}

#[no_mangle]
pub extern "C" fn screen_w() -> u32 {
    eink_core::SCREEN_W
}

#[no_mangle]
pub extern "C" fn screen_h() -> u32 {
    eink_core::SCREEN_H
}

/// Source line of the task under (x, y) when the hit node is markdown, else -1.
#[no_mangle]
pub extern "C" fn hit_line(x: i32, y: i32) -> i32 {
    SCENE.with(|sc| sc.borrow().hit_line(x, y).map(|l| l as i32).unwrap_or(-1))
}
