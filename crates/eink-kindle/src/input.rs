//! Reads every /dev/input/event* device: multitouch taps on the panel and key presses
//! from the PagePress keypad, scaled to screen coordinates via EVIOCGABS.
use crate::{log, Event};
use std::{fs::File, io::Read, os::unix::io::AsRawFd, sync::mpsc::Sender, time::{Duration, Instant}};

const KEY_POWER: u16 = 116;
/// This many power-button presses inside the window ask the host for a reload. A long hold is
/// not usable: powerd reboots the device after a few seconds regardless of what we do.
pub const RELOAD_CLICKS: usize = 5;
pub const RELOAD_WINDOW: Duration = Duration::from_secs(4);

const SCREEN_W: i64 = 1072;
const SCREEN_H: i64 = 1448;

#[repr(C)]
#[derive(Default)]
struct AbsInfo {
    value: i32,
    min: i32,
    max: i32,
    fuzz: i32,
    flat: i32,
    res: i32,
}

fn abs_max(fd: i32, axis: u32) -> i32 {
    let mut ai = AbsInfo::default();
    // EVIOCGABS(axis) = _IOR('E', 0x40 + axis, struct input_absinfo)
    let req: libc::c_ulong = (2u64 << 30 | (std::mem::size_of::<AbsInfo>() as u64) << 16 | (b'E' as u64) << 8 | (0x40 + axis as u64)) as libc::c_ulong;
    let rc = unsafe { libc::ioctl(fd, req as _, &mut ai as *mut AbsInfo) };
    if rc < 0 { 0 } else { ai.max }
}

pub fn start(tx: Sender<Event>) {
    let mut devs: Vec<String> = std::fs::read_dir("/dev/input")
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path().to_string_lossy().to_string()).filter(|p| p.contains("/event")).collect())
        .unwrap_or_default();
    devs.sort();
    for dev in devs {
        let Ok(f) = File::open(&dev) else {
            log(&format!("open {dev} failed"));
            continue;
        };
        let fd = f.as_raw_fd();
        let (mut mx, mut my) = (abs_max(fd, 53), abs_max(fd, 54)); // ABS_MT_POSITION_X/Y
        if mx == 0 || my == 0 {
            mx = abs_max(fd, 0);
            my = abs_max(fd, 1);
        }
        log(&format!("input {dev}: abs max {mx}x{my}"));
        let tx = tx.clone();
        std::thread::spawn(move || read_device(dev, f, mx as i64, my as i64, tx));
    }
}

fn read_device(name: String, mut f: File, mx: i64, my: i64, tx: Sender<Event>) {
    let mut buf = [0u8; 16 * 32];
    let (mut x, mut y): (i64, i64) = (-1, -1);
    let mut touching = false;
    let mut power_clicks: Vec<Instant> = Vec::new();
    loop {
        let n = match f.read(&mut buf) {
            Ok(n) => n,
            Err(e) => {
                log(&format!("{name} read: {e}"));
                return;
            }
        };
        let mut i = 0;
        while i + 16 <= n {
            let typ = u16::from_le_bytes([buf[i + 8], buf[i + 9]]);
            let code = u16::from_le_bytes([buf[i + 10], buf[i + 11]]);
            let val = i32::from_le_bytes([buf[i + 12], buf[i + 13], buf[i + 14], buf[i + 15]]);
            i += 16;
            match typ {
                3 => match code {
                    53 | 0 => x = val as i64,
                    54 | 1 => y = val as i64,
                    57 => {
                        if val >= 0 {
                            touching = true;
                        } else if touching {
                            touching = false;
                            emit_tap(x, y, mx, my, &tx);
                        }
                    }
                    _ => {}
                },
                1 => {
                    if code == 330 {
                        if val == 1 {
                            touching = true;
                        } else if touching {
                            touching = false;
                            emit_tap(x, y, mx, my, &tx);
                        }
                    } else if code == KEY_POWER {
                        if val == 1 {
                            let now = Instant::now();
                            power_clicks.retain(|t| now.duration_since(*t) < RELOAD_WINDOW);
                            power_clicks.push(now);
                            if power_clicks.len() >= RELOAD_CLICKS {
                                power_clicks.clear();
                                let _ = tx.send(Event::Reload);
                            } else {
                                let _ = tx.send(Event::Key(code));
                            }
                        }
                    } else if val == 1 && code < 256 {
                        let _ = tx.send(Event::Key(code));
                    }
                }
                _ => {}
            }
        }
    }
}

fn emit_tap(x: i64, y: i64, mx: i64, my: i64, tx: &Sender<Event>) {
    if x < 0 || y < 0 {
        return;
    }
    let (sx, sy) = if mx > 0 && my > 0 { (x * SCREEN_W / (mx + 1), y * SCREEN_H / (my + 1)) } else { (x, y) };
    let _ = tx.send(Event::Tap(sx as i32, sy as i32));
}
