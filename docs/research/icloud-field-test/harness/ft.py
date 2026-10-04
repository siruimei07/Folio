"""Windows side of the iCloud field test (docs/research/icloud-field-test/plan.md).

Python 3.12+ standard library only; Win32 through ctypes. Every command appends JSON lines to
the log folder (default: ../logs next to this file, or FT_LOGS). Times are UTC with
milliseconds. Only paths below the test folder are ever logged. In REL, `{U+0301}` stands for that code point.

    py ft.py env                          versions of Windows, iCloud and Python
    py ft.py init                         create the test folder and its sub-folders
    py ft.py observe [--interval S]       watcher + snapshots of the test folder until Ctrl+C;
                                          also runs Folio's own watcher (icloud_probe)
    py ft.py write REL (--text T | --size BYTES | --png COLOR) [--mode new|posix|movefile|recycle-then-move]
    py ft.py edit REL --text T            overwrite a file in place (no rename)
    py ft.py rename FROM TO               MoveFileExW without replacing (case-only renames too)
    py ft.py recycle REL                  Folio's Recycle Bin (icloud_probe recycle)
    py ft.py delete REL                   DeleteFileW, no Recycle Bin
    py ft.py pin REL [--recurse] / unpin REL [--recurse]
    py ft.py state [REL ...]              one snapshot line per entry (all entries without REL)
    py ft.py hash REL                     read the file (downloads a placeholder) and SHA-256 it
    py ft.py trash                        Recycle Bin and iCloud .Trash entries from the test
    py ft.py push-sim --pack-mb N [--tag NAME]   pack, then head record in 08-order/NAME/;
                                          time both uploads
    py ft.py wait REL --until exists|gone|local|in-sync [--timeout S]
    py ft.py note STEP TEXT               what Sirui reports from the iPad, timed when it arrives
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import platform
import re
import struct
import subprocess
import sys
import threading
import time
import unicodedata
import zlib
from ctypes import wintypes
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
ICLOUD = Path(os.environ.get("FT_ICLOUD", Path.home() / "iCloudDrive"))
ROOT = Path(os.environ.get("FT_ROOT", ICLOUD / "FolioTest2"))
STAGING = Path(os.environ.get("FT_STAGING", Path(os.environ["LOCALAPPDATA"]) / "FolioFieldTest" / "staging"))
LOGS = Path(os.environ.get("FT_LOGS", HERE.parent / "logs"))
PROBE = Path(os.environ.get("FT_PROBE", REPO / "target" / "debug" / "examples" / "icloud_probe.exe"))
SUBFOLDERS = [
    "01-skip", "02-names", "03-case", "04-update", "05-delete", "06-pin", "06-pin/pinned",
    "07-replace", "08-order", "08-order/ipad", "09-conflict-edit", "10-conflict-new", "11-twin",
]
# Solid squares the iPad can tell apart at a glance (steps 3-10 of plan.md).
COLORS = {"red": (220, 40, 40), "green": (40, 170, 70), "blue": (40, 90, 220), "yellow": (240, 200, 30)}

# --- Win32 ---------------------------------------------------------------------------------

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
cldapi = ctypes.WinDLL("cldapi")
ntdll = ctypes.WinDLL("ntdll")

GENERIC_READ = 0x80000000
FILE_LIST_DIRECTORY = 0x1
FILE_READ_ATTRIBUTES = 0x80
FILE_WRITE_ATTRIBUTES = 0x100
SHARE_ALL = 0x7
OPEN_EXISTING = 3
FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
INVALID_HANDLE = wintypes.HANDLE(-1).value
MOVEFILE_REPLACE_EXISTING = 0x1
FILE_ID_EXTD_DIRECTORY_INFO = 19
FILE_ID_EXTD_DIRECTORY_RESTART_INFO = 20
ERROR_NO_MORE_FILES = 18
# Folio's watcher asks for these (crates/folio-core/src/win/watcher.rs).
NOTIFY_FILTER = 0x1 | 0x2 | 0x8 | 0x10
READ_DIRECTORY_NOTIFY_EXTENDED = 2
PHCM_EXPOSE_PLACEHOLDERS = 2
CF_PLACEHOLDER_INFO_BASIC = 0
CF_PIN = {"unspecified": 0, "pinned": 1, "unpinned": 2, "excluded": 3, "inherit": 4}
CF_PIN_NAMES = {value: name for name, value in CF_PIN.items()}
CF_SET_PIN_FLAG_RECURSE = 0x1
ACTIONS = {1: "added", 2: "removed", 3: "modified", 4: "renamed-from", 5: "renamed-to"}
ATTRIBUTES = {
    0x1: "READONLY", 0x2: "HIDDEN", 0x4: "SYSTEM", 0x10: "DIRECTORY", 0x20: "ARCHIVE",
    0x100: "TEMPORARY", 0x200: "SPARSE", 0x400: "REPARSE", 0x800: "COMPRESSED",
    0x1000: "OFFLINE", 0x2000: "NOT_INDEXED", 0x40000: "RECALL_ON_OPEN",
    0x80000: "PINNED", 0x100000: "UNPINNED", 0x400000: "RECALL_ON_DATA_ACCESS",
}

kernel32.CreateFileW.restype = wintypes.HANDLE
kernel32.CreateFileW.argtypes = [
    wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
    wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.GetFileInformationByHandleEx.argtypes = [
    wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
]
kernel32.ReadDirectoryChangesExW.argtypes = [
    wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID, wintypes.LPVOID, ctypes.c_int,
]
kernel32.MoveFileExW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
kernel32.DeleteFileW.argtypes = [wintypes.LPCWSTR]
cldapi.CfSetPinState.restype = ctypes.c_long
cldapi.CfSetPinState.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_int, wintypes.LPVOID]
cldapi.CfGetPlaceholderInfo.restype = ctypes.c_long
cldapi.CfGetPlaceholderInfo.argtypes = [
    wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
]
ntdll.RtlSetProcessPlaceholderCompatibilityMode.restype = ctypes.c_char
ntdll.RtlSetProcessPlaceholderCompatibilityMode.argtypes = [ctypes.c_char]


def win_error(what: str) -> OSError:
    code = ctypes.get_last_error()
    return OSError(code, f"{what}: {ctypes.FormatError(code).strip()} ({code})")


def long_path(path: Path) -> str:
    text = str(path)
    return text if text.startswith("\\\\?\\") else "\\\\?\\" + text


class Handle:
    """CreateFileW on an existing file or folder, closed on exit."""

    def __init__(self, path: Path, access: int, flags: int = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT):
        self.path = path
        self.value = kernel32.CreateFileW(long_path(path), access, SHARE_ALL, None, OPEN_EXISTING, flags, None)
        if self.value in (None, INVALID_HANDLE):
            raise win_error(f"open {rel(path)}")

    def __enter__(self) -> int:
        return self.value

    def __exit__(self, *_: object) -> None:
        kernel32.CloseHandle(self.value)


def filetime_iso(value: int) -> str | None:
    if value <= 0:
        return None
    seconds = value / 10_000_000 - 11_644_473_600
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="milliseconds")


def list_folder(folder: Path) -> list[dict]:
    """The entries of one folder through FileIdExtdDirectoryInfo, as Folio lists them."""
    entries = []
    buffer = ctypes.create_string_buffer(64 * 1024)
    with Handle(folder, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS) as handle:
        info_class = FILE_ID_EXTD_DIRECTORY_RESTART_INFO
        while True:
            if not kernel32.GetFileInformationByHandleEx(handle, info_class, buffer, len(buffer)):
                if ctypes.get_last_error() == ERROR_NO_MORE_FILES:
                    break
                raise win_error(f"list {rel(folder)}")
            info_class = FILE_ID_EXTD_DIRECTORY_INFO
            raw = buffer.raw
            offset = 0
            while True:
                (next_offset,) = _unpack("<I", raw, offset)
                (write_time,) = _unpack("<q", raw, offset + 24)
                (size,) = _unpack("<q", raw, offset + 40)
                attributes, name_bytes, _ea, tag = _unpack("<IIII", raw, offset + 56)
                file_id = int.from_bytes(raw[offset + 72:offset + 88], "little")
                name = raw[offset + 88:offset + 88 + name_bytes].decode("utf-16-le", "surrogatepass")
                if name not in (".", ".."):
                    entries.append({
                        "name": name, "attributes": attributes, "tag": tag, "size": size,
                        "file_id": f"{file_id:032x}", "mtime": filetime_iso(write_time),
                    })
                if next_offset == 0:
                    break
                offset += next_offset
    return entries


def _unpack(fmt: str, raw: bytes, offset: int) -> tuple:
    return struct.unpack_from(fmt, raw, offset)


def move_file(source: Path, target: Path, flags: int = 0) -> None:
    if not kernel32.MoveFileExW(long_path(source), long_path(target), flags):
        raise win_error("MoveFileExW")


def placeholder_info(path: Path) -> dict:
    """Pin and in-sync state from CfGetPlaceholderInfo; {} when it is not a placeholder."""
    buffer = ctypes.create_string_buffer(4096)
    returned = wintypes.DWORD()
    try:
        with Handle(path, FILE_READ_ATTRIBUTES) as handle:
            result = cldapi.CfGetPlaceholderInfo(handle, CF_PLACEHOLDER_INFO_BASIC, buffer, len(buffer), ctypes.byref(returned))
    except OSError as error:
        return {"cf_error": str(error)}
    if result < 0:
        return {"cf_hresult": f"0x{result & 0xFFFFFFFF:08x}"}
    pin, in_sync = _unpack("<ii", buffer.raw, 0)
    return {"pin": CF_PIN_NAMES.get(pin, pin), "in_sync": bool(in_sync)}


def set_pin(path: Path, state: str, recurse: bool) -> None:
    with Handle(path, FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES) as handle:
        result = cldapi.CfSetPinState(handle, CF_PIN[state], CF_SET_PIN_FLAG_RECURSE if recurse else 0, None)
    if result < 0:
        raise OSError(result, f"CfSetPinState {state} {rel(path)}: HRESULT 0x{result & 0xFFFFFFFF:08x}")


# --- Logging ----------------------------------------------------------------------------------

_log_lock = threading.Lock()


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix() or "."
    except ValueError:
        return str(path)


def describe_name(name: str) -> dict:
    """The name, plus its normalisation and code points when it is not plain ASCII."""
    out: dict = {"name": name}
    if not name.isascii():
        nfc = unicodedata.normalize("NFC", name)
        nfd = unicodedata.normalize("NFD", name)
        out["form"] = "NFC+NFD" if name == nfc == nfd else "NFC" if name == nfc else "NFD" if name == nfd else "mixed"
        out["code_points"] = " ".join(f"U+{ord(c):04X}" for c in name if ord(c) > 0x7E)
    return out


def flags(attributes: int) -> str:
    return "|".join(label for bit, label in ATTRIBUTES.items() if attributes & bit)


def log(stream: str, record: dict, echo: bool = True) -> None:
    record = {"t": now(), **record}
    line = json.dumps(record, ensure_ascii=False)
    with _log_lock:
        LOGS.mkdir(parents=True, exist_ok=True)
        with open(LOGS / f"{stream}.jsonl", "a", encoding="utf-8", newline="\n") as file:
            file.write(line + "\n")
    if echo:
        # The console's code page (GBK here) cannot show every name; the log file keeps them all.
        print(line.encode(sys.stdout.encoding or "utf-8", "backslashreplace").decode(sys.stdout.encoding or "utf-8"), flush=True)


# --- Snapshots and watching ---------------------------------------------------------------------

def snapshot(start: Path = ROOT, with_cf: bool = True) -> dict[str, dict]:
    """Every entry below `start`, keyed by relative path."""
    result: dict[str, dict] = {}
    pending = [start]
    while pending:
        folder = pending.pop()
        try:
            entries = list_folder(folder)
        except OSError as error:
            result[rel(folder) + "/"] = {"error": str(error)}
            continue
        for entry in entries:
            path = folder / entry["name"]
            item = {
                **describe_name(entry["name"]),
                "attrs": flags(entry["attributes"]),
                "size": entry["size"],
                "file_id": entry["file_id"],
                "mtime": entry["mtime"],
            }
            if entry["tag"]:
                item["tag"] = f"0x{entry['tag']:08x}"
            if with_cf and entry["attributes"] & 0x400:
                item.update(placeholder_info(path))
            result[rel(path)] = item
            if entry["attributes"] & 0x10:
                pending.append(path)
    return result


def watch_raw(stop: threading.Event) -> None:
    """ReadDirectoryChangesExW with Folio's filter and extended records, one log line each."""
    buffer = ctypes.create_string_buffer(256 * 1024)
    returned = wintypes.DWORD()
    with Handle(ROOT, FILE_LIST_DIRECTORY, FILE_FLAG_BACKUP_SEMANTICS) as handle:
        while not stop.is_set():
            ok = kernel32.ReadDirectoryChangesExW(
                handle, buffer, len(buffer), True, NOTIFY_FILTER, ctypes.byref(returned), None, None,
                READ_DIRECTORY_NOTIFY_EXTENDED,
            )
            if not ok:
                log("observe", {"kind": "watch-error", "error": str(win_error("ReadDirectoryChangesExW"))})
                return
            if returned.value == 0:
                log("observe", {"kind": "watch-overflow"})
                continue
            raw = buffer.raw[:returned.value]
            offset = 0
            while True:
                next_offset, action = _unpack("<II", raw, offset)
                (size,) = _unpack("<q", raw, offset + 48)
                attributes, _tag = _unpack("<II", raw, offset + 56)
                file_id, _parent = _unpack("<qq", raw, offset + 64)
                (name_bytes,) = _unpack("<I", raw, offset + 80)
                name = raw[offset + 84:offset + 84 + name_bytes].decode("utf-16-le", "surrogatepass")
                log("observe", {
                    "kind": "watch", "action": ACTIONS.get(action, action),
                    **{("path" if key == "name" else key): value for key, value in describe_name(name.replace("\\", "/")).items()},
                    "size": size, "attrs": flags(attributes), "file_id": f"{file_id & 0xFFFFFFFFFFFFFFFF:016x}",
                })
                if next_offset == 0:
                    break
                offset += next_offset


