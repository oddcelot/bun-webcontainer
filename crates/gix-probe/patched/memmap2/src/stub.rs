// wasm-experiment (bwc-vm5): platforms without mmap (WASI) get a copy of the file's bytes instead of a mapping.
// Fine for gix, which only maps read-only (git never rewrites a file in place). Writable maps don't flush back.
use std::fs::File;
use std::io;

pub struct MmapInner {
    buf: Box<[u8]>,
}

fn read(len: usize, file: &File, offset: u64) -> io::Result<MmapInner> {
    let mut buf = vec![0u8; len].into_boxed_slice();
    // A real mapping leaves the file position alone; callers (gix-index) read the same handle afterwards.
    use std::io::{Read, Seek, SeekFrom};
    let mut f = file; // &File is Read + Seek
    let pos = f.stream_position()?;
    f.seek(SeekFrom::Start(offset))?;
    let read = f.read_exact(&mut buf);
    f.seek(SeekFrom::Start(pos))?;
    read?;
    Ok(MmapInner { buf })
}

impl MmapInner {
    pub fn map(len: usize, f: &File, off: u64, _: bool, _: bool, _: bool) -> io::Result<MmapInner> {
        read(len, f, off)
    }
    pub fn map_exec(len: usize, f: &File, off: u64, _: bool, _: bool, _: bool) -> io::Result<MmapInner> {
        read(len, f, off)
    }
    pub fn map_mut(len: usize, f: &File, off: u64, _: bool, _: bool, _: bool) -> io::Result<MmapInner> {
        read(len, f, off)
    }
    pub fn map_copy(len: usize, f: &File, off: u64, _: bool, _: bool, _: bool) -> io::Result<MmapInner> {
        read(len, f, off)
    }
    pub fn map_copy_read_only(len: usize, f: &File, off: u64, _: bool, _: bool, _: bool) -> io::Result<MmapInner> {
        read(len, f, off)
    }
    pub fn map_anon(len: usize, _: bool, _: bool, _: Option<u8>, _: bool) -> io::Result<MmapInner> {
        Ok(MmapInner { buf: vec![0u8; len].into_boxed_slice() })
    }
    pub fn flush(&self, _: usize, _: usize) -> io::Result<()> {
        Err(io::ErrorKind::Unsupported.into())
    }
    pub fn flush_async(&self, _: usize, _: usize) -> io::Result<()> {
        Err(io::ErrorKind::Unsupported.into())
    }
    pub fn make_read_only(&mut self) -> io::Result<()> {
        Ok(())
    }
    pub fn make_exec(&mut self) -> io::Result<()> {
        Ok(())
    }
    pub fn make_mut(&mut self) -> io::Result<()> {
        Ok(())
    }
    #[inline]
    pub fn ptr(&self) -> *const u8 {
        self.buf.as_ptr()
    }
    #[inline]
    pub fn mut_ptr(&mut self) -> *mut u8 {
        self.buf.as_mut_ptr()
    }
    #[inline]
    pub fn len(&self) -> usize {
        self.buf.len()
    }
    #[allow(clippy::unnecessary_wraps)]
    pub fn check_safe_to_map(_file: &File, _offset: u64, _len: usize) -> Result<(), crate::MapIfSafeError> {
        Ok(())
    }
}

pub fn file_len(file: &File) -> io::Result<u64> {
    Ok(file.metadata()?.len())
}
