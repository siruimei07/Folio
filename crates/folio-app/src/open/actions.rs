//! Captured Windows application plans: the library entry is always data, never a command.

use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf, Prefix};
use std::process::{Command, Stdio};

use windows::Win32::Data::Xml::MsXml::{DOMDocument60, IXMLDOMDocument2, IXMLDOMNode};
use windows::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HLOCAL, LocalFree, PROPERTYKEY,
};
use windows::Win32::Storage::Packaging::Appx::{
    FindPackagesByPackageFamily, GetPackagePathByFullName, PACKAGE_FILTER_DIRECT,
    PACKAGE_FILTER_HEAD, ParseApplicationUserModelId,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, CLSCTX_LOCAL_SERVER, CoAllowSetForegroundWindow, CoCreateInstance,
    CoTaskMemFree, IBindCtx,
};
use windows::Win32::System::Registry::{
    HKEY, KEY_READ, RRF_RT_REG_SZ, RegCloseKey, RegGetValueW, RegOpenKeyExW,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    ASSOCF_INIT_IGNOREUNKNOWN, ASSOCF_NOFIXUPS, ASSOCF_NOTRUNCATE, ASSOCKEY_CLASS, ASSOCSTR,
    ASSOCSTR_APPID, ASSOCSTR_COMMAND, ASSOCSTR_DELEGATEEXECUTE, ASSOCSTR_DROPTARGET,
    ASSOCSTR_EXECUTABLE, ApplicationActivationManager, AssocQueryKeyW, AssocQueryStringW,
    CommandLineToArgvW, FOLDERID_Windows, IApplicationActivationManager, IShellItem2,
    KF_FLAG_DEFAULT, SHCreateItemFromParsingName, SHCreateMemStream,
    SHCreateShellItemArrayFromIDLists, SHGetKnownFolderPath, SHOpenFolderAndSelectItems,
    SHParseDisplayName,
};
use windows::core::{BSTR, GUID, IUnknown, Interface, PCWSTR, PWSTR, w};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_NO_RECALL,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, GetFileAttributesW, INVALID_FILE_ATTRIBUTES,
};

use crate::error::AppError;
use crate::ipc::entries::{OpenMode, Opened};

const MAX_COMMAND_UNITS: usize = 32_768;
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;

// System.AppUserModel.ID, as defined by the Windows property schema.
const APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 5,
};

pub(crate) fn open(entry: &super::PinnedEntry) -> Result<Opened, AppError> {
    let _apartment = super::Apartment::new()?;
    if entry.folder {
        // Use the OS's Windows directory, not a mutable environment variable or association.
        // SAFETY: the GUID and flags are valid; COM is initialized on this thread.
        let directory = unsafe { SHGetKnownFolderPath(&FOLDERID_Windows, KF_FLAG_DEFAULT, None) }
            .map_err(native_error)?;
        if directory.is_null() {
            return Err(AppError::FileSystem(
                "Windows returned no system directory".into(),
            ));
        }
        let directory = TaskMem(directory.as_ptr().cast());
        // SAFETY: SHGetKnownFolderPath returned a live, NUL-terminated UTF-16 allocation.
        let directory = unsafe { PWSTR(directory.0.cast()).to_string() }
            .map_err(|error| AppError::FileSystem(format!("Windows directory: {error}")))?;
        let executable = PathBuf::from(directory).join("explorer.exe");
        let (executable, guards) = pin_executable(&executable).map_err(|error| {
            AppError::Blocked(format!(
                "the system Explorer could not be verified: {error}"
            ))
        })?;
        let _frozen = entry.freeze()?;
        // Explorer splits an argument at commas unless it is quoted; a path has no quotes.
        let mut folder = OsString::from("\"");
        folder.push(super::shell_path(&entry.path)?);
        folder.push("\"");
        validate_app_guards(&guards)?;
        spawn(&executable, |command| command.raw_arg(&folder))?;
        entry.validate()?;
        return Ok(Opened {
            mode: OpenMode::Default,
        });
    }

    let extension = entry
        .path
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
        .ok_or_else(|| AppError::Blocked("no explicit file association".into()))?;
    let association = format!(".{extension}");
    let (plan, mode) = select_plan(
        extension,
        || association_plan(&association, None),
        || association_plan(&association, Some("edit")),
    )
    .map_err(|reason| {
        AppError::Blocked(format!(
            "no verified default app or editor for {association}: {reason}"
        ))
    })?;
    match &plan {
        LaunchPlan::Static {
            command,
            _guards: guards,
        } => {
            validate_app_guards(guards)?;
            // `freeze` checked that the entry is still at its pinned, canonical path.
            let _frozen = entry.freeze()?;
            if entry.path == command.executable {
                return Err(AppError::Blocked(
                    "the entry cannot be its own opening program".into(),
                ));
            }
            let arguments = command.args(super::shell_path(&entry.path)?.as_os_str());
            // The executable, ancestors, and entry stay guarded through CreateProcess.
            spawn(&command.executable, |process| process.args(arguments))?;
            entry.validate()?;
        }
        LaunchPlan::Packaged {
            aumid,
            verb,
            store,
            _guards: guards,
            ..
        } => activate_for_file(aumid, verb, store, guards, entry)?,
    }
    Ok(Opened { mode })
}

pub(crate) fn reveal(entry: &super::PinnedEntry) -> Result<(), AppError> {
    let _apartment = super::Apartment::new()?;
    let _entry_guard = entry.freeze()?;
    let item = shell_item_id(&entry.path)?;
    // SAFETY: the PIDL is the shell's live allocation. With no child array, the API opens
    // the item's parent and selects this item, including when the item itself is a folder.
    unsafe { SHOpenFolderAndSelectItems(item.0.cast::<ITEMIDLIST>(), None, 0) }
        .map_err(native_error)?;
    entry.validate()
}

#[derive(Debug, PartialEq, Eq)]
enum Argument {
    File,
    Literal(String),
}

#[derive(Debug, PartialEq, Eq)]
struct CommandTemplate {
    executable: PathBuf,
    arguments: Vec<Argument>,
}

impl CommandTemplate {
    /// The arguments with `file` in its slot: the file is always one argument, never command text.
    fn args(&self, file: &std::ffi::OsStr) -> Vec<OsString> {
        self.arguments
            .iter()
            .map(|argument| match argument {
                Argument::File => file.to_owned(),
                Argument::Literal(value) => OsString::from(value),
            })
            .collect()
    }
}

enum LaunchPlan {
    Static {
        command: CommandTemplate,
        _guards: Vec<File>,
    },
    Packaged {
        aumid: String,
        verb: String,
        store: PathBuf,
        _app: IShellItem2,
        _guards: Vec<File>,
    },
}