def diff(before: dict[str, dict], after: dict[str, dict]) -> list[dict]:
    changes = []
    for path in sorted(after.keys() - before.keys()):
        changes.append({"kind": "appeared", "path": path, **after[path]})
    for path in sorted(before.keys() - after.keys()):
        changes.append({"kind": "vanished", "path": path, "file_id": before[path].get("file_id")})
    for path in sorted(before.keys() & after.keys()):
        old, new = before[path], after[path]
        changed = {key: [old.get(key), new.get(key)] for key in new.keys() | old.keys() if old.get(key) != new.get(key)}
        if changed:
            changes.append({"kind": "changed", "path": path, "changes": changed})
    return changes


def cmd_observe(args: argparse.Namespace) -> None:
    ntdll.RtlSetProcessPlaceholderCompatibilityMode(bytes([PHCM_EXPOSE_PLACEHOLDERS]))
    stop = threading.Event()
    threading.Thread(target=watch_raw, args=(stop,), daemon=True).start()
    probe = None
    if PROBE.exists() and not args.no_probe:
        LOGS.mkdir(parents=True, exist_ok=True)
        out = open(LOGS / "probe-watch.jsonl", "a", encoding="utf-8", newline="\n")
        probe = subprocess.Popen([str(PROBE), "watch", str(ROOT)], stdout=out, stderr=subprocess.STDOUT)
    log("observe", {"kind": "observe-start", "root": str(ROOT), "interval_s": args.interval, "probe": probe is not None})
    before = snapshot()
    log("observe", {"kind": "baseline", "entries": before}, echo=False)
    try:
        while True:
            time.sleep(args.interval)
            after = snapshot()
            for change in diff(before, after):
                log("observe", change)
            before = after
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        if probe:
            probe.terminate()
        log("observe", {"kind": "observe-stop"})


