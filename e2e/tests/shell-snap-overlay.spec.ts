import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import titlebar from '../../apps/desktop/src/i18n/locales/en/titlebar.json' with { type: 'json' };
import { expect, test } from '../fixtures';

// The snap layouts overlay is a native window (crates/folio-app/src/window_chrome.rs) that
// Playwright cannot see. This spec reads it from outside with Win32 and UI Automation through
// Windows PowerShell's inbox .NET client: it only queries, and sends WM_NCHITTEST to the app's
// own windows. It never moves the mouse or sends input.

const execute = promisify(execFile);

const HTTRANSPARENT = -1;
const HTMAXBUTTON = 9;
const HTTOP = 12;
const OVERLAY = 'FolioSnapLayoutsOverlay';
/** Tauri's own child window that resizes undecorated windows (tauri-runtime-wry). */
const RESIZE_BORDER = 'TAURI_DRAG_RESIZE_BORDERS';

/** The window that gets the mouse at a point, and its hit-test answer. */
interface Route {
  window: string;
  hit: number;
}

interface UiaElement {
  name: string;
  controlType: string;
  handle: number;
  control: boolean;
  content: boolean;
}

interface NativeSnapshot {
  maximized: boolean;
  mainWindow: number;
  /** SM_CYFRAME at the window's DPI: the height of the top resize border. */
  band: number;
  /** The overlay's own answer on the window's top row. */
  overlayOnTopRow: number;
  /** The top row just left of the button, where the overlay does not reach. */
  edgeTopRow: Route;
  topRow: Route;
  lastBandRow: Route;
  firstRowBelowBand: Route;
  center: Route;
  overlay: UiaElement;
  /** Where a screen reader lands from the overlay: its nearest element in the control view. */
  overlayInControlView: UiaElement;
  controlViewMatches: number;
  contentViewMatches: number;
  /** Names of the control-view buttons at the overlay's centre. */
  buttons: string[];
}