/// The plan and its mode, or why neither the default app nor an editor can open the file.
fn select_plan<T>(
    extension: &str,
    default: impl FnOnce() -> Result<T, String>,
    edit: impl FnOnce() -> Result<T, String>,
) -> Result<(T, OpenMode), String> {
    let default = if program_extension(extension) {
        "a program or shortcut type".to_owned()
    } else {
        match default() {
            Ok(plan) => return Ok((plan, OpenMode::Default)),
            Err(reason) => reason,
        }
    };
    edit()
        .map(|plan| (plan, OpenMode::Editor))
        .map_err(|edit| format!("default: {default}; edit: {edit}"))
}

fn association_plan(association: &str, verb: Option<&str>) -> Result<LaunchPlan, String> {
    static_association_plan(association, verb).or_else(|command| {
        packaged_association_plan(association, verb)
            .map_err(|package| format!("command: {command}, package: {package}"))
    })
}

fn static_association_plan(association: &str, verb: Option<&str>) -> Result<LaunchPlan, String> {
    // A null verb asks for the association's default; user settings are deliberately kept.
    // DDE registration does not invalidate a verified command containing a file slot:
    // launching that captured command never reads or replays a DDE payload.
    for kind in [ASSOCSTR_DELEGATEEXECUTE, ASSOCSTR_DROPTARGET] {
        if association_string(association, verb, kind).is_some_and(|value| !value.is_empty()) {
            return Err("registered as a COM handler".into());
        }
    }
    let command =
        association_string(association, verb, ASSOCSTR_COMMAND).ok_or("no registered command")?;
    let registered = association_string(association, verb, ASSOCSTR_EXECUTABLE)
        .ok_or("no registered executable")?;
    let mut command = parse_association_template(&command)
        .ok_or("the command is not one program with one file argument")?;
    let registered = literal_executable(&registered).ok_or("the executable is not a local .exe")?;
    // Reject app execution aliases and reparse files before canonicalizing either spelling.
    for path in [&command.executable, &registered] {
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|error| format!("the executable cannot be read: {error}"))?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("the executable is a link or an app alias".into());
        }
    }
    let canonical = |path: &Path| {
        path.canonicalize()
            .map_err(|error| format!("the executable cannot be resolved: {error}"))
    };
    let resolved = canonical(&command.executable)?;
    if resolved != canonical(&registered)? {
        return Err("the command and the registered executable differ".into());
    }
    if unsafe_host(&resolved) {
        return Err("an interpreter or script host".into());
    }
    let (executable, guards) = pin_executable(&resolved)
        .map_err(|error| format!("the executable could not be pinned: {error}"))?;
    if executable != resolved || unsafe_host(&executable) {
        return Err("the executable changed while it was checked".into());
    }
    command.executable = executable;
    Ok(LaunchPlan::Static {
        command,
        _guards: guards,
    })
}

fn packaged_association_plan(
    association: &str,
    requested_verb: Option<&str>,
) -> Result<LaunchPlan, String> {
    let aumid = association_string(association, requested_verb, ASSOCSTR_APPID)
        .ok_or("association AUMID lookup")?;
    let (family, application) = package_identity(&aumid).ok_or("native AUMID parsing")?;
    let verb = association_verb(association, requested_verb)
        .ok_or("registered default/edit verb lookup")?;
    let item_name: Vec<_> = format!("shell:AppsFolder\\{aumid}")
        .encode_utf16()
        .chain([0])
        .collect();
    // SAFETY: this is a native-validated package AUMID in the fixed AppsFolder namespace.
    // The buffer lives through parsing, and the caller initialized this thread's COM apartment.
    let app: IShellItem2 =
        unsafe { SHCreateItemFromParsingName(PCWSTR(item_name.as_ptr()), None::<&IBindCtx>) }
            .map_err(|error| format!("AppsFolder item lookup: {error}"))?;
    // SAFETY: a valid property key is read from a live shell item; ownership is task-allocator.
    let identity = unsafe { app.GetString(&APP_USER_MODEL_ID) }
        .map_err(|error| format!("AppsFolder AUMID property: {error}"))?;
    if identity.is_null() {
        return Err("empty AppsFolder AUMID property".into());
    }
    let identity = TaskMem(identity.as_ptr().cast());
    // SAFETY: GetString returned a live, NUL-terminated task allocation retained above.
    if unsafe { PWSTR(identity.0.cast()).to_string() }
        .map_err(|error| format!("AppsFolder AUMID encoding: {error}"))?
        != aumid
    {
        return Err("AppsFolder AUMID differs from captured association".into());
    }

    let directory =
        registered_package_directory(&family).ok_or("registered package directory lookup")?;
    let directory = directory
        .canonicalize()
        .map_err(|error| format!("package directory canonicalization: {error}"))?;
    let store = directory
        .parent()
        .ok_or("package directory has no store parent")?
        .to_path_buf();
    let (manifest, mut guards) =
        pin_package_file_checked(&directory.join("AppxManifest.xml"), &directory)
            .map_err(|error| format!("manifest file/ancestor guards: {error:?}"))?;
    if manifest.parent().ok_or("manifest has no parent")? != directory {
        return Err("manifest escaped registered package directory".into());
    }
    let file = guards
        .last()
        .ok_or("missing manifest handle")?
        .try_clone()
        .map_err(|error| format!("clone manifest handle: {error}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read bounded manifest: {error}"))?;
    let executables = manifest_executables(&bytes, &application, association, &verb)
        .ok_or("manifest application/file route/verb/executable validation")?;
    for relative in executables {
        let (executable, executable_guards) =
            pin_package_file_checked(&directory.join(relative), &directory)
                .map_err(|error| format!("package executable file/ancestor guards: {error:?}"))?;
        // `pin_package_file_checked` keeps it inside the package directory.
        if unsafe_host(&executable) {
            return Err("unsafe executable or package escape".into());
        }
        guards.extend(executable_guards);
    }
    Ok(LaunchPlan::Packaged {
        aumid,
        verb,
        store,
        _app: app,
        _guards: guards,
    })
}

fn association_verb(association: &str, requested: Option<&str>) -> Option<String> {
    let association: Vec<_> = association.encode_utf16().chain([0]).collect();
    // SAFETY: the association buffer lives through this read-only query; per-user settings
    // are included. The successful returned key is closed exactly once by RegistryKey.
    let key = unsafe {
        AssocQueryKeyW(
            ASSOCF_NOFIXUPS | ASSOCF_INIT_IGNOREUNKNOWN,
            ASSOCKEY_CLASS,
            PCWSTR(association.as_ptr()),
            PCWSTR::null(),
        )
    }
    .ok()?;
    let key = RegistryKey(key);
    let mut shell = HKEY::default();
    // SAFETY: key is live, the shell literal is NUL-terminated, and shell is writable.
    unsafe { RegOpenKeyExW(key.0, w!("shell"), None, KEY_READ, &mut shell) }
        .ok()
        .ok()?;
    let shell = RegistryKey(shell);
    let verb = if let Some(requested) = requested {
        requested.to_owned()
    } else {
        registry_default_string(shell.0)
            .ok()?
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "open".into())
    };
    if verb.is_empty()
        || verb.len() > 64
        || !verb
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return None;
    }
    let verb_name: Vec<_> = verb.encode_utf16().chain([0]).collect();
    let mut verb_key = HKEY::default();
    // SAFETY: the captured verb has no path separators, and all buffers and handles are live.
    unsafe {
        RegOpenKeyExW(
            shell.0,
            PCWSTR(verb_name.as_ptr()),
            None,
            KEY_READ,
            &mut verb_key,
        )
    }
    .ok()
    .ok()?;
    let _verb_key = RegistryKey(verb_key);
    Some(verb)
}