# --- Operations ---------------------------------------------------------------------------------

def target_of(relative: str) -> Path:
    """`relative` below the test folder; `{U+0301}` stands for that code point, since shells
    mangle combining marks."""
    relative = re.sub(r"\{U\+([0-9A-Fa-f]{4,6})\}", lambda match: chr(int(match.group(1), 16)), relative)
    # normpath, not resolve: resolve() returns the case already on disk, which turns a
    # case-only rename into a rename onto itself.
    path = Path(os.path.normpath(ROOT / relative))
    if path != ROOT and ROOT not in path.parents:
        raise SystemExit(f"{relative} is not below {ROOT}")
    return path


def content(args: argparse.Namespace) -> bytes:
    if args.text is not None:
        return args.text.encode("utf-8")
    if args.png is not None:
        return png(COLORS[args.png])
    return os.urandom(args.size)


def png(rgb: tuple[int, int, int], side: int = 256) -> bytes:
    """A solid square as a PNG, which the iPad's Markup can draw on."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = b"".join(b"\x00" + bytes(rgb) * side for _ in range(side))
    header = struct.pack(">IIBBBBB", side, side, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def staged(data: bytes) -> Path:
    STAGING.mkdir(parents=True, exist_ok=True)
    path = STAGING / f"src-{os.getpid()}-{time.time_ns()}.bin"
    with open(path, "wb") as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
    return path


def probe(*args: str) -> list[dict]:
    if not PROBE.exists():
        raise SystemExit(f"build the probe first: cargo build -p folio-core --example icloud_probe ({PROBE})")
    done = subprocess.run([str(PROBE), *args], capture_output=True, text=True, encoding="utf-8")
    lines = [json.loads(line) for line in done.stdout.splitlines() if line.strip()]
    if done.returncode != 0:
        raise OSError(done.returncode, json.dumps(lines, ensure_ascii=False) + done.stderr)
    return lines


def operation(name: str, path: Path | None, body, **details) -> None:
    started = time.perf_counter()
    record = {"op": name, **({"path": rel(path)} if path else {}), **details}
    try:
        result = body()
        record.update({"ok": True, **(result or {})})
    except OSError as error:
        record.update({"ok": False, "error": str(error)})
    record["ms"] = round((time.perf_counter() - started) * 1000, 1)
    log("ops", record)
    if not record["ok"]:
        sys.exit(1)


def cmd_write(args: argparse.Namespace) -> None:
    target = target_of(args.rel)
    data = content(args)
    source = staged(data)

    def body() -> dict:
        try:
            if args.mode == "new":
                probe("publish-new", str(STAGING), str(target), str(source))
            elif args.mode == "posix":
                probe("publish", str(STAGING), str(target), str(source))
            elif args.mode == "movefile":
                move_file(source, target, MOVEFILE_REPLACE_EXISTING)
            else:  # recycle-then-move
                if target.exists():
                    probe("recycle", str(target))
                probe("publish-new", str(STAGING), str(target), str(source))
            return {"sha256": hashlib.sha256(data).hexdigest()[:16]}
        finally:
            source.unlink(missing_ok=True)

    operation("write", target, body, mode=args.mode, bytes=len(data))


def cmd_edit(args: argparse.Namespace) -> None:
    target = target_of(args.rel)
    data = args.text.encode("utf-8")

    def body() -> dict:
        with open(target, "r+b") as file:
            file.write(data)
            file.truncate()
            file.flush()
            os.fsync(file.fileno())
        return {"sha256": hashlib.sha256(data).hexdigest()[:16]}

    operation("edit", target, body, bytes=len(data))


def cmd_rename(args: argparse.Namespace) -> None:
    source, target = target_of(args.source), target_of(args.target)

    operation("rename", source, lambda: move_file(source, target), to=rel(target))


def cmd_recycle(args: argparse.Namespace) -> None:
    target = target_of(args.rel)
    operation("recycle", target, lambda: {"probe": probe("recycle", str(target))[-1]["event"]})


def cmd_delete(args: argparse.Namespace) -> None:
    target = target_of(args.rel)

    def body() -> None:
        if not kernel32.DeleteFileW(long_path(target)):
            raise win_error("DeleteFileW")

    operation("delete", target, body)


def cmd_pin(args: argparse.Namespace, state: str) -> None:
    target = target_of(args.rel)
    operation(state, target, lambda: set_pin(target, state, args.recurse), recurse=args.recurse)


def cmd_state(args: argparse.Namespace) -> None:
    ntdll.RtlSetProcessPlaceholderCompatibilityMode(bytes([PHCM_EXPOSE_PLACEHOLDERS]))
    entries = snapshot()
    wanted = {rel(target_of(item)) for item in args.rel}
    for path, item in sorted(entries.items()):
        if not wanted or path in wanted:
            log("ops", {"op": "state", "path": path, **item})


def cmd_hash(args: argparse.Namespace) -> None:
    target = target_of(args.rel)

    def body() -> dict:
        digest = hashlib.sha256()
        size = 0
        with open(target, "rb") as file:
            while chunk := file.read(1 << 20):
                digest.update(chunk)
                size += len(chunk)
        preview = None
        if size <= 200:
            preview = target.read_bytes().decode("utf-8", "replace")
        return {"sha256": digest.hexdigest()[:16], "bytes": size, "text": preview}

    operation("hash", target, body)


def recycle_bin_folder() -> Path | None:
    done = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True)
    match = re.search(r"S-1-[0-9-]+", done.stdout)
    folder = Path(f"{ICLOUD.drive}\\$Recycle.Bin") / match.group(0) if match else None
    return folder if folder and folder.exists() else None


def cmd_trash(_: argparse.Namespace) -> None:
    folder = recycle_bin_folder()
    found = 0
    for info in sorted(folder.glob("$I*")) if folder else []:
        raw = info.read_bytes()
        version, size, deleted = _unpack("<qqq", raw, 0)
        if version == 2:
            (length,) = _unpack("<I", raw, 24)
            original = raw[28:28 + 2 * length].decode("utf-16-le").rstrip("\0")
        else:
            original = raw[24:24 + 520].decode("utf-16-le").split("\0")[0]
        if Path(original.lower()).is_relative_to(Path(str(ROOT).lower())):
            found += 1
            log("ops", {
                "op": "trash", "where": "recycle-bin", "original": rel(Path(original)), "size": size,
                "deleted": filetime_iso(deleted), "stored_as": info.name.replace("$I", "$R", 1),
            })
    icloud_trash = ICLOUD / ".Trash"
    for entry in sorted(icloud_trash.iterdir()) if icloud_trash.exists() else []:
        if re.match(r"t\d\d", entry.name):
            found += 1
            log("ops", {"op": "trash", "where": "icloud-.Trash", **describe_name(entry.name)})
    log("ops", {"op": "trash-done", "entries": found})


def cmd_push_sim(args: argparse.Namespace) -> None:
    """Folio's push order: the pack first, then the head record, each by one rename."""
    tag = args.tag or datetime.now().strftime("%H%M%S")
    # One flat folder, so the iPad sees both files in one listing.
    store = target_of(f"08-order/{tag}")
    store.mkdir(parents=True, exist_ok=True)
    pack_bytes = args.pack_mb * 1024 * 1024
    source = STAGING / f"pack-{tag}.bin"
    STAGING.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    with open(source, "wb") as file:
        for _ in range(args.pack_mb):
            chunk = os.urandom(1024 * 1024)
            digest.update(chunk)
            file.write(chunk)
        file.flush()
        os.fsync(file.fileno())
    pack = store / f"pack-{digest.hexdigest()[:16]}.pack"
    head = store / "head-1.json"
    record = json.dumps({"seq": 1, "packs": [{"name": pack.name, "size": pack_bytes}], "time": now()})
    operation("push-pack", pack, lambda: move_file(source, pack), bytes=pack_bytes)
    head_source = staged(record.encode())
    operation("push-head", head, lambda: move_file(head_source, head))
    started = time.monotonic()
    pending = {"pack": pack, "head": head}
    while pending and time.monotonic() - started < args.timeout:
        for label, path in list(pending.items()):
            info = placeholder_info(path)
            if info.get("in_sync"):
                log("ops", {"op": "uploaded", "what": label, "path": rel(path), "after_s": round(time.monotonic() - started, 1)})
                del pending[label]
        time.sleep(0.5)
    for label, path in pending.items():
        log("ops", {"op": "upload-timeout", "what": label, "path": rel(path), **placeholder_info(path)})


