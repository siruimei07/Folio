//! Content-addressed PNG thumbnails in the app cache, never in the user's library.

#![allow(
    unsafe_code,
    reason = "Windows shell thumbnails and WIC encoding with owned COM interfaces"
)]

use std::collections::HashMap;
use std::fs::{self, File, FileTimes, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use folio_core::catalog::Entry;
use folio_core::hash::ContentHash;

use crate::error::AppError;
use crate::library::{io_error, lock};
use crate::open::{Apartment, PinnedEntry};

const CAPACITY: u64 = 2 * 1024 * 1024 * 1024;
const MAX_PNG_BYTES: u64 = 2 * 1024 * 1024;

pub(crate) struct Cache {
    directory: Result<PathBuf, AppError>,
    capacity: u64,
    index: Mutex<Option<HashMap<String, Cached>>>,
}

struct Cached {
    bytes: u64,
    used: SystemTime,
}

impl Cache {
    pub fn new(directory: Result<PathBuf, AppError>) -> Self {
        Self {
            directory,
            capacity: CAPACITY,
            index: Mutex::new(None),
        }
    }

    /// A PNG of at most `size` pixels (64, 128 or 256, checked by the scheme), and why the
    /// cache could not keep or refresh it: the image is served anyway, the log hears why.
    ///
    /// It is cached under the catalog's content hash while that hash is current; a file the
    /// hashing job has not read yet, or has changed since, gets a new image for each request
    /// until the job catches up (library scan §8).
    pub fn thumbnail(
        &self,
        entry: &Entry,
        pinned: &PinnedEntry,
        size: u32,
    ) -> Result<(Vec<u8>, Option<AppError>), AppError> {
        if pinned.folder {
            return Err(AppError::NotFound(
                "folders have no file thumbnail".to_owned(),
            ));
        }
        let local = pinned.local()?;
        let generate = || {
            // A local file's handler reads it: hold it against writers meanwhile. For a file
            // not on this disk, INCACHEONLY never asks a handler to read or download it; a
            // provider's existing image can be served.
            let _held = if local {
                pinned.validate()?;
                pinned.read()?
            } else {
                pinned.freeze()?
            };
            let bytes = native_png(&pinned.path, size, !local)?;
            pinned.validate()?;
            verified(bytes)
        };
        match current_hash(entry, pinned)? {
            Some(hash) => self.get_or_create(hash, size, generate),
            None => Ok((generate()?, None)),
        }
    }

    fn get_or_create(
        &self,
        hash: &ContentHash,
        size: u32,
        generate: impl FnOnce() -> Result<Vec<u8>, AppError>,
    ) -> Result<(Vec<u8>, Option<AppError>), AppError> {
        let directory = match &self.directory {
            Ok(directory) => directory,
            Err(error) => return Ok((generate()?, Some(error.clone()))),
        };
        let name = cache_file_name(hash, size);
        let path = directory.join(&name);
        match self.cached(directory, &name, &path) {
            Ok(Some(bytes)) => Ok((bytes, self.touch(directory, &name, &path).err())),
            // Made without the index lock, so misses run side by side. Two requests for the
            // same image both make it; the second rename replaces the first with the same bytes.
            Ok(None) => {
                let bytes = generate()?;
                let stored = self.store(directory, name, &path, &bytes).err();
                Ok((bytes, stored))
            }
            Err(error) => Ok((generate()?, Some(error))),
        }
    }

    /// The cached image, read outside the index lock; a missing or damaged file leaves the index.
    fn cached(
        &self,
        directory: &Path,
        name: &str,
        path: &Path,
    ) -> Result<Option<Vec<u8>>, AppError> {
        if !self.with_index(directory, |index| Ok(index.contains_key(name)))? {
            return Ok(None);
        }
        match read_png(path) {
            Ok(bytes) => return Ok(Some(bytes)),
            Err(AppError::NotFound(_)) => {}
            Err(AppError::NoThumbnail(_)) => fs::remove_file(path).map_err(io_error)?,
            Err(error) => return Err(error),
        }
        self.with_index(directory, |index| {
            index.remove(name);
            Ok(None)
        })
    }

    /// Recency survives restarts as the file's modification time.
    fn touch(&self, directory: &Path, name: &str, path: &Path) -> Result<(), AppError> {
        let now = SystemTime::now();
        OpenOptions::new()
            .write(true)
            .open(path)
            .and_then(|file| file.set_times(FileTimes::new().set_modified(now)))
            .map_err(io_error)?;
        self.with_index(directory, |index| {
            if let Some(cached) = index.get_mut(name) {
                cached.used = now;
            }
            Ok(())
        })
    }

    /// Writes through a temporary file, so no reader sees half an image.
    fn store(
        &self,
        directory: &Path,
        name: String,
        path: &Path,
        bytes: &[u8],
    ) -> Result<(), AppError> {
        if bytes.len() as u64 > self.capacity {
            return Ok(());
        }
        let temporary = directory.join(format!("{name}.{}.tmp", crate::jobs::id()?));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(io_error)?;
            file.write_all(bytes).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
            drop(file);
            fs::rename(&temporary, path).map_err(io_error)
        })();
        if result.is_err()
            && let Err(cleanup) = fs::remove_file(&temporary)
            && cleanup.kind() != std::io::ErrorKind::NotFound
        {
            return Err(AppError::FileSystem(format!(
                "cache write failed: {result:?}; cleanup failed: {cleanup}"
            )));
        }
        result?;
        self.with_index(directory, |index| {
            index.insert(
                name,
                Cached {
                    bytes: bytes.len() as u64,
                    used: SystemTime::now(),
                },
            );
            evict(directory, index, self.capacity)
        })
    }

    /// Runs `action` on the index, which is read from the directory on first use.
    fn with_index<T>(
        &self,
        directory: &Path,
        action: impl FnOnce(&mut HashMap<String, Cached>) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut guard = lock(&self.index);
        let index = match guard.take() {
            Some(index) => guard.insert(index),
            None => {
                fs::create_dir_all(directory).map_err(io_error)?;
                let index = guard.insert(load_index(directory)?);
                evict(directory, index, self.capacity)?;
                index
            }
        };
        action(index)
    }
}