fn registry_default_string(key: HKEY) -> Result<Option<String>, ()> {
    let mut size = 0;
    // SAFETY: key is borrowed from a live guard; this first call requests only byte count.
    let result = unsafe {
        RegGetValueW(
            key,
            PCWSTR::null(),
            PCWSTR::null(),
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut size),
        )
    };
    if result == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if result != ERROR_SUCCESS || size < 2 || size as usize > MAX_COMMAND_UNITS * 2 || size % 2 != 0
    {
        return Err(());
    }
    let mut buffer = vec![0_u16; size as usize / 2];
    // SAFETY: the mutable allocation has the exact byte capacity passed in size.
    let result = unsafe {
        RegGetValueW(
            key,
            PCWSTR::null(),
            PCWSTR::null(),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if result != ERROR_SUCCESS || size < 2 || size as usize > buffer.len() * 2 {
        return Err(());
    }
    wide_string(&buffer).map(Some).ok_or(())
}

fn package_identity(aumid: &str) -> Option<(String, String)> {
    if aumid.is_empty() || aumid.contains('\0') || aumid.encode_utf16().count() > 128 {
        return None;
    }
    let aumid: Vec<_> = aumid.encode_utf16().chain([0]).collect();
    let mut family_length = 0;
    let mut application_length = 0;
    // SAFETY: the AUMID is bounded and terminated; this call requests output buffer sizes.
    let result = unsafe {
        ParseApplicationUserModelId(
            PCWSTR(aumid.as_ptr()),
            &mut family_length,
            None,
            &mut application_length,
            None,
        )
    };
    if result != ERROR_INSUFFICIENT_BUFFER
        || !(2..=129).contains(&family_length)
        || !(2..=129).contains(&application_length)
    {
        return None;
    }
    let mut family = vec![0_u16; family_length as usize];
    let mut application = vec![0_u16; application_length as usize];
    // SAFETY: both output buffers have exactly the capacities passed to the native parser.
    let result = unsafe {
        ParseApplicationUserModelId(
            PCWSTR(aumid.as_ptr()),
            &mut family_length,
            Some(PWSTR(family.as_mut_ptr())),
            &mut application_length,
            Some(PWSTR(application.as_mut_ptr())),
        )
    };
    if result != ERROR_SUCCESS
        || family_length as usize > family.len()
        || application_length as usize > application.len()
    {
        return None;
    }
    Some((wide_string(&family)?, wide_string(&application)?))
}

fn registered_package_directory(family: &str) -> Option<PathBuf> {
    let family: Vec<_> = family.encode_utf16().chain([0]).collect();
    let filters = PACKAGE_FILTER_HEAD | PACKAGE_FILTER_DIRECT;
    let mut count = 0;
    let mut length = 0;
    // SAFETY: input is terminated; only the writable count and required buffer size are used.
    let result = unsafe {
        FindPackagesByPackageFamily(
            PCWSTR(family.as_ptr()),
            filters,
            &mut count,
            None,
            &mut length,
            None,
            None,
        )
    };
    if result != ERROR_INSUFFICIENT_BUFFER
        || count != 1
        || length == 0
        || length as usize > MAX_COMMAND_UNITS
    {
        return None;
    }
    let mut names = [PWSTR::null()];
    let mut buffer = vec![0_u16; length as usize];
    // SAFETY: names has the one slot passed in count; buffer has length UTF-16 units. Native
    // output name pointers refer into buffer, and are checked before reading any characters.
    let result = unsafe {
        FindPackagesByPackageFamily(
            PCWSTR(family.as_ptr()),
            filters,
            &mut count,
            Some(names.as_mut_ptr()),
            &mut length,
            Some(PWSTR(buffer.as_mut_ptr())),
            None,
        )
    };
    if result != ERROR_SUCCESS || count != 1 || length as usize > buffer.len() {
        return None;
    }
    let offset = (names[0].as_ptr() as usize).checked_sub(buffer.as_ptr() as usize)?;
    if offset % 2 != 0 || offset / 2 >= buffer.len() {
        return None;
    }
    let full_name = wide_string(&buffer[offset / 2..])?;
    let full_name: Vec<_> = full_name.encode_utf16().chain([0]).collect();
    let mut length = 0;
    // SAFETY: full_name is a copied and terminated native package name; only size is output.
    let result = unsafe { GetPackagePathByFullName(PCWSTR(full_name.as_ptr()), &mut length, None) };
    if result != ERROR_INSUFFICIENT_BUFFER || length == 0 || length as usize > MAX_COMMAND_UNITS {
        return None;
    }
    let mut path = vec![0_u16; length as usize];
    // SAFETY: the mutable UTF-16 output has the exact capacity passed in length.
    let result = unsafe {
        GetPackagePathByFullName(
            PCWSTR(full_name.as_ptr()),
            &mut length,
            Some(PWSTR(path.as_mut_ptr())),
        )
    };
    if result != ERROR_SUCCESS || length as usize > path.len() {
        return None;
    }
    let path = PathBuf::from(wide_string(&path)?);
    path.is_absolute().then_some(path)
}

fn wide_string(buffer: &[u16]) -> Option<String> {
    let end = buffer.iter().position(|unit| *unit == 0)?;
    String::from_utf16(&buffer[..end]).ok()
}

fn manifest_executables(
    bytes: &[u8],
    application: &str,
    association: &str,
    verb: &str,
) -> Option<Vec<PathBuf>> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return None;
    }
    // SAFETY: COM is initialized on this thread; MSXML6 is the installed in-process parser.
    let document: IXMLDOMDocument2 =
        unsafe { CoCreateInstance(&DOMDocument60, None, CLSCTX_INPROC_SERVER) }.ok()?;
    // SAFETY: the owned parser stays on this apartment. DTDs and all external resolution are
    // disabled before loading bounded bytes; synchronous loading and bounded depth prevent
    // asynchronous lifetime or unbounded entity/depth behavior.
    unsafe {
        document.Setasync(false.into()).ok()?;
        document.SetvalidateOnParse(false.into()).ok()?;
        document.SetresolveExternals(false.into()).ok()?;
        document
            .setProperty(&BSTR::from("ProhibitDTD"), &VARIANT::from(true))
            .ok()?;
        document
            .setProperty(&BSTR::from("MaxElementDepth"), &VARIANT::from(64_i32))
            .ok()?;
        document
            .setProperty(&BSTR::from("SelectionLanguage"), &VARIANT::from("XPath"))
            .ok()?;
    }
    // SAFETY: SHCreateMemStream copies the bounded byte slice into its own COM allocation.
    let stream = unsafe { SHCreateMemStream(Some(bytes)) }?;
    let source = VARIANT::from(stream.cast::<IUnknown>().ok()?);
    // SAFETY: source owns a reference to the memory stream for the synchronous parse. The
    // native boolean is checked too; MSXML can report parse failure with a successful HRESULT.
    if !bool::from(unsafe { document.load(&source) }.ok()?) {
        return None;
    }
    let node: IXMLDOMNode = document.cast().ok()?;
    let applications = xml_nodes(
        &node,
        "/*[local-name()='Package']/*[local-name()='Applications']/*[local-name()='Application']",
    )?;
    let mut matching = Vec::new();
    for node in applications {
        if xml_attribute(&node, "Id").ok()?? == application {
            matching.push(node);
        }
    }
    if matching.len() != 1 {
        return None;
    }
    let app = &matching[0];
    let main = package_executable(&xml_attribute(app, "Executable").ok()??)?;
    if !safe_manifest_parameters(app) {
        return None;
    }

    let mut selected = None;
    for extension in xml_nodes(
        app,
        "*[local-name()='Extensions']/*[local-name()='Extension']",
    )? {
        if xml_attribute(&extension, "Category").ok()?.as_deref()
            != Some("windows.fileTypeAssociation")
        {
            continue;
        }
        for file_type in xml_nodes(&extension, "*[local-name()='FileTypeAssociation']")? {
            let mut supported = false;
            for file in xml_nodes(
                &file_type,
                "*[local-name()='SupportedFileTypes']/*[local-name()='FileType']",
            )? {
                // SAFETY: file is an owned node from this parser on the same COM apartment.
                let value = unsafe { file.text() }.ok()?.to_string();
                supported |= value.trim().eq_ignore_ascii_case(association);
            }
            if !supported {
                continue;
            }
            let verbs = xml_nodes(
                &file_type,
                "*[local-name()='SupportedVerbs']/*[local-name()='Verb']",
            )?;
            let mut selected_verbs = Vec::new();
            for candidate in &verbs {
                if xml_attribute(candidate, "Id")
                    .ok()?
                    .is_some_and(|id| id.eq_ignore_ascii_case(verb))
                {
                    selected_verbs.push(candidate);
                }
            }
            if selected_verbs.len() > 1 {
                return None;
            }
            // `open` is implicit: SupportedVerbs lists only the verbs besides it.
            if selected_verbs.is_empty() && !verb.eq_ignore_ascii_case("open") {
                continue;
            }
            if !safe_manifest_parameters(&extension)
                || !safe_manifest_parameters(&file_type)
                || selected_verbs
                    .iter()
                    .any(|node| !safe_manifest_parameters(node))
            {
                return None;
            }
            let executable = match xml_attribute(&extension, "Executable").ok()? {
                Some(value) => package_executable(&value)?,
                None => main.clone(),
            };
            // MigrateApplicationProgIds/ApplicationProperties describes former registration
            // state, sometimes naming files absent from the current package. It is not a live
            // route for the captured current AUMID passed directly to ActivateForFile.
            // Multiple manifest routes for the same captured file/verb are ambiguous.
            if selected.replace(executable).is_some() {
                return None;
            }
        }
    }
    let executable = selected?;
    let mut executables = vec![main];
    if executables[0] != executable {
        executables.push(executable);
    }
    Some(executables)
}