def cmd_wait(args: argparse.Namespace) -> None:
    ntdll.RtlSetProcessPlaceholderCompatibilityMode(bytes([PHCM_EXPOSE_PLACEHOLDERS]))
    target = target_of(args.rel)
    started = time.monotonic()
    while time.monotonic() - started < args.timeout:
        exists = os.path.lexists(long_path(target))
        if args.until == "gone" and not exists:
            break
        if exists and args.until == "exists":
            break
        if exists and args.until in ("local", "in-sync"):
            attributes = ctypes.windll.kernel32.GetFileAttributesW(long_path(target))
            if args.until == "local" and not attributes & (0x40000 | 0x400000):
                break
            if args.until == "in-sync" and placeholder_info(target).get("in_sync"):
                break
        time.sleep(0.25)
    else:
        log("ops", {"op": "wait-timeout", "path": rel(target), "until": args.until, "after_s": args.timeout})
        sys.exit(1)
    log("ops", {"op": "waited", "path": rel(target), "until": args.until, "after_s": round(time.monotonic() - started, 2)})


def cmd_note(args: argparse.Namespace) -> None:
    log("ipad", {"step": args.step, "report": args.text})


# --- Setup ----------------------------------------------------------------------------------------

def cmd_env(_: argparse.Namespace) -> None:
    def powershell(command: str) -> str:
        done = subprocess.run(["powershell", "-NoProfile", "-Command", command], capture_output=True, text=True, encoding="utf-8")
        return done.stdout.strip()

    log("ops", {
        "op": "env",
        "windows": platform.version(),
        "windows_display": powershell("(Get-ItemProperty 'HKLM:/SOFTWARE/Microsoft/Windows NT/CurrentVersion').DisplayVersion"),
        "windows_ubr": powershell("(Get-ItemProperty 'HKLM:/SOFTWARE/Microsoft/Windows NT/CurrentVersion').UBR"),
        "icloud": powershell("(Get-AppxPackage AppleInc.iCloud).Version"),
        "python": sys.version.split()[0],
        "root": str(ROOT), "staging": str(STAGING),
        "same_volume": ROOT.drive.lower() == STAGING.drive.lower(),
        "probe": PROBE.exists(),
    })


