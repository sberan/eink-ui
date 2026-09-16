//! Direct e-ink output for i.MX6 Kindles (Voyage/PW2/PW3...): mmap /dev/fb0 and drive the
//! EPDC with MXCFB_SEND_UPDATE. No FBInk. Region-only updates with the requested waveform.
use anyhow::{anyhow, Context, Result};
use std::{fs::File, os::unix::io::AsRawFd};

const FBIOGET_VSCREENINFO: libc::c_ulong = 0x4600;
const FBIOGET_FSCREENINFO: libc::c_ulong = 0x4602;
const FBIOBLANK: libc::c_ulong = 0x4611;
// _IOW('F', 0x2E, struct mxcfb_update_data /* 72 bytes */)
const MXCFB_SEND_UPDATE: libc::c_ulong = 0x4048_462E;
// _IOWR('F', 0x2F, struct mxcfb_update_marker_data /* 8 bytes */)
const MXCFB_WAIT_FOR_UPDATE_COMPLETE: libc::c_ulong = 0xC008_462F;

pub const WAVEFORM_DU: u32 = 1;
pub const WAVEFORM_GC16: u32 = 2;
#[allow(dead_code)]
pub const WAVEFORM_GC16_FAST: u32 = 3;
#[allow(dead_code)]
pub const WAVEFORM_A2: u32 = 4;
pub const WAVEFORM_AUTO: u32 = 257;
const UPDATE_MODE_PARTIAL: u32 = 0;
const UPDATE_MODE_FULL: u32 = 1;
const TEMP_USE_AMBIENT: i32 = 0x1000;
const GRAYSCALE_8BIT_INVERTED: u32 = 2;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct Bitfield {
    offset: u32,
    length: u32,
    msb_right: u32,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct FbVarScreeninfo {
    xres: u32,
    yres: u32,
    xres_virtual: u32,
    yres_virtual: u32,
    xoffset: u32,
    yoffset: u32,
    bits_per_pixel: u32,
    grayscale: u32,
    red: Bitfield,
    green: Bitfield,
    blue: Bitfield,
    transp: Bitfield,
    nonstd: u32,
    activate: u32,
    height: u32,
    width: u32,
    accel_flags: u32,
    pixclock: u32,
    left_margin: u32,
    right_margin: u32,
    upper_margin: u32,
    lower_margin: u32,
    hsync_len: u32,
    vsync_len: u32,
    sync: u32,
    vmode: u32,
    rotate: u32,
    colorspace: u32,
    reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct FbFixScreeninfo {
    id: [u8; 16],
    smem_start: libc::c_ulong,
    smem_len: u32,
    type_: u32,
    type_aux: u32,
    visual: u32,
    xpanstep: u16,
    ypanstep: u16,
    ywrapstep: u16,
    line_length: u32,
    mmio_start: libc::c_ulong,
    mmio_len: u32,
    accel: u32,
    capabilities: u16,
    reserved: [u16; 2],
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct MxcfbRect {
    top: u32,
    left: u32,
    width: u32,
    height: u32,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct MxcfbAltBufferData {
    phys_addr: u32,
    width: u32,
    height: u32,
    alt_update_region: MxcfbRect,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct MxcfbUpdateData {
    update_region: MxcfbRect,
    waveform_mode: u32,
    update_mode: u32,
    update_marker: u32,
    hist_bw_waveform_mode: u32,
    hist_gray_waveform_mode: u32,
    temp: i32,
    flags: u32,
    alt_buffer_data: MxcfbAltBufferData,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct MxcfbUpdateMarkerData {
    update_marker: u32,
    collision_test: u32,
}

pub struct Epdc {
    file: File,
    mem: *mut u8,
    len: usize,
    pub xres: u32,
    pub yres: u32,
    line_length: usize,
    bpp: u32,
    inverted: bool,
    marker: u32,
}

impl Epdc {
    pub fn open() -> Result<Self> {
        let file = File::options().read(true).write(true).open("/dev/fb0").context("open /dev/fb0")?;
        let fd = file.as_raw_fd();
        let mut vi = FbVarScreeninfo::default();
        if unsafe { libc::ioctl(fd, FBIOGET_VSCREENINFO as _, &mut vi as *mut _) } < 0 {
            return Err(anyhow!("FBIOGET_VSCREENINFO failed"));
        }
        let mut fi: FbFixScreeninfo = unsafe { std::mem::zeroed() };
        if unsafe { libc::ioctl(fd, FBIOGET_FSCREENINFO as _, &mut fi as *mut _) } < 0 {
            return Err(anyhow!("FBIOGET_FSCREENINFO failed"));
        }
        let len = fi.smem_len as usize;
        let mem = unsafe { libc::mmap(std::ptr::null_mut(), len, libc::PROT_READ | libc::PROT_WRITE, libc::MAP_SHARED, fd, 0) };
        if mem == libc::MAP_FAILED {
            return Err(anyhow!("mmap /dev/fb0 failed"));
        }
        assert_eq!(std::mem::size_of::<MxcfbUpdateData>(), 72, "mxcfb_update_data layout");
        Ok(Epdc {
            file,
            mem: mem as *mut u8,
            len,
            xres: vi.xres,
            yres: vi.yres,
            line_length: fi.line_length as usize,
            bpp: vi.bits_per_pixel,
            inverted: vi.bits_per_pixel == 8 && vi.grayscale == GRAYSCALE_8BIT_INVERTED,
            marker: 1,
        })
    }

    pub fn describe(&self) -> String {
        format!("fb {}x{} {}bpp stride {} inverted={} len={}", self.xres, self.yres, self.bpp, self.line_length, self.inverted, self.len)
    }

    /// Copy a Y8 (0 = black) region into the framebuffer at (x, y).
    pub fn blit_gray(&mut self, data: &[u8], w: u32, h: u32, x: u32, y: u32) -> Result<()> {
        if self.bpp != 8 {
            return Err(anyhow!("unsupported framebuffer depth {}bpp", self.bpp));
        }
        let w_clip = w.min(self.xres.saturating_sub(x));
        let h_clip = h.min(self.yres.saturating_sub(y));
        for row in 0..h_clip as usize {
            let src = &data[row * w as usize..row * w as usize + w_clip as usize];
            let off = (y as usize + row) * self.line_length + x as usize;
            if off + w_clip as usize > self.len {
                break;
            }
            let dst = unsafe { std::slice::from_raw_parts_mut(self.mem.add(off), w_clip as usize) };
            if self.inverted {
                for (d, s) in dst.iter_mut().zip(src) {
                    *d = 255 - *s;
                }
            } else {
                dst.copy_from_slice(src);
            }
        }
        Ok(())
    }

    /// Ask the EPDC to refresh a region. `full` = flashing GC16 full update; otherwise a
    /// partial update with the given waveform (DU for text/boxes, AUTO to let the EPDC pick).
    pub fn refresh(&mut self, x: u32, y: u32, w: u32, h: u32, waveform: u32, full: bool, wait: bool) -> Result<u32> {
        let marker = self.marker;
        self.marker = self.marker.wrapping_add(1).max(1);
        let mut upd = MxcfbUpdateData {
            update_region: MxcfbRect { top: y, left: x, width: w.min(self.xres - x.min(self.xres)), height: h.min(self.yres - y.min(self.yres)) },
            waveform_mode: if full { WAVEFORM_GC16 } else { waveform },
            update_mode: if full { UPDATE_MODE_FULL } else { UPDATE_MODE_PARTIAL },
            update_marker: marker,
            hist_bw_waveform_mode: WAVEFORM_DU,
            hist_gray_waveform_mode: WAVEFORM_GC16_FAST,
            temp: TEMP_USE_AMBIENT,
            flags: 0,
            alt_buffer_data: MxcfbAltBufferData::default(),
        };
        let fd = self.file.as_raw_fd();
        if unsafe { libc::ioctl(fd, MXCFB_SEND_UPDATE as _, &mut upd as *mut _) } < 0 {
            return Err(anyhow!("MXCFB_SEND_UPDATE failed: {}", std::io::Error::last_os_error()));
        }
        if wait {
            let mut md = MxcfbUpdateMarkerData { update_marker: marker, collision_test: 0 };
            let _ = unsafe { libc::ioctl(fd, MXCFB_WAIT_FOR_UPDATE_COMPLETE as _, &mut md as *mut _) };
        }
        Ok(marker)
    }

    pub fn unblank(&mut self) {
        let _ = unsafe { libc::ioctl(self.file.as_raw_fd(), FBIOBLANK as _, 0 as libc::c_int) };
    }

    /// Paint the whole panel white and flash it.
    #[allow(dead_code)]
    pub fn clear(&mut self) -> Result<()> {
        let fill = if self.inverted { 0u8 } else { 255u8 };
        unsafe { std::ptr::write_bytes(self.mem, fill, self.len) };
        self.refresh(0, 0, self.xres, self.yres, WAVEFORM_GC16, true, true)?;
        Ok(())
    }
}

impl Drop for Epdc {
    fn drop(&mut self) {
        unsafe { libc::munmap(self.mem as *mut _, self.len) };
    }
}