fn xml_nodes(node: &IXMLDOMNode, query: &str) -> Option<Vec<IXMLDOMNode>> {
    // SAFETY: these interfaces stay on their initialized COM thread; query is a fixed or
    // locally constructed attribute expression, never an interpolated association/filename.
    let nodes = unsafe { node.selectNodes(&BSTR::from(query)) }.ok()?;
    // SAFETY: the returned node list is live on the same apartment.
    let count = unsafe { nodes.length() }.ok()?;
    if !(0..=256).contains(&count) {
        return None;
    }
    (0..count)
        .map(|index| {
            // SAFETY: index is below the list's captured length; the native interface reports races.
            unsafe { nodes.get_item(index) }.ok()
        })
        .collect()
}

fn xml_attribute(node: &IXMLDOMNode, name: &str) -> Result<Option<String>, ()> {
    let nodes = xml_nodes(node, &format!("@*[local-name()='{name}']")).ok_or(())?;
    match nodes.as_slice() {
        [] => Ok(None),
        [node] => {
            // SAFETY: this is an owned attribute node on the calling parser's COM apartment.
            unsafe { node.text() }
                .map(|text| Some(text.to_string()))
                .map_err(|_| ())
        }
        _ => Err(()),
    }
}

fn safe_manifest_parameters(node: &IXMLDOMNode) -> bool {
    match xml_attribute(node, "Parameters") {
        Ok(None) => true,
        Ok(Some(value)) => {
            if value.trim().is_empty() {
                return true;
            }
            let command = format!(r#""C:\FolioManifest\viewer.exe" {value}"#);
            let Some(tokens) = split_command(&command) else {
                return false;
            };
            let has_file = tokens
                .iter()
                .skip(1)
                .any(|value| value == "%1" || value.eq_ignore_ascii_case("%L"));
            let command = if has_file {
                command
            } else {
                format!(r#"{command} "%1""#)
            };
            parse_template(&command).is_some()
        }
        Err(()) => false,
    }
}

fn package_executable(value: &str) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    if path.is_absolute()
        || value.contains(['%', '"', '\0'])
        || !path.extension()?.to_str()?.eq_ignore_ascii_case("exe")
        || unsafe_host(&path)
    {
        return None;
    }
    for component in path.components() {
        let Component::Normal(name) = component else {
            return None;
        };
        let name = name.to_str()?;
        if name.ends_with(['.', ' ']) || name.contains(':') {
            return None;
        }
    }
    Some(path)
}

fn shell_item_id(path: &Path) -> Result<TaskMem, AppError> {
    let path = super::shell_path(path)?;
    let path: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut item = std::ptr::null_mut();
    // SAFETY: the guarded path's terminated buffer and output pointer live through parsing.
    // No attribute lookup or binding context is requested; COM stays on this calling thread.
    unsafe { SHParseDisplayName(PCWSTR(path.as_ptr()), None::<&IBindCtx>, &mut item, 0, None) }
        .map_err(native_error)?;
    if item.is_null() {
        return Err(AppError::FileSystem(
            "Windows returned no item identifier".into(),
        ));
    }
    Ok(TaskMem(item.cast()))
}

fn activate_for_file(
    aumid: &str,
    verb: &str,
    store: &Path,
    guards: &[File],
    entry: &super::PinnedEntry,
) -> Result<(), AppError> {
    // A local-server activation manager owns the event arguments beyond this worker's call.
    // SAFETY: the registered Windows class is requested on this initialized COM thread.
    let manager: IApplicationActivationManager =
        unsafe { CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER) }
            .map_err(native_error)?;
    // SAFETY: the manager is a live out-of-process COM interface; the reserved pointer is null.
    unsafe { CoAllowSetForegroundWindow(&manager, None) }.map_err(native_error)?;
    let aumid: Vec<_> = aumid.encode_utf16().chain([0]).collect();
    let verb: Vec<_> = verb.encode_utf16().chain([0]).collect();
    validate_package_store(store)?;
    validate_app_guards(guards)?;
    let _entry_guard = entry.freeze()?;
    let item = shell_item_id(&entry.path)?;
    // SAFETY: item holds a live PIDL; this one-element array is copied by the shell API.
    let items =
        unsafe { SHCreateShellItemArrayFromIDLists(&[item.0.cast::<ITEMIDLIST>().cast_const()]) }
            .map_err(native_error)?;
    // SAFETY: captured AUMID and verb are terminated buffers, and items is a live single-file
    // shell array. Activation dispatches this application identity directly without consulting
    // the document's association again or passing the document as executable command text.
    unsafe { manager.ActivateForFile(PCWSTR(aumid.as_ptr()), &items, PCWSTR(verb.as_ptr())) }
        .map_err(native_error)?;
    entry.validate()?;
    validate_package_store(store)?;
    Ok(())
}