const probe = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public static class SnapProbe {
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
  delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string className, string title);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int capacity);
  [DllImport("user32.dll", SetLastError = true)] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll", SetLastError = true)] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
  [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr hwnd, IntPtr region);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int index, uint dpi);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
  [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
  [DllImport("gdi32.dll")] static extern bool PtInRegion(IntPtr region, int x, int y);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);

  const uint GW_HWNDNEXT = 2, GW_CHILD = 5, WM_NCHITTEST = 0x84, SMTO_ABORTIFHUNG_ERRORONEXIT = 0x22;
  const int HTTRANSPARENT = -1, SM_CYFRAME = 33, NO_REGION = 0;
  static readonly IntPtr PerMonitorAwareV2 = new IntPtr(-4);

  static int HitTest(IntPtr hwnd, int x, int y) {
    // WM_NCHITTEST packs signed 16-bit screen coordinates.
    int packed = unchecked((y & 0xffff) << 16 | (x & 0xffff));
    IntPtr result;
    if (SendMessageTimeoutW(hwnd, WM_NCHITTEST, UIntPtr.Zero, new IntPtr(packed), SMTO_ABORTIFHUNG_ERRORONEXIT, 2000, out result) == IntPtr.Zero)
      throw new Win32Exception(Marshal.GetLastWin32Error(), "WM_NCHITTEST failed or timed out");
    return unchecked((int)result.ToInt64());
  }

  static bool Contains(IntPtr hwnd, int x, int y) {
    Rect rect;
    if (!IsWindowVisible(hwnd) || !GetWindowRect(hwnd, out rect)) return false;
    if (x < rect.Left || x >= rect.Right || y < rect.Top || y >= rect.Bottom) return false;
    IntPtr region = CreateRectRgn(0, 0, 0, 0);
    try {
      // Window regions are relative to the window's top-left corner.
      return GetWindowRgn(hwnd, region) == NO_REGION || PtInRegion(region, x - rect.Left, y - rect.Top);
    } finally {
      DeleteObject(region);
    }
  }

  static uint ThreadOf(IntPtr hwnd) {
    uint processId;
    return GetWindowThreadProcessId(hwnd, out processId);
  }

  static string ClassOf(IntPtr hwnd) {
    var name = new StringBuilder(256);
    GetClassNameW(hwnd, name, name.Capacity);
    return name.ToString();
  }

  // Where the mouse goes at a screen point, as Windows decides it: the topmost child that
  // contains the point and does not answer HTTRANSPARENT. HTTRANSPARENT hands the point only to
  // windows of the same thread, and last to the main window itself.
  static object Route(IntPtr main, int x, int y) {
    uint passedBy = 0;
    for (IntPtr child = GetWindow(main, GW_CHILD); child != IntPtr.Zero; child = GetWindow(child, GW_HWNDNEXT)) {
      if (!Contains(child, x, y) || (passedBy != 0 && ThreadOf(child) != passedBy)) continue;
      int hit = HitTest(child, x, y);
      if (hit != HTTRANSPARENT) return new { window = ClassOf(child), hit };
      passedBy = ThreadOf(child);
    }
    return new { window = ClassOf(main), hit = HitTest(main, x, y) };
  }

  static object Describe(AutomationElement element) {
    var current = element.Current;
    return new {
      name = current.Name, controlType = current.ControlType.ProgrammaticName,
      handle = current.NativeWindowHandle, control = current.IsControlElement, content = current.IsContentElement
    };
  }

  public static object Read(int processId) {
    IntPtr previousDpi = SetThreadDpiAwarenessContext(PerMonitorAwareV2);
    if (previousDpi == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      IntPtr main = IntPtr.Zero, overlay = IntPtr.Zero;
      // The page shows the overlay once it has measured the maximize button.
      for (int attempt = 0; overlay == IntPtr.Zero && attempt < 50; attempt++) {
        if (attempt > 0) Thread.Sleep(100);
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
          uint owner;
          GetWindowThreadProcessId(hwnd, out owner);
          if (owner != processId || !IsWindowVisible(hwnd)) return true;
          IntPtr candidate = FindWindowExW(hwnd, IntPtr.Zero, "${OVERLAY}", null);
          if (candidate == IntPtr.Zero || !IsWindowVisible(candidate)) return true;
          main = hwnd;
          overlay = candidate;
          return false;
        }, IntPtr.Zero);
      }
      if (overlay == IntPtr.Zero) throw new InvalidOperationException("Folio shows no snap layouts overlay");

      Rect button;
      if (!GetWindowRect(overlay, out button)) throw new Win32Exception(Marshal.GetLastWin32Error());
      Point client = new Point();
      if (!ClientToScreen(main, ref client)) throw new Win32Exception(Marshal.GetLastWin32Error());
      int band = GetSystemMetricsForDpi(SM_CYFRAME, GetDpiForWindow(main));
      int x = (button.Left + button.Right) / 2, y = (button.Top + button.Bottom) / 2;

      var root = AutomationElement.FromHandle(main);
      var overlayElement = AutomationElement.FromHandle(overlay);
      var isOverlay = new PropertyCondition(AutomationElement.NativeWindowHandleProperty, unchecked((int)overlay.ToInt64()));
      var isButton = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button);
      var buttons = new List<string>();
      // Compare rectangles in UI Automation's own coordinates, whatever the display scaling.
      var overlayBox = overlayElement.Current.BoundingRectangle;
      var overlayCenter = new System.Windows.Point(overlayBox.X + overlayBox.Width / 2, overlayBox.Y + overlayBox.Height / 2);
      // WebView2 builds the page's accessibility tree on the first UI Automation request.
      for (int attempt = 0; buttons.Count == 0 && attempt < 50; attempt++) {
        if (attempt > 0) Thread.Sleep(100);
        foreach (AutomationElement element in root.FindAll(TreeScope.Descendants, new AndCondition(Automation.ControlViewCondition, isButton)))
          if (element.Current.BoundingRectangle.Contains(overlayCenter)) buttons.Add(element.Current.Name);
      }

      return new {
        maximized = IsZoomed(main), mainWindow = unchecked((int)main.ToInt64()), band,
        overlayOnTopRow = HitTest(overlay, x, client.Y),
        edgeTopRow = Route(main, button.Left - 1, client.Y),
        topRow = Route(main, x, client.Y),
        lastBandRow = Route(main, x, client.Y + band - 1),
        firstRowBelowBand = Route(main, x, client.Y + band),
        center = Route(main, x, y),
        overlay = Describe(overlayElement),
        overlayInControlView = Describe(TreeWalker.ControlViewWalker.Normalize(overlayElement)),
        controlViewMatches = root.FindAll(TreeScope.Descendants, new AndCondition(Automation.ControlViewCondition, isOverlay)).Count,
        contentViewMatches = root.FindAll(TreeScope.Descendants, new AndCondition(Automation.ContentViewCondition, isOverlay)).Count,
        buttons = buttons.ToArray()
      };
    } finally {
      SetThreadDpiAwarenessContext(previousDpi);
    }
  }
}
`;

async function readNativeWindow(processId: number): Promise<NativeSnapshot> {
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$references = @(
  [Windows.Automation.AutomationElement].Assembly.Location
  [Windows.Automation.ControlType].Assembly.Location
  [Windows.Rect].Assembly.Location
)
Add-Type -ReferencedAssemblies $references -TypeDefinition @'
${probe}
'@
$json = [SnapProbe]::Read(${String(processId)}) | ConvertTo-Json -Depth 4 -Compress
# Base64 keeps non-ASCII names intact through the console code page.
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
`;
  try {
    const { stdout } = await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, timeout: 30_000 },
    );
    return JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8')) as NativeSnapshot;
  } catch (error) {
    // The default message repeats the whole encoded script; keep the outcome and what PowerShell
    // said. A timeout leaves stderr empty.
    const { code, signal, stderr } = error as { code?: unknown; signal?: unknown; stderr?: string };
    throw new Error(
      `The native probe failed (exit ${String(code)}, signal ${String(signal)}): ${stderr ?? ''}`,
    );
  }
}

