import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Helpers that reach the Windows desktop from outside the app, through Windows PowerShell's inbox
// .NET (like the snap-overlay probe). A native drop presses, moves and releases the left mouse
// button for about two seconds, and recycling puts the test's files in the Recycle Bin, so the
// specs that use them run on CI, and locally only with FOLIO_E2E_DESKTOP=1.

const execute = promisify(execFile);

/** Whether this run may use the mouse and the Recycle Bin. */
export const desktopAllowed = process.env.CI === 'true' || process.env.FOLIO_E2E_DESKTOP === '1';
export const desktopSkipReason = 'uses the mouse or the Recycle Bin: CI runs it, or set FOLIO_E2E_DESKTOP=1';

/** Runs a PowerShell script whose output is one JSON value, as Base64 so non-ASCII text survives. */
async function powershell<T>(script: string, timeout = 60_000): Promise<T> {
  const wrapped = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$json = & { ${script} } | ConvertTo-Json -Depth 4 -Compress
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
`;
  try {
    const { stdout } = await execute(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64')],
      { windowsHide: true, timeout },
    );
    return JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8')) as T;
  } catch (error) {
    // The default message repeats the whole encoded script; keep the outcome and what PowerShell said.
    const { code, signal, stderr } = error as { code?: unknown; signal?: unknown; stderr?: string };
    throw new Error(`PowerShell failed (exit ${String(code)}, signal ${String(signal)}): ${stderr ?? ''}`);
  }
}

// The drag starts on a small window of the helper, shown over the far corner of Folio's client
// area, because Windows starts a drag only while a mouse button is down. The button goes down only
// once that window is under the pointer, and the drop source drops only over Folio's window, so
// no click or file lands anywhere else.
const dropSource = String.raw`
using System;
using System.Collections.Specialized;
using System.ComponentModel;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class NativeDrop {
  [ComImport, Guid("00000121-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IDropSource {
    [PreserveSig] int QueryContinueDrag([MarshalAs(UnmanagedType.Bool)] bool escapePressed, uint keyState);
    [PreserveSig] int GiveFeedback(uint effect);
  }

  const int S_OK = 0, DRAGDROP_S_DROP = 0x40100, DRAGDROP_S_CANCEL = 0x40101, DRAGDROP_S_USEDEFAULTCURSORS = 0x40102;
  const uint DROPEFFECT_COPY = 1, GA_ROOT = 2, MK_LBUTTON = 1;
  const uint INPUT_MOUSE = 0, MOUSEEVENTF_MOVE = 0x1, MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4;
  const uint MOUSEEVENTF_VIRTUALDESK = 0x4000, MOUSEEVENTF_ABSOLUTE = 0x8000;
  const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
  static readonly IntPtr PerMonitorAwareV2 = new IntPtr(-4);
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1), HWND_NOTOPMOST = new IntPtr(-2);
  // SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE: only the window's place in the z-order changes.
  const uint SWP_KEEP = 0x1 | 0x2 | 0x10;

  // Windows' own drop source drops when the button goes up; this one only over Folio's window.
  class Source : IDropSource {
    readonly IntPtr main;
    public Source(IntPtr main) { this.main = main; }
    public int QueryContinueDrag(bool escapePressed, uint keyState) {
      if (escapePressed) return DRAGDROP_S_CANCEL;
      if ((keyState & MK_LBUTTON) != 0) return S_OK;
      POINT at;
      GetCursorPos(out at);
      return Over(main, at) ? DRAGDROP_S_DROP : DRAGDROP_S_CANCEL;
    }
    public int GiveFeedback(uint effect) { return DRAGDROP_S_USEDEFAULTCURSORS; }
  }

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public MOUSEINPUT mouse; }
  delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);
  [DllImport("ole32.dll")] static extern int OleInitialize(IntPtr reserved);
  [DllImport("ole32.dll")] static extern int DoDragDrop(System.Runtime.InteropServices.ComTypes.IDataObject data, IDropSource source, uint allowed, out uint effect);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hwnd, System.Text.StringBuilder name, int capacity);
  [DllImport("user32.dll", SetLastError = true)] static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll", SetLastError = true)] static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

  static IntPtr MainWindow(int processId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      var name = new System.Text.StringBuilder(64);
      GetClassNameW(hwnd, name, name.Capacity);
      if (owner != processId || !IsWindowVisible(hwnd) || name.ToString() != "Tauri Window") return true;
      found = hwnd;
      return false;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) throw new InvalidOperationException("Folio shows no main window");
    return found;
  }

  static bool Over(IntPtr window, POINT point) { return GetAncestor(WindowFromPoint(point), GA_ROOT) == window; }

  // Moves the pointer to a screen point, pressing or releasing the left button there.
  static bool Mouse(POINT at, uint button) {
    int left = GetSystemMetrics(SM_XVIRTUALSCREEN), top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int width = GetSystemMetrics(SM_CXVIRTUALSCREEN), height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    var input = new INPUT { type = INPUT_MOUSE };
    input.mouse.dx = (int)Math.Round((at.X - left) * 65535.0 / (width - 1));
    input.mouse.dy = (int)Math.Round((at.Y - top) * 65535.0 / (height - 1));
    input.mouse.flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | button;
    return SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
  }

  // Drags the files from outside the app onto a point of Folio's page (CSS pixels), rests there,
  // and drops them. Puts the pointer back where it was. The window of a test running beside this
  // one may open over Folio's, so Folio's stays above other windows, unactivated, for the drag.
  public static object Drop(int processId, string[] files, double cssX, double cssY, int restMs) {
    SetThreadDpiAwarenessContext(PerMonitorAwareV2);
    OleInitialize(IntPtr.Zero);
    IntPtr main = MainWindow(processId);
    SetWindowPos(main, HWND_TOPMOST, 0, 0, 0, 0, SWP_KEEP);
    try {
      return DropOnto(main, files, cssX, cssY, restMs);
    } finally {
      SetWindowPos(main, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_KEEP);
    }
  }

  static object DropOnto(IntPtr main, string[] files, double cssX, double cssY, int restMs) {
    POINT origin = new POINT();
    if (!ClientToScreen(main, ref origin)) throw new Win32Exception(Marshal.GetLastWin32Error());
    RECT client;
    if (!GetClientRect(main, out client)) throw new Win32Exception(Marshal.GetLastWin32Error());
    double scale = GetDpiForWindow(main) / 96.0;
    POINT target = new POINT { X = origin.X + (int)Math.Round(cssX * scale), Y = origin.Y + (int)Math.Round(cssY * scale) };
    POINT source = new POINT { X = origin.X + client.Right - (int)(64 * scale), Y = origin.Y + client.Bottom - (int)(64 * scale) };
    if (!Over(main, target)) return new { result = "covered" };
    POINT start;
    GetCursorPos(out start);

    var list = new StringCollection();
    list.AddRange(files);
    string result = "not started";
    uint effect = 0;
    using (var form = new Form()) {
      form.FormBorderStyle = FormBorderStyle.None;
      form.ShowInTaskbar = false;
      form.TopMost = true;
      form.StartPosition = FormStartPosition.Manual;
      form.Bounds = new Rectangle(source.X - 24, source.Y - 24, 48, 48);
      form.BackColor = Color.SteelBlue;
      form.MouseDown += delegate {
        var data = new DataObject();
        data.SetFileDropList(list);
        int answer = DoDragDrop(data, new Source(main), DROPEFFECT_COPY, out effect);
        result = answer == DRAGDROP_S_DROP ? "dropped" : answer == DRAGDROP_S_CANCEL ? "cancelled" : "error " + answer.ToString("x");
        form.BeginInvoke((MethodInvoker)form.Close);
      };
      // A press that never reaches the window starts no drag: give up, so the pointer goes back.
      var watchdog = new System.Windows.Forms.Timer { Interval = 20000 };
      watchdog.Tick += delegate { watchdog.Stop(); form.Close(); };
      form.Shown += delegate {
        watchdog.Start();
        IntPtr handle = form.Handle;
        var driver = new Thread(delegate() {
          SetThreadDpiAwarenessContext(PerMonitorAwareV2);
          Thread.Sleep(300);
          if (!Mouse(source, 0)) {
            result = "no input desktop";
          } else {
            Thread.Sleep(150);
            if (GetAncestor(WindowFromPoint(source), GA_ROOT) != handle) {
              result = "source covered";
            } else {
              Mouse(source, MOUSEEVENTF_LEFTDOWN);
              Thread.Sleep(150);
              for (int step = 1; step <= 15; step++) {
                Mouse(new POINT { X = source.X + (target.X - source.X) * step / 15, Y = source.Y + (target.Y - source.Y) * step / 15 }, 0);
                Thread.Sleep(30);
              }
              Thread.Sleep(restMs);
              Mouse(target, MOUSEEVENTF_LEFTUP);
              return;
            }
          }
          form.BeginInvoke((MethodInvoker)form.Close);
        });
        driver.IsBackground = true;
        driver.Start();
      };
      Application.Run(form);
    }
    SetCursorPos(start.X, start.Y);
    return new { result = result, effect = effect, x = target.X, y = target.Y, scale = scale };
  }
}
`;

export interface DropOutcome {
  result: 'dropped' | 'cancelled' | 'covered' | 'source covered' | 'no input desktop' | 'not started' | `error ${string}`;
}

/**
 * Drags `files` from outside the app onto the point (CSS pixels of the page) of Folio's window,
 * with Windows' own drag and drop (OLE, CF_HDROP), as File Explorer does.
 */
export function nativeDrop(processId: number, files: string[], point: { x: number; y: number }, restMs = 900): Promise<DropOutcome> {
  return powershell<DropOutcome>(`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
${dropSource}
'@
[NativeDrop]::Drop(${String(processId)}, @(${files.map((file) => `'${file.replaceAll("'", "''")}'`).join(', ')}), ${String(point.x)}, ${String(point.y)}, ${String(restMs)})
`);
}

/**
 * The names of the Recycle Bin's items that came from `folder` (a long path, as `realpath` gives
 * it), without extensions: File Explorer may hide them in display names.
 */
export async function recycledFrom(folder: string): Promise<string[]> {
  const names = await powershell<string[] | string | null>(`
$bin = (New-Object -ComObject Shell.Application).NameSpace(10)
@($bin.Items() | Where-Object { $_.ExtendedProperty('System.Recycle.DeletedFrom') -eq '${folder.replaceAll("'", "''")}' } | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_.Name) })
`);
  // ConvertTo-Json writes a one-item array as its item.
  return names === null ? [] : Array.isArray(names) ? names : [names];
}