fn validate_app_guards(guards: &[File]) -> Result<(), AppError> {
    for guard in guards {
        // Sharing prevents replacement/content writes. Attribute-only reparse mutation is
        // detected by tag revalidation; sharing itself does not prevent that mutation.
        super::no_redirect(guard)?;
    }
    Ok(())
}

fn association_string(association: &str, verb: Option<&str>, kind: ASSOCSTR) -> Option<String> {
    let association: Vec<_> = association.encode_utf16().chain([0]).collect();
    let verb = verb.map(|verb| verb.encode_utf16().chain([0]).collect::<Vec<_>>());
    let extra = verb
        .as_ref()
        .map_or(PCWSTR::null(), |verb| PCWSTR(verb.as_ptr()));
    let flags = ASSOCF_NOTRUNCATE | ASSOCF_NOFIXUPS | ASSOCF_INIT_IGNOREUNKNOWN;
    let mut length = 0;
    // SAFETY: both input buffers are NUL-terminated and live; length is a writable DWORD.
    let result = unsafe {
        AssocQueryStringW(
            flags,
            kind,
            PCWSTR(association.as_ptr()),
            extra,
            None,
            &mut length,
        )
    };
    if result.0 != 1 || length == 0 || length as usize > MAX_COMMAND_UNITS {
        return None;
    }
    let mut buffer = vec![0_u16; length as usize];
    // SAFETY: the writable output allocation has exactly the capacity passed in length.
    let result = unsafe {
        AssocQueryStringW(
            flags,
            kind,
            PCWSTR(association.as_ptr()),
            extra,
            Some(PWSTR(buffer.as_mut_ptr())),
            &mut length,
        )
    };
    // A registry race that increases the size fails closed; never truncate or retry forever.
    if result.0 != 0 || length == 0 || length as usize > buffer.len() {
        return None;
    }
    wide_string(&buffer)
}

fn parse_template(command: &str) -> Option<CommandTemplate> {
    template(split_command(command)?)
}

fn template(tokens: Vec<String>) -> Option<CommandTemplate> {
    let executable = literal_executable(tokens.first()?)?;
    if unsafe_host(&executable) {
        return None;
    }
    let mut arguments = Vec::new();
    let mut files = 0;
    for token in tokens.into_iter().skip(1) {
        if token == "%1" || token.eq_ignore_ascii_case("%L") {
            files += 1;
            arguments.push(Argument::File);
        } else if token == "%*" {
            // There are no caller-provided additional arguments in this IPC contract.
        } else if token.contains('%')
            || token
                .to_ascii_lowercase()
                .starts_with("--ms-enable-electron-run-as-node")
        {
            return None;
        } else {
            arguments.push(Argument::Literal(token));
        }
    }
    (files == 1).then_some(CommandTemplate {
        executable,
        arguments,
    })
}

fn parse_association_template(command: &str) -> Option<CommandTemplate> {
    let mut tokens = split_command(command)?;
    let executable = literal_executable(tokens.first()?)?;
    if !office_executable(&executable) {
        return template(tokens);
    }
    // Office passes a document's web address too (`/o "%u"`, `/ou "%u"`) for its web
    // integration; a file on this disk needs none, so the pair is left out.
    if let Some(index) = tokens.windows(2).skip(1).position(|pair| {
        matches!(pair[0].to_ascii_lowercase().as_str(), "/o" | "/ou")
            && pair[1].eq_ignore_ascii_case("%u")
    }) {
        tokens.drain(index + 1..index + 3);
    }
    if !tokens
        .iter()
        .skip(1)
        .any(|token| token.eq_ignore_ascii_case("/dde"))
    {
        return template(tokens);
    }

    // Office registers some file types with a DDE-only command. Use its documented file
    // argument instead: no DDE string, macro, add-in, printing, or registration switches.
    let name = executable.file_stem()?.to_str()?.to_ascii_lowercase();
    let mut arguments = Vec::new();
    let mut switches = 0;
    let mut files = 0;
    for token in tokens.into_iter().skip(1) {
        let token_lower = token.to_ascii_lowercase();
        if token_lower == "/dde" || token == "%*" {
            continue;
        }
        if token == "%1" || token.eq_ignore_ascii_case("%L") {
            files += 1;
            continue;
        }
        let safe_switch = match name.as_str() {
            "winword" => matches!(token_lower.as_str(), "/n" | "/q" | "/safe"),
            "excel" => matches!(token_lower.as_str(), "/e" | "/x" | "/s" | "/safemode"),
            "powerpnt" => matches!(token_lower.as_str(), "/o" | "/s"),
            _ => false,
        };
        if !safe_switch {
            return None;
        }
        switches += 1;
        arguments.push(Argument::Literal(token));
    }
    if files > 1 || switches > 1 {
        return None;
    }
    arguments.push(Argument::File);
    Some(CommandTemplate {
        executable,
        arguments,
    })
}

fn office_executable(executable: &Path) -> bool {
    executable
        .file_stem()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            ["winword", "excel", "powerpnt"]
                .iter()
                .any(|office| name.eq_ignore_ascii_case(office))
        })
}