fn cache_file_name(hash: &ContentHash, size: u32) -> String {
    format!("{}-{size}.png", &hash.as_str()[3..])
}

/// The catalog's hash of the file while the file is still the one the hashing job read: the
/// same size, modification time and file id (the job's own rule, library scan §8).
fn current_hash<'a>(
    entry: &'a Entry,
    pinned: &PinnedEntry,
) -> Result<Option<&'a ContentHash>, AppError> {
    let Some(hash) = &entry.record.hash else {
        return Ok(None);
    };
    let metadata = pinned.metadata()?;
    let modified = metadata.modified().ok().and_then(folio_core::fs::unix_ns);
    let same_file = entry
        .record
        .file_id
        .as_ref()
        .is_none_or(|id| *id == pinned.file_id());
    Ok(
        (metadata.len() == entry.record.size && modified == entry.record.mtime_ns && same_file)
            .then_some(hash),
    )
}

fn verified(bytes: Vec<u8>) -> Result<Vec<u8>, AppError> {
    if bytes.len() as u64 > MAX_PNG_BYTES || !valid_png(&bytes) {
        return Err(AppError::NoThumbnail("invalid or damaged PNG".to_owned()));
    }
    Ok(bytes)
}

fn load_index(directory: &Path) -> Result<HashMap<String, Cached>, AppError> {
    let mut index = HashMap::new();
    for item in fs::read_dir(directory).map_err(io_error)? {
        let item = item.map_err(io_error)?;
        let Some(name) = item.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !item.file_type().map_err(io_error)?.is_file() {
            continue;
        }
        if cache_key(&name) {
            let metadata = item.metadata().map_err(io_error)?;
            index.insert(
                name,
                Cached {
                    bytes: metadata.len(),
                    used: metadata.modified().map_err(io_error)?,
                },
            );
        } else if name.ends_with(".tmp")
            && name.split('.').next().is_some_and(|prefix| {
                // Only scratch files named by this cache, not other app-cache content.
                cache_key(&format!("{prefix}.png"))
            })
        {
            fs::remove_file(item.path()).map_err(io_error)?;
        }
    }
    Ok(index)
}

fn cache_key(name: &str) -> bool {
    let Some((hash, size)) = name
        .strip_suffix(".png")
        .and_then(|name| name.rsplit_once('-'))
    else {
        return false;
    };
    ContentHash::parse(&format!("b3:{hash}")).is_ok() && matches!(size, "64" | "128" | "256")
}

