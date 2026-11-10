use crate::FileTime;
use std::fs;
use std::io;
use std::path::Path;

pub fn set_symlink_file_times(_p: &Path, _atime: FileTime, _mtime: FileTime) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Other, "Wasm not implemented"))
}

// wasm-experiment (bwc-vm5): WASI's filestat has the times; std exposes them through Metadata.
pub fn from_last_modification_time(meta: &fs::Metadata) -> FileTime {
    meta.modified().map(FileTime::from_system_time).unwrap_or_else(|_| FileTime::zero())
}

pub fn from_last_access_time(meta: &fs::Metadata) -> FileTime {
    meta.accessed().map(FileTime::from_system_time).unwrap_or_else(|_| FileTime::zero())
}

pub fn from_creation_time(meta: &fs::Metadata) -> Option<FileTime> {
    meta.created().ok().map(FileTime::from_system_time)
}

pub fn open(path: &Path) -> io::Result<fs::File> {
    fs::File::open(path)
}