fn split_command(command: &str) -> Option<Vec<String>> {
    if command.trim().is_empty()
        || command.contains('\0')
        || command.encode_utf16().count() >= MAX_COMMAND_UNITS
    {
        return None;
    }
    // CommandLineToArgvW accepts unterminated quotes; this boundary does not.
    let mut quoted = false;
    let mut slashes = 0;
    for byte in command.bytes() {
        if byte == b'\\' {
            slashes += 1;
            continue;
        }
        if byte == b'"' && slashes % 2 == 0 {
            quoted = !quoted;
        }
        slashes = 0;
    }
    if quoted {
        return None;
    }
    let command: Vec<_> = command.encode_utf16().chain([0]).collect();
    let mut count = 0;
    // SAFETY: the command is a bounded, nonempty, NUL-terminated UTF-16 buffer. The API
    // allocates the pointer table and strings together; LocalArguments frees them once.
    let pointers = unsafe { CommandLineToArgvW(PCWSTR(command.as_ptr()), &mut count) };
    if pointers.is_null() {
        return None;
    }
    let pointers = LocalArguments(pointers);
    if count <= 0 || count as usize > MAX_COMMAND_UNITS {
        return None;
    }
    // SAFETY: successful CommandLineToArgvW returned exactly count pointers in this allocation.
    let pointers = unsafe { std::slice::from_raw_parts(pointers.0, count as usize) };
    pointers
        .iter()
        .map(|pointer| {
            if pointer.is_null() {
                return None;
            }
            // SAFETY: each pointer is a NUL-terminated string inside the still-live allocation.
            unsafe { pointer.to_string() }.ok()
        })
        .collect()
}

fn literal_executable(value: &str) -> Option<PathBuf> {
    if value.contains(['%', '"', '\0']) {
        return None;
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() || !path.extension()?.to_str()?.eq_ignore_ascii_case("exe") {
        return None;
    }
    if !matches!(path.components().next(), Some(Component::Prefix(prefix))
        if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
    {
        return None;
    }
    for component in path.components() {
        match component {
            Component::Normal(name) => {
                let name = name.to_str()?;
                if name.ends_with(['.', ' ']) || name.contains(':') {
                    return None;
                }
            }
            Component::ParentDir | Component::CurDir => return None,
            _ => {}
        }
    }
    Some(path)
}

fn pin_executable(path: &Path) -> Result<(PathBuf, Vec<File>), AppError> {
    let path = path.canonicalize().map_err(super::io_error)?;
    let guards = super::pin_directories(
        path.parent()
            .ok_or_else(|| AppError::Blocked("application path has no parent".into()))?,
    )?;
    pin_readonly_file(path, guards)
}

fn pin_package_file_checked(
    path: &Path,
    package_directory: &Path,
) -> Result<(PathBuf, Vec<File>), AppError> {
    let path = path.canonicalize().map_err(super::io_error)?;
    if !path.starts_with(package_directory) {
        return Err(AppError::Blocked(
            "file escaped the registered package directory".into(),
        ));
    }
    let store = package_directory
        .parent()
        .ok_or_else(|| AppError::Blocked("registered package has no store".into()))?;
    let native_windows_store = store
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("WindowsApps"));
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Blocked("package file has no parent".into()))?;
    let mut current = PathBuf::new();
    let mut guards = Vec::new();
    for component in parent.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let file = match super::pin(&current, false) {
            Ok(file) => file,
            Err(AppError::AccessDenied(_)) if native_windows_store && current == store => {
                // The package directory comes only from registered-package APIs, never IPC.
                // WindowsApps can deny even zero-access metadata handles to desktop clients.
                // Only that exact store root is trusted through native metadata: registration,
                // package-store ACLs, and Windows-managed version activation are desktop state.
                // Every accessible ancestor, actual package directory and leaf stays guarded.
                validate_package_store(&current)?;
                continue;
            }
            Err(error) => return Err(error),
        };
        if super::final_path(&file)? != current
            || !file.metadata().map_err(super::io_error)?.is_dir()
        {
            return Err(AppError::Blocked(
                "a registered package ancestor changed".into(),
            ));
        }
        guards.push(file);
    }
    pin_readonly_file(path, guards)
}

fn validate_package_store(store: &Path) -> Result<(), AppError> {
    let path: Vec<_> = store.as_os_str().encode_wide().chain([0]).collect();
    // SAFETY: the native-registered store path is a terminated, live UTF-16 buffer. This
    // metadata-only call neither opens file content nor changes package/association state.
    let attributes = unsafe { GetFileAttributesW(path.as_ptr()) };
    if attributes == INVALID_FILE_ATTRIBUTES {
        return Err(super::io_error(std::io::Error::last_os_error()));
    }
    if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 || attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(AppError::Blocked(
            "the native package store is not an ordinary directory".into(),
        ));
    }
    Ok(())
}

fn pin_readonly_file(
    path: PathBuf,
    mut guards: Vec<File>,
) -> Result<(PathBuf, Vec<File>), AppError> {
    // A real read denies both content writers and replacement until CreateProcess.
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OPEN_NO_RECALL)
        .open(&path)
        .map_err(super::io_error)?;
    if super::final_path(&file)? != path {
        return Err(AppError::Blocked(
            "a captured application file changed".into(),
        ));
    }
    let metadata = file.metadata().map_err(super::io_error)?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(AppError::Blocked(
            "a captured application file is not an ordinary file".into(),
        ));
    }
    guards.push(file);
    Ok((path, guards))
}

fn spawn(
    executable: &Path,
    arguments: impl FnOnce(&mut Command) -> &mut Command,
) -> Result<(), AppError> {
    arguments(&mut Command::new(executable))
        // An editor built on Electron must remain an editor even if Folio inherited this flag.
        .env_remove("ELECTRON_RUN_AS_NODE")
        .current_dir(
            executable
                .parent()
                .ok_or_else(|| AppError::Blocked("app has no parent".into()))?,
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| AppError::FileSystem(format!("launch registered app: {error}")))?;
    Ok(())
}

fn program_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "exe"
            | "com"
            | "scr"
            | "pif"
            | "cpl"
            | "dll"
            | "sys"
            | "ocx"
            | "drv"
            | "msi"
            | "msp"
            | "mst"
            | "msu"
            | "msix"
            | "msixbundle"
            | "appx"
            | "appxbundle"
            | "appinstaller"
            | "application"
            | "appref-ms"
            | "lnk"
            | "url"
            | "website"
            | "hta"
            | "jar"
            | "reg"
            | "scf"
            | "sct"
            | "msc"
            | "inf"
            | "chm"
            | "gadget"
            | "search-ms"
            | "library-ms"
            | "settingcontent-ms"
            // Office add-ins load as code, not as documents; installers and deployed apps.
            | "xll"
            | "wll"
            | "xla"
            | "xlam"
            | "xlm"
            | "ppa"
            | "ppam"
            | "ppkg"
            | "vsto"
            | "xbap"
    )
}