fn evict(
    directory: &Path,
    index: &mut HashMap<String, Cached>,
    capacity: u64,
) -> Result<(), AppError> {
    let mut total = index.values().map(|item| item.bytes).sum::<u64>();
    while total > capacity {
        // ponytail: linear choice only during eviction; add an ordered LRU index if profiling
        // a nearly full 2 GB cache shows this scan matters.
        let Some(key) = index
            .iter()
            .min_by_key(|(_, item)| item.used)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        match fs::remove_file(directory.join(&key)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
        if let Some(item) = index.remove(&key) {
            total = total.saturating_sub(item.bytes);
        }
    }
    Ok(())
}

fn read_png(path: &Path) -> Result<Vec<u8>, AppError> {
    let file = File::open(path).map_err(io_error)?;
    let mut bytes = Vec::new();
    file.take(MAX_PNG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    verified(bytes)
}

fn valid_png(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        && bytes.len() >= 45
        && bytes.ends_with(b"\0\0\0\0IEND\xaeB`\x82")
}

fn native_png(path: &Path, size: u32, cached_only: bool) -> Result<Vec<u8>, AppError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{E_FAIL, HGLOBAL};
    use windows::Win32::Graphics::Gdi::HPALETTE;
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat32bppBGRA,
        IWICBitmapSource, IWICImagingFactory, WICBitmapEncoderNoCache,
        WICBitmapInterpolationModeFant, WICBitmapUsePremultipliedAlpha,
    };
    use windows::Win32::System::Com::StructuredStorage::{CreateStreamOnHGlobal, IPropertyBag2};
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, CoCreateInstance, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET,
    };
    use windows::Win32::UI::Shell::{
        ISharedBitmap, IShellItem, IThumbnailCache, LocalThumbnailCache,
        SHCreateItemFromParsingName, WTS_FORCEEXTRACTION, WTS_INCACHEONLY,
    };
    use windows::core::{Interface, PCWSTR};

    let _apartment = Apartment::new()?;
    let shell_path = crate::open::shell_path(path)?;
    let path = shell_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    // SAFETY: all interface values are created/used/dropped in this apartment. The parsing
    // name is NUL-terminated; output pointers refer to initialized local Options/values.
    // ISharedBitmap owns its HBITMAP through the entire WIC copy/encode; do not DeleteObject it.
    let mut step = "shell item";
    let failed = || windows::core::Error::from_hresult(E_FAIL);
    let encode = unsafe {
        (|| -> windows::core::Result<Vec<u8>> {
            let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None)?;
            step = "thumbnail cache";
            let cache: IThumbnailCache =
                CoCreateInstance(&LocalThumbnailCache, None, CLSCTX_INPROC_SERVER)?;
            let mut shared: Option<ISharedBitmap> = None;
            // Force extraction: Explorer's own cache is keyed by path and time, and can hold an
            // image of earlier content.
            step = "extract thumbnail";
            cache.GetThumbnail(
                &item,
                size,
                if cached_only {
                    WTS_INCACHEONLY
                } else {
                    WTS_FORCEEXTRACTION
                },
                Some(&mut shared),
                None,
                None,
            )?;
            let shared = shared.ok_or_else(failed)?;
            step = "WIC bitmap";
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let bitmap = factory.CreateBitmapFromHBITMAP(
                shared.GetSharedBitmap()?,
                HPALETTE::default(),
                WICBitmapUsePremultipliedAlpha,
            )?;
            let mut source: IWICBitmapSource = bitmap.cast()?;
            let (mut width, mut height) = (0, 0);
            source.GetSize(&mut width, &mut height)?;
            if width == 0 || height == 0 || width > 4096 || height > 4096 {
                return Err(failed());
            }
            if width.max(height) > size {
                let scaler = factory.CreateBitmapScaler()?;
                let longest = width.max(height);
                width = (width * size / longest).max(1);
                height = (height * size / longest).max(1);
                scaler.Initialize(&source, width, height, WICBitmapInterpolationModeFant)?;
                source = scaler.cast()?;
            }
            step = "PNG encoder";
            let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)?;
            let encoder = factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null())?;
            encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
            let mut frame = None;
            step = "PNG frame";
            encoder.CreateNewFrame(&mut frame, std::ptr::null_mut())?;
            let frame = frame.ok_or_else(failed)?;
            step = "PNG frame initialize";
            frame.Initialize(None::<&IPropertyBag2>)?;
            frame.SetSize(width, height)?;
            let mut pixel_format = GUID_WICPixelFormat32bppBGRA;
            frame.SetPixelFormat(&mut pixel_format)?;
            step = "PNG source";
            frame.WriteSource(&source, std::ptr::null())?;
            frame.Commit()?;
            encoder.Commit()?;
            step = "PNG bytes";
            let mut stat = STATSTG::default();
            stream.Stat(&mut stat, STATFLAG_NONAME)?;
            if stat.cbSize > MAX_PNG_BYTES {
                return Err(failed());
            }
            let mut bytes = vec![0_u8; stat.cbSize as usize];
            stream.Seek(0, STREAM_SEEK_SET, None)?;
            let mut read = 0;
            stream
                .Read(
                    bytes.as_mut_ptr().cast(),
                    bytes.len() as u32,
                    Some(&mut read),
                )
                .ok()?;
            bytes.truncate(read as usize);
            Ok(bytes)
        })()
    };
    encode.map_err(|error| native_error(step, error, cached_only))
}

fn native_error(step: &str, error: windows::core::Error, cached_only: bool) -> AppError {
    let detail = format!("{step}: {error}");
    // Cached-only extraction never reads the file, so a missing image means it is not on this
    // disk; otherwise Windows has no handler for the type, or the file is damaged.
    let unavailable: fn(String) -> AppError = if cached_only {
        AppError::NotLocal
    } else {
        AppError::NoThumbnail
    };
    match error.code().0 as u32 {
        0x80070002 | 0x80070003 => AppError::NotFound(detail),
        0x80070005 => AppError::AccessDenied(detail),
        0x80070020 | 0x80070021 => AppError::InUse(detail),
        // STG_E_FILENOTFOUND: the live cached-only API reports a missing cache stream this way.
        0x80030002 if step == "extract thumbnail" => unavailable(detail),
        // WTS_E_*: the thumbnail cache has no image and cannot make one.
        0x8004B200..=0x8004B207 => unavailable(detail),
        _ => AppError::FileSystem(detail),
    }
}

#[cfg(test)]
mod tests;
