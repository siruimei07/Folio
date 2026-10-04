//! A probe for the iCloud field test (docs/research/icloud-field-test/plan.md). It runs Folio's own
//! watcher, folder listing, atomic write and Recycle Bin against a folder in iCloud Drive and prints
//! what they report as JSON lines, one per event, each with the time in Unix milliseconds. Not part
//! of the app; the Python harness next to the plan drives it.
//!
//! ```text
//! icloud_probe watch <folder>                      Folio's watcher; lists what each rescan names
//! icloud_probe list <folder>                       Folio's listing of everything below <folder>
//! icloud_probe publish <staging> <target> <source>      staged write, then std::fs::rename over
//!                                                      <target>, as files::write_atomically does
//! icloud_probe publish-new <staging> <target> <source>  staged write, then rename_no_replace
//! icloud_probe recycle <path>                      WindowsRecycleBin
//! ```

#[cfg(windows)]
fn main() -> std::process::ExitCode {
    probe::main()
}

#[cfg(not(windows))]
fn main() {
    eprintln!("icloud_probe runs on Windows only");
}

#[cfg(windows)]
mod probe {
    use std::fs;
    use std::io::{self, Write};
    use std::path::{Path, PathBuf};
    use std::process::ExitCode;
    use std::sync::mpsc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use folio_core::fs::{DirEntry, FileKind, FileSystem, Metadata};
    use folio_core::recycle::RecycleBin;
    use folio_core::watch::{Rescan, WatchOptions};
    use folio_core::win::{
        WatchEvent, Watcher, WindowsFileSystem, WindowsRecycleBin, rename_no_replace,
    };
    use serde_json::{Value, json};

    /// Listings stop this deep below the folder they start in.
    const MAX_DEPTH: usize = 8;