fn unsafe_host(executable: &Path) -> bool {
    let Some(stem) = executable.file_stem().and_then(|stem| stem.to_str()) else {
        return true;
    };
    let stem = stem.to_ascii_lowercase();
    [
        "cmd",
        "command",
        "powershell",
        "powershell_ise",
        "pwsh",
        "pwsh-preview",
        "wscript",
        "cscript",
        "mshta",
        "python",
        "pythonw",
        "py",
        "pyw",
        "pypy",
        "pypyw",
        "jython",
        "ipy",
        "pymanager",
        "node",
        "nodejs",
        "electron",
        "bun",
        "deno",
        "java",
        "javaw",
        "javaws",
        "jshell",
        "bash",
        "sh",
        "zsh",
        "dash",
        "ksh",
        "csh",
        "tcsh",
        "fish",
        "nu",
        "wsl",
        "wslhost",
        "busybox",
        "git-bash",
        "git-cmd",
        "mintty",
        "perl",
        "ruby",
        "rubyw",
        "php",
        "lua",
        "luajit",
        "tclsh",
        "wish",
        "r",
        "rscript",
        "dotnet",
        "csi",
        "fsi",
        "autohotkey",
        "autohotkeyu",
        "autoit",
        "autoit3",
        "rundll",
        "regsvr",
        "msiexec",
        "reg",
        "regedit",
        "control",
        "installutil",
        "msbuild",
        "cmstp",
        "forfiles",
        "hh",
        "msdt",
        "conhost",
        "wt",
        "windowsterminal",
        "explorer",
        "openwith",
        "runtimebroker",
        "applicationframehost",
        "presentationhost",
        "provtool",
    ]
    .iter()
    .any(|host| {
        stem == *host
            || stem.strip_prefix(*host).is_some_and(|suffix| {
                suffix.starts_with(|character: char| character.is_ascii_digit())
                    && suffix.chars().all(|character| {
                        character.is_ascii_digit()
                            || matches!(character, '.' | '-' | '_' | 't' | 'd')
                    })
            })
    })
}

struct LocalArguments(*mut PWSTR);

impl Drop for LocalArguments {
    fn drop(&mut self) {
        // SAFETY: this is the allocation returned by CommandLineToArgvW; only this guard frees it.
        unsafe { LocalFree(Some(HLOCAL(self.0.cast()))) };
    }
}

struct TaskMem(*mut std::ffi::c_void);

impl Drop for TaskMem {
    fn drop(&mut self) {
        // SAFETY: shell APIs allocated this pointer with the COM task allocator, once per guard.
        unsafe { CoTaskMemFree(Some(self.0.cast())) };
    }
}

struct RegistryKey(HKEY);

impl Drop for RegistryKey {
    fn drop(&mut self) {
        // SAFETY: read-only association APIs returned this owned key; only this guard closes it.
        let _ = unsafe { RegCloseKey(self.0) };
    }
}