def cmd_init(_: argparse.Namespace) -> None:
    for name in SUBFOLDERS:
        (ROOT / name).mkdir(parents=True, exist_ok=True)
    STAGING.mkdir(parents=True, exist_ok=True)
    log("ops", {"op": "init", "folders": SUBFOLDERS})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("env").set_defaults(run=cmd_env)
    sub.add_parser("init").set_defaults(run=cmd_init)
    observe = sub.add_parser("observe")
    observe.add_argument("--interval", type=float, default=1.0)
    observe.add_argument("--no-probe", action="store_true")
    observe.set_defaults(run=cmd_observe)
    write = sub.add_parser("write")
    write.add_argument("rel")
    group = write.add_mutually_exclusive_group(required=True)
    group.add_argument("--text")
    group.add_argument("--size", type=int)
    group.add_argument("--png", choices=sorted(COLORS))
    write.add_argument("--mode", choices=["new", "posix", "movefile", "recycle-then-move"], default="new")
    write.set_defaults(run=cmd_write)
    edit = sub.add_parser("edit")
    edit.add_argument("rel")
    edit.add_argument("--text", required=True)
    edit.set_defaults(run=cmd_edit)
    rename = sub.add_parser("rename")
    rename.add_argument("source")
    rename.add_argument("target")
    rename.set_defaults(run=cmd_rename)
    for name, run in (("recycle", cmd_recycle), ("delete", cmd_delete), ("hash", cmd_hash)):
        command = sub.add_parser(name)
        command.add_argument("rel")
        command.set_defaults(run=run)
    for name, state in (("pin", "pinned"), ("unpin", "unpinned")):
        command = sub.add_parser(name)
        command.add_argument("rel")
        command.add_argument("--recurse", action="store_true")
        command.set_defaults(run=lambda args, state=state: cmd_pin(args, state))
    state = sub.add_parser("state")
    state.add_argument("rel", nargs="*")
    state.set_defaults(run=cmd_state)
    sub.add_parser("trash").set_defaults(run=cmd_trash)
    push = sub.add_parser("push-sim")
    push.add_argument("--pack-mb", type=int, default=200)
    push.add_argument("--tag")
    push.add_argument("--timeout", type=float, default=3600)
    push.set_defaults(run=cmd_push_sim)
    wait = sub.add_parser("wait")
    wait.add_argument("rel")
    wait.add_argument("--until", choices=["exists", "gone", "local", "in-sync"], required=True)
    wait.add_argument("--timeout", type=float, default=600)
    wait.set_defaults(run=cmd_wait)
    note = sub.add_parser("note")
    note.add_argument("step")
    note.add_argument("text")
    note.set_defaults(run=cmd_note)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
