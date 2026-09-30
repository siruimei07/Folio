use std::time::Duration;

use folio_core::meta::EntryKind;

use super::*;
use crate::open::tests::{entry, set_offline};

fn png() -> Vec<u8> {
    // A complete 1x1 PNG; cache tests never ask a renderer to interpret its pixels.
    vec![
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4,
        0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3, 3,
        2, 0, 239, 151, 249, 95, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]
}

#[test]
fn cache_reuses_content_hash_and_size_and_evicts_the_least_recently_used_across_restart() {
    let temp = tempfile::tempdir().unwrap();
    let a = ContentHash::of(b"same content in different entries");
    let b = ContentHash::of(b"other content");
    let c = ContentHash::of(b"new content");
    let cache = Cache::new(Ok(temp.path().to_path_buf()));
    let (bytes, _) = cache.get_or_create(&a, 64, || Ok(png())).unwrap();
    assert_eq!(
        cache
            .get_or_create(&a, 64, || panic!("cache hit generated again"))
            .unwrap(),
        (bytes.clone(), None)
    );
    cache.get_or_create(&a, 128, || Ok(png())).unwrap();
    assert!(temp.path().join(cache_file_name(&a, 64)).is_file());
    assert!(temp.path().join(cache_file_name(&a, 128)).is_file());
    fs::remove_file(temp.path().join(cache_file_name(&a, 128))).unwrap();
    cache.get_or_create(&b, 64, || Ok(png())).unwrap();
    for (hash, seconds) in [(&a, 1), (&b, 2)] {
        File::options()
            .write(true)
            .open(temp.path().join(cache_file_name(hash, 64)))
            .unwrap()
            .set_times(
                FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)),
            )
            .unwrap();
    }
    drop(cache);
    let mut cache = Cache::new(Ok(temp.path().to_path_buf()));
    cache.capacity = bytes.len() as u64 * 2;
    cache
        .get_or_create(&a, 64, || panic!("restart lost cache hit"))
        .unwrap();
    cache.get_or_create(&c, 64, || Ok(png())).unwrap();
    assert!(temp.path().join(cache_file_name(&a, 64)).is_file());
    assert!(!temp.path().join(cache_file_name(&b, 64)).exists());
    assert!(temp.path().join(cache_file_name(&c, 64)).is_file());
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
}

#[test]
fn damaged_images_and_interrupted_writes_are_not_cache_hits() {
    let temp = tempfile::tempdir().unwrap();
    let hash = ContentHash::of(b"document");
    let path = temp.path().join(cache_file_name(&hash, 256));
    fs::write(&path, b"incomplete PNG").unwrap();
    let scratch = temp
        .path()
        .join(format!("{}.old.tmp", cache_file_name(&hash, 64)));
    fs::write(&scratch, b"unfinished").unwrap();
    fs::write(temp.path().join("unrelated.tmp"), b"keep").unwrap();
    let cache = Cache::new(Ok(temp.path().to_path_buf()));
    assert_eq!(
        cache.get_or_create(&hash, 256, || Ok(png())).unwrap(),
        (png(), None)
    );
    assert_eq!(fs::read(&path).unwrap(), png());
    assert!(!scratch.exists());
    assert!(temp.path().join("unrelated.tmp").exists());
    assert!(!cache_key("../../secret.png"));
    assert!(!cache_key(&cache_file_name(&hash, 32)));
    let missing = ContentHash::of(b"unknown handler");
    assert!(matches!(
        cache.get_or_create(&missing, 64, || Err(AppError::NoThumbnail(
            "no handler".into()
        ))),
        Err(AppError::NoThumbnail(_))
    ));
    assert!(!temp.path().join(cache_file_name(&missing, 64)).exists());
    let failure = |code| windows::core::Error::from_hresult(windows::core::HRESULT(code));
    assert!(matches!(
        native_error("thumbnail cache", failure(0x80040154_u32 as i32), false),
        AppError::FileSystem(_)
    ));
    assert!(matches!(
        native_error("extract thumbnail", failure(0x8004B200_u32 as i32), false),
        AppError::NoThumbnail(_)
    ));
    assert!(matches!(
        native_error("extract thumbnail", failure(0x8004B200_u32 as i32), true),
        AppError::NotLocal(_)
    ));
}

fn bmp(red: u8) -> Vec<u8> {
    let mut bytes = vec![0_u8; 70];
    bytes[..2].copy_from_slice(b"BM");
    bytes[2..6].copy_from_slice(&70_u32.to_le_bytes());
    bytes[10..14].copy_from_slice(&54_u32.to_le_bytes());
    bytes[14..18].copy_from_slice(&40_u32.to_le_bytes());
    bytes[18..22].copy_from_slice(&2_i32.to_le_bytes());
    bytes[22..26].copy_from_slice(&2_i32.to_le_bytes());
    bytes[26..28].copy_from_slice(&1_u16.to_le_bytes());
    bytes[28..30].copy_from_slice(&24_u16.to_le_bytes());
    bytes[34..38].copy_from_slice(&16_u32.to_le_bytes());
    for start in [54, 57, 62, 65] {
        bytes[start..start + 3].copy_from_slice(&[0, 0, red]);
    }
    bytes
}