fn native_error(error: windows::core::Error) -> AppError {
    let code = error.code().0 as u32;
    // FACILITY_WIN32: the same codes as any I/O error (ipc-m1 §16.2), e.g. NotFound.
    if code >> 16 == 0x8007 {
        return super::io_error(std::io::Error::from_raw_os_error((code & 0xFFFF) as i32));
    }
    AppError::FileSystem(format!("Windows file action: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_executable_association_is_read_without_launching_it() {
        let _apartment = super::super::Apartment::new().unwrap();
        let command = association_string(".exe", None, ASSOCSTR_COMMAND)
            .expect("Windows registers an executable-file association");
        assert!(!command.is_empty());
        assert!(!command.contains('\0'));
    }

    #[test]
    fn static_commands_preserve_fixed_arguments_and_one_file_slot() {
        let template =
            parse_template(r#""C:\Program Files\Editor\editor.exe" --reuse-window "%L" %*"#)
                .unwrap();
        assert_eq!(
            template.executable,
            Path::new(r"C:\Program Files\Editor\editor.exe")
        );
        assert_eq!(
            template.arguments,
            [Argument::Literal("--reuse-window".into()), Argument::File]
        );
        let filename = Path::new(r"C:\Library\%1 & lesson.py");
        assert_eq!(
            template.args(filename.as_os_str()),
            [
                OsString::from("--reuse-window"),
                filename.as_os_str().to_owned()
            ]
        );
    }

    #[test]
    fn office_commands_with_file_arguments_do_not_require_dde_dispatch() {
        let template =
            parse_association_template(r#""C:\Office\WINWORD.EXE" /n "%1" /dde"#).unwrap();
        assert_eq!(
            template.arguments,
            [Argument::Literal("/n".into()), Argument::File,]
        );
        // The general parser remains strict; only the native Office adapter supplies a slot.
        assert!(parse_template(r#""C:\Office\WINWORD.EXE" /n /dde"#).is_none());
        let dde_only = parse_association_template(r#""C:\Office\WINWORD.EXE" /n /dde"#).unwrap();
        assert_eq!(dde_only, template);
        for executable in ["EXCEL", "POWERPNT"] {
            let template =
                parse_association_template(&format!(r#""C:\Office\{executable}.EXE" /dde"#))
                    .unwrap();
            assert_eq!(template.arguments, [Argument::File]);
        }
        for command in [
            r#""C:\Apps\unknown.exe" /dde"#,
            r#""C:\Office\WINWORD.EXE" /mMacro /dde"#,
            r#""C:\Office\WINWORD.EXE" /n /q /dde"#,
            r#""C:\Office\EXCEL.EXE" /a addin.xll /dde"#,
            r#""C:\Office\POWERPNT.EXE" /m slide.pptm Macro /dde"#,
            r#""C:\Office\WINWORD.EXE" "%1" "%L" /dde"#,
            r#""C:\Office\WINWORD.EXE" "%unknown%" /dde"#,
        ] {
            assert!(
                parse_association_template(command).is_none(),
                "accepted {command}"
            );
        }
    }

    #[test]
    fn native_packaged_association_is_read_without_launching_it() {
        let _apartment = super::super::Apartment::new().unwrap();
        let Some(aumid) = association_string(".png", None, ASSOCSTR_APPID) else {
            return;
        };
        if package_identity(&aumid).is_none() {
            return;
        }
        let plan = packaged_association_plan(".png", None)
            .unwrap_or_else(|stage| panic!("the installed packaged PNG default failed at {stage}"));
        let LaunchPlan::Packaged {
            aumid: captured, ..
        } = plan
        else {
            panic!("expected package plan")
        };
        assert_eq!(captured, aumid);
    }

    #[test]
    fn package_manifest_verifies_file_route_verb_and_executable_overrides() {
        let _apartment = super::super::Apartment::new().unwrap();
        let manifest = br#"<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
            xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
            xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3">
          <Applications><Application Id="Viewer" Executable="viewer.exe">
            <Extensions><uap:Extension Category="windows.fileTypeAssociation" Executable="tools\image-viewer.exe">
              <uap:FileTypeAssociation Name="images"><uap:SupportedFileTypes>
                <uap:FileType>.png</uap:FileType>
              </uap:SupportedFileTypes><uap3:SupportedVerbs>
                <uap3:Verb Id="open" Parameters="&quot;%1&quot;"/>
                <uap3:Verb Id="edit" Parameters="--edit &quot;%1&quot;"/>
              </uap3:SupportedVerbs></uap:FileTypeAssociation>
            </uap:Extension></Extensions>
          </Application></Applications></Package>"#;
        assert_eq!(
            manifest_executables(manifest, "Viewer", ".PNG", "open"),
            Some(vec![
                PathBuf::from("viewer.exe"),
                PathBuf::from(r"tools\image-viewer.exe")
            ])
        );
        assert!(manifest_executables(manifest, "Viewer", ".png", "edit").is_some());
        assert!(manifest_executables(manifest, "Viewer", ".png", "print").is_none());
        assert!(manifest_executables(manifest, "Viewer", ".py", "open").is_none());
        assert!(manifest_executables(manifest, "Other", ".png", "open").is_none());
        let source = std::str::from_utf8(manifest).unwrap();
        for override_path in [
            "python.exe",
            r"..\viewer.exe",
            r"C:\Apps\viewer.exe",
            "viewer.cmd",
        ] {
            let changed = source.replace(r"tools\image-viewer.exe", override_path);
            assert!(manifest_executables(changed.as_bytes(), "Viewer", ".png", "open").is_none());
        }
        let changed = source.replace(
            "--edit &quot;%1&quot;",
            "--ms-enable-electron-run-as-node &quot;%1&quot;",
        );
        assert!(manifest_executables(changed.as_bytes(), "Viewer", ".png", "edit").is_none());
        let history = source.replace("</uap:FileTypeAssociation>",
            "<MigrateApplicationProgIds><MigrateApplicationProgId><ApplicationProperties Id=\"Viewer\" Executable=\"RemovedViewer.exe\"/></MigrateApplicationProgId></MigrateApplicationProgIds></uap:FileTypeAssociation>");
        assert_eq!(
            manifest_executables(history.as_bytes(), "Viewer", ".png", "open"),
            manifest_executables(manifest, "Viewer", ".png", "open")
        );
        let dtd = format!("<!DOCTYPE Package [<!ENTITY injected 'viewer.exe'>]>{source}");
        assert!(manifest_executables(dtd.as_bytes(), "Viewer", ".png", "open").is_none());
    }

    #[test]
    fn ambiguous_commands_and_templates_are_rejected() {
        for command in [
            "",
            r#"editor.exe "%1""#,
            r#"C:editor.exe "%1""#,
            r#"C:\Program Files\Editor\editor.exe "%1""#,
            r#""\\server\share\editor.exe" "%1""#,
            r#""%LOCALAPPDATA%\editor.exe" "%1""#,
            r#""C:\Apps\editor.cmd" "%1""#,
            r#""C:\Apps\editor.exe" "%2""#,
            r#""C:\Apps\editor.exe" "--file=%1""#,
            r#""C:\Apps\editor.exe" "%1" "%L""#,
            r#""C:\Apps\editor.exe" --reuse-window"#,
            r#""C:\Apps\editor.exe" "%1" "%unknown%""#,
            r#""C:\Apps\editor.exe" "%1" "unfinished"#,
            r#""C:\Apps\editor.exe" --ms-enable-electron-run-as-node "%1""#,
        ] {
            assert!(parse_template(command).is_none(), "accepted {command}");
        }
    }

    #[test]
    fn interpreter_and_wrapper_names_include_case_and_version_aliases() {
        for host in [
            "CMD",
            "pwsh",
            "python3.14t",
            "pythonw3.13-32",
            "py",
            "node",
            "electron",
            "javaw",
            "wscript",
            "mshta",
            "wsl",
            "rundll32",
            "regsvr32",
            "msiexec",
            "explorer",
        ] {
            let command = format!(r#""C:\Apps\{host}.exe" "%1""#);
            assert!(parse_template(&command).is_none(), "accepted {host}");
        }
        assert!(parse_template(r#""C:\Apps\Code.exe" "%1""#).is_some());
    }

    #[test]
    fn editor_associated_scripts_use_default_but_programs_require_edit() {
        let rejected = |command: &str| parse_template(command).ok_or_else(|| "rejected".to_owned());
        assert_eq!(
            select_plan("py", || Ok("editor"), || panic!("unexpected edit")),
            Ok(("editor", OpenMode::Default))
        );
        let (editor, mode) = select_plan(
            "py",
            || rejected(r#""C:\Apps\python.exe" "%1""#),
            || rejected(r#""C:\Apps\Code.exe" "%1""#),
        )
        .unwrap();
        assert_eq!(mode, OpenMode::Editor);
        assert_eq!(editor.executable, Path::new(r"C:\Apps\Code.exe"));
        for extension in [
            "EXE", "lnk", "url", "hta", "jar", "msix", "scf", "xll", "XLAM", "ppam", "wll", "ppkg",
            "vsto", "xbap",
        ] {
            assert_eq!(
                select_plan(
                    extension,
                    || panic!("program used default"),
                    || Ok("editor")
                ),
                Ok(("editor", OpenMode::Editor))
            );
            // Both reasons reach the Blocked detail.
            assert_eq!(
                select_plan::<&str>(
                    extension,
                    || Ok("unsafe default"),
                    || Err("no edit verb".into())
                ),
                Err("default: a program or shortcut type; edit: no edit verb".into())
            );
        }
    }

    #[test]
    fn office_web_address_arguments_are_left_out() {
        let word =
            parse_association_template(r#""C:\Office\WINWORD.EXE" /n "%1" /o "%u""#).unwrap();
        assert_eq!(
            word.arguments,
            [Argument::Literal("/n".into()), Argument::File]
        );
        let slides =
            parse_association_template(r#""C:\Office\POWERPNT.EXE" "%1" /ou "%u""#).unwrap();
        assert_eq!(slides.arguments, [Argument::File]);
        // Only Office's own pair; `%u` anywhere else still fails closed.
        for command in [
            r#""C:\Apps\viewer.exe" "%1" /o "%u""#,
            r#""C:\Office\WINWORD.EXE" "%1" "%u""#,
        ] {
            assert!(
                parse_association_template(command).is_none(),
                "accepted {command}"
            );
        }
    }

    #[test]
    fn packaged_associations_accept_the_implicit_open_verb() {
        let _apartment = super::super::Apartment::new().unwrap();
        // Media Player and Notepad list only their extra verbs.
        let manifest =
            br#"<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
            xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
            xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3">
          <Applications><Application Id="Player" Executable="player.exe">
            <Extensions><uap:Extension Category="windows.fileTypeAssociation">
              <uap:FileTypeAssociation Name="media"><uap:SupportedFileTypes>
                <uap:FileType>.mp4</uap:FileType>
              </uap:SupportedFileTypes><uap3:SupportedVerbs>
                <uap3:Verb Id="Play"/><uap3:Verb Id="Enqueue"/>
              </uap3:SupportedVerbs></uap:FileTypeAssociation>
            </uap:Extension></Extensions>
          </Application></Applications></Package>"#;
        assert_eq!(
            manifest_executables(manifest, "Player", ".mp4", "open"),
            Some(vec![PathBuf::from("player.exe")])
        );
        assert!(manifest_executables(manifest, "Player", ".mp4", "play").is_some());
        assert!(manifest_executables(manifest, "Player", ".mp4", "edit").is_none());
    }
}