test('snap overlay leaves the top edge to resizing and stays out of UI Automation views', async ({
  folio,
}) => {
  const { page, processId } = folio;
  const states = [
    { maximized: false, name: titlebar.maximize },
    { maximized: true, name: titlebar.restore },
    // Restoring must bring the resize border back.
    { maximized: false, name: titlebar.maximize },
  ];

  const snapshots: NativeSnapshot[] = [];
  for (const [index, state] of states.entries()) {
    if (index > 0) await page.keyboard.press('Enter');
    const button = page.getByRole('button', { name: state.name });
    await button.focus();
    snapshots.push(await readNativeWindow(processId));
  }
  // Keep the evidence when an assertion fails.
  await test.info().attach('native-snapshots', {
    body: JSON.stringify(snapshots, null, 2),
    contentType: 'application/json',
  });

  for (const [index, snapshot] of snapshots.entries()) {
    const { maximized, name } = states[index]!;
    expect(snapshot.maximized, `state ${String(index)}`).toBe(maximized);
    if (maximized) {
      // No resize border: the whole button opens the snap layouts flyout.
      expect(snapshot.overlayOnTopRow).toBe(HTMAXBUTTON);
      expect(snapshot.topRow).toEqual({ window: OVERLAY, hit: HTMAXBUTTON });
      expect(snapshot.edgeTopRow.window).not.toBe(RESIZE_BORDER);
    } else {
      const resize = { window: RESIZE_BORDER, hit: HTTOP };
      expect(snapshot.overlayOnTopRow).toBe(HTTRANSPARENT);
      expect(snapshot.edgeTopRow).toEqual(resize);
      expect(snapshot.topRow).toEqual(resize);
      expect(snapshot.lastBandRow).toEqual(resize);
      expect(snapshot.firstRowBelowBand).toEqual({ window: OVERLAY, hit: HTMAXBUTTON });
    }
    expect(snapshot.center).toEqual({ window: OVERLAY, hit: HTMAXBUTTON });

    expect(snapshot.overlay).toMatchObject({ control: false, content: false });
    expect(snapshot.controlViewMatches).toBe(0);
    expect(snapshot.contentViewMatches).toBe(0);
    // From the overlay a screen reader lands on the main window, not on an unnamed pane.
    expect(snapshot.overlayInControlView.handle).toBe(snapshot.mainWindow);
    expect(snapshot.overlayInControlView.name).not.toBe('');
    // The HTML button stays the accessible control at that spot.
    expect(snapshot.buttons).toContain(name);
  }
});