#[test]
fn offline_files_use_known_hash_cache_hits_and_do_not_extract_a_missing_thumbnail() {
    use std::os::windows::fs::OpenOptionsExt;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let source = root.join("source.folio-no-thumbnail");
    let content = b"kept offline";
    fs::write(&source, content).unwrap();
    let hash = ContentHash::of(content);
    let cache_dir = temp.path().join("app-cache");
    let cache = Cache::new(Ok(cache_dir.clone()));
    cache.get_or_create(&hash, 64, || Ok(png())).unwrap();
    // Only this test's disposable local file is marked offline, with no provider.
    set_offline(&source, true);
    let mut entry = entry("source.folio-no-thumbnail", EntryKind::File);
    entry.record.size = content.len() as u64;
    entry.record.mtime_ns = modified_ns(&source);
    entry.record.hash = Some(hash);
    let pinned = PinnedEntry::resolve(&root, &entry).unwrap();
    let exclusive = File::options()
        .read(true)
        .share_mode(0)
        .open(&source)
        .unwrap();
    assert!(matches!(pinned.read(), Err(AppError::NotLocal(_))));
    // The library file denies all data readers: an app-cache hit still succeeds.
    assert_eq!(cache.thumbnail(&entry, &pinned, 64).unwrap(), (png(), None));
    drop(exclusive);
    entry.record.hash = None;
    let missing = cache.thumbnail(&entry, &pinned, 64);
    assert!(matches!(missing, Err(AppError::NotLocal(_))), "{missing:?}");
    assert!(!pinned.local().unwrap());
    assert_eq!(fs::read_dir(cache_dir).unwrap().count(), 1);
    drop(pinned);
    set_offline(&source, false);
    assert_eq!(fs::read(source).unwrap(), content);
}

fn modified_ns(path: &Path) -> Option<i64> {
    folio_core::fs::unix_ns(fs::metadata(path).unwrap().modified().unwrap())
}

#[test]
fn native_png_is_cached_under_the_current_catalog_hash_only() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let cache_dir = temp.path().join("app-cache");
    let cache = Cache::new(Ok(cache_dir.clone()));
    let original = bmp(255);
    fs::write(root.join("image.bmp"), &original).unwrap();
    fs::write(root.join("same.bmp"), &original).unwrap();
    // What the hashing job stored for each file.
    let hashed = |name: &str| {
        let mut entry = entry(name, EntryKind::File);
        entry.record.size = original.len() as u64;
        entry.record.mtime_ns = modified_ns(&root.join(name));
        entry.record.hash = Some(ContentHash::of(&original));
        entry
    };
    let thumbnail = |entry: &Entry| {
        let (image, cache_error) = cache
            .thumbnail(entry, &PinnedEntry::resolve(&root, entry).unwrap(), 64)
            .unwrap();
        assert!(cache_error.is_none(), "{cache_error:?}");
        image
    };
    let entry = hashed("image.bmp");
    let image = thumbnail(&entry);
    assert!(valid_png(&image));
    assert!(u32::from_be_bytes(image[16..20].try_into().unwrap()) <= 64);
    let cached = cache_dir.join(cache_file_name(&ContentHash::of(&original), 64));
    assert!(cached.is_file());
    // The same content in another file is the same cache entry.
    assert_eq!(thumbnail(&hashed("same.bmp")), image);
    assert_eq!(fs::read_dir(&cache_dir).unwrap().count(), 1);

    // An edit changes the modification time: the stored hash is stale until the hashing job
    // reads the file again, so the image is made from the file and not cached.
    let changed = bmp(0);
    fs::write(root.join("image.bmp"), &changed).unwrap();
    File::options()
        .write(true)
        .open(root.join("image.bmp"))
        .unwrap()
        .set_times(FileTimes::new().set_modified(SystemTime::now() + Duration::from_secs(5)))
        .unwrap();
    let changed_image = thumbnail(&entry);
    assert!(valid_png(&changed_image));
    assert_ne!(changed_image, image, "a stale hash served the old image");
    let mut unhashed = hashed("image.bmp");
    unhashed.record.hash = None;
    assert_eq!(thumbnail(&unhashed), changed_image);
    assert_eq!(fs::read_dir(&cache_dir).unwrap().count(), 1);
    assert_eq!(fs::read(&cached).unwrap(), image);
    assert!(!root.join("thumbnails").exists());
}