    pub fn main() -> ExitCode {
        let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
        let command = args.first().and_then(|command| command.to_str());
        let result = match (command, &args[1.min(args.len())..]) {
            (Some("watch"), [folder]) => watch(folder),
            (Some("list"), [folder]) => list(folder),
            (Some("publish"), [staging, target, source]) => publish(staging, target, source, true),
            (Some("publish-new"), [staging, target, source]) => {
                publish(staging, target, source, false)
            }
            (Some("recycle"), [path]) => recycle(path),
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "usage: icloud_probe watch|list <folder> | publish|publish-new <staging> <target> <source> | recycle <path>",
            )),
        };
        match result {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                emit(
                    json!({ "event": "error", "error": error.to_string(), "os": error.raw_os_error() }),
                );
                ExitCode::FAILURE
            }
        }
    }

    /// Prints one JSON line with the current time added.
    fn emit(mut value: Value) {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis());
        value["t_ms"] = json!(ms.to_string());
        let mut out = io::stdout().lock();
        // A closed stdout ends the probe at its next write; nothing else is worth reporting.
        let _ = writeln!(out, "{value}").and_then(|()| out.flush());
    }

    fn watch(folder: &Path) -> io::Result<()> {
        let files = WindowsFileSystem::open(folder)?;
        let options = WatchOptions::new(files.has_file_ids());
        emit(json!({
            "event": "watch-start",
            "folder": folder.display().to_string(),
            "file_ids": files.has_file_ids(),
            "local_ntfs": files.volume().is_local_ntfs(),
        }));
        let (sender, receiver) = mpsc::channel();
        let _watcher = Watcher::start(folder, options, move |event| {
            // The receiver lives as long as the watcher.
            let _ = sender.send(event);
        })?;
        for event in receiver {
            match event {
                WatchEvent::Rescan(Rescan::Full) => {
                    emit(json!({ "event": "rescan", "scope": "full" }));
                    emit_listing(&files, folder, folder, 0);
                }
                WatchEvent::Rescan(Rescan::Metadata) => {
                    emit(json!({ "event": "rescan", "scope": "metadata" }));
                }
                WatchEvent::Rescan(Rescan::Scopes(scopes)) => {
                    let names: Vec<String> = scopes
                        .iter()
                        .map(|scope| scope.names().collect::<Vec<_>>().join("/"))
                        .collect();
                    emit(json!({ "event": "rescan", "scope": names }));
                    for scope in &scopes {
                        let path = scope.to_native(folder);
                        match files.metadata(&path) {
                            Ok(metadata) => {
                                emit(entry_json(folder, &path, &metadata));
                                if metadata.kind == FileKind::Folder {
                                    emit_listing(&files, folder, &path, 1);
                                }
                            }
                            Err(error) => emit(json!({
                                "event": "gone",
                                "path": relative(folder, &path),
                                "error": error.to_string(),
                            })),
                        }
                    }
                }
                WatchEvent::Failed(error) => {
                    emit(json!({ "event": "watch-failed", "error": error.to_string() }));
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    fn list(folder: &Path) -> io::Result<()> {
        let files = WindowsFileSystem::open(folder)?;
        emit_listing(&files, folder, folder, 0);
        Ok(())
    }

    /// Emits every entry below `folder`, depth first, and a line for each folder that fails.
    fn emit_listing(files: &WindowsFileSystem, root: &Path, folder: &Path, depth: usize) {
        let entries: Vec<DirEntry> = match files.read_dir(folder) {
            Ok(entries) => entries,
            Err(error) => {
                emit(json!({
                    "event": "list-failed",
                    "path": relative(root, folder),
                    "error": error.to_string(),
                }));
                return;
            }
        };
        for entry in entries {
            let path = folder.join(&entry.name);
            emit(entry_json(root, &path, &entry.metadata));
            if entry.metadata.kind == FileKind::Folder && depth < MAX_DEPTH {
                emit_listing(files, root, &path, depth + 1);
            }
        }
    }

    fn entry_json(root: &Path, path: &Path, metadata: &Metadata) -> Value {
        json!({
            "event": "entry",
            "path": relative(root, path),
            "kind": format!("{:?}", metadata.kind),
            "size": metadata.size.to_string(),
            "presence": format!("{:?}", metadata.presence),
            "file_id": metadata.file_id,
            "modified_ns": metadata.modified_ns.map(|ns| ns.to_string()),
        })
    }

    /// `path` below `root` with `/` separators, or the whole path when it is not below.
    fn relative(root: &Path, path: &Path) -> String {
        path.strip_prefix(root).map_or_else(
            |_| path.display().to_string(),
            |rest| {
                rest.iter()
                    .map(|name| name.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/")
            },
        )
    }

    fn publish(staging: &Path, target: &Path, source: &Path, replace: bool) -> io::Result<()> {
        let bytes = fs::read(source)?;
        emit(json!({
            "event": "publish-start",
            "target": target.display().to_string(),
            "bytes": bytes.len().to_string(),
            "replace": replace,
        }));
        // `files::write_atomically` is private to the crate; this is its sequence: a new file in
        // staging, `sync_all`, then one rename.
        fs::create_dir_all(staging)?;
        let temp = staging.join(format!("probe-{}.part", std::process::id()));
        let written = (|| {
            let mut file = fs::File::create(&temp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            if replace {
                fs::rename(&temp, target)
            } else {
                rename_no_replace(&temp, target)
            }
        })();
        if let Err(error) = written {
            // Leaves nothing in staging; the write or rename error is the one worth reporting.
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
        emit(json!({ "event": "publish-done", "target": target.display().to_string() }));
        Ok(())
    }

    fn recycle(path: &Path) -> io::Result<()> {
        emit(json!({ "event": "recycle-start", "path": path.display().to_string() }));
        WindowsRecycleBin
            .recycle(path)
            .map_err(|error| io::Error::other(format!("{error:?}")))?;
        emit(json!({ "event": "recycle-done", "path": path.display().to_string() }));
        Ok(())
    }
}
