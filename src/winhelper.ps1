# Gofer's Windows context helper.
# - Event-driven: reports the foreground window (process + title) when it changes or retitles (SetWinEventHook, no polling).
# - On request ("text <id>" on stdin), reads the text around the caret in the focused control via UI Automation.
#   Password fields are never read. Output is JSON lines on stdout. Exits when stdin closes (parent quit).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$refs = @(
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.TextPatternRangeEndpoint].Assembly.Location
)
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using System.Windows.Automation.Text;

public static class GoferHelper {
  public delegate void WinEventDelegate(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr hmod, WinEventDelegate cb, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

  const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
  const uint EVENT_OBJECT_NAMECHANGE = 0x800C;
  static WinEventDelegate callback;
  static IntPtr nameHook = IntPtr.Zero;
  static uint hookedPid = 0;
  static readonly object outLock = new object();
  static string last = "";

  static void Emit(string json) { lock (outLock) { Console.Out.WriteLine(json); Console.Out.Flush(); } }

  static string Esc(string s) {
    if (s == null) return "";
    StringBuilder b = new StringBuilder(s.Length + 16);
    foreach (char c in s) {
      switch (c) {
        case '"': b.Append("\\\""); break;
        case '\\': b.Append("\\\\"); break;
        case '\n': b.Append("\\n"); break;
        case '\r': b.Append("\\r"); break;
        case '\t': b.Append("\\t"); break;
        default: if (c < 0x20) b.Append("\\u" + ((int)c).ToString("x4")); else b.Append(c); break;
      }
    }
    return b.ToString();
  }

  static void Report() {
    IntPtr h = GetForegroundWindow();
    StringBuilder sb = new StringBuilder(1024);
    GetWindowText(h, sb, 1024);
    uint pid; GetWindowThreadProcessId(h, out pid);
    string proc = "";
    try { proc = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
    if (pid != hookedPid) {
      // listen for title changes only inside the foreground app
      if (nameHook != IntPtr.Zero) UnhookWinEvent(nameHook);
      nameHook = SetWinEventHook(EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE, IntPtr.Zero, callback, pid, 0, 0);
      hookedPid = pid;
    }
    string key = proc + "\t" + sb.ToString();
    if (key == last) return;
    last = key;
    Emit("{\"t\":\"fg\",\"proc\":\"" + Esc(proc) + "\",\"title\":\"" + Esc(sb.ToString()) + "\"}");
  }

  static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    try {
      if (ev == EVENT_OBJECT_NAMECHANGE && (idObject != 0 || hwnd != GetForegroundWindow())) return;
      Report();
    } catch (Exception) { }
  }

  static string FocusedText(out string src) {
    src = "none";
    AutomationElement el = AutomationElement.FocusedElement;
    if (el == null) return "";
    if (el.Current.IsPassword) { src = "password"; return ""; }
    object p;
    for (int depth = 0; depth < 3 && el != null; depth++) {
      if (el.TryGetCurrentPattern(TextPattern.Pattern, out p)) {
        TextPattern tp = (TextPattern)p;
        try {
          TextPatternRange[] sel = tp.GetSelection();
          if (sel != null && sel.Length > 0) {
            TextPatternRange r = sel[0].Clone();
            r.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, -1500);
            r.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, 400);
            string s = r.GetText(2400);
            if (!String.IsNullOrEmpty(s) && s.Trim().Length > 0) { src = "caret"; return s; }
          }
        } catch (Exception) { }
        try { string s = tp.DocumentRange.GetText(3000); if (!String.IsNullOrEmpty(s)) { src = "doc"; return s; } } catch (Exception) { }
      }
      if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) {
        string v = ((ValuePattern)p).Current.Value ?? "";
        if (v.Length > 0) { src = "value"; return v.Length > 2400 ? v.Substring(v.Length - 2400) : v; }
      }
      el = TreeWalker.ControlViewWalker.GetParent(el);
      if (el != null && el.Current.IsPassword) return "";
    }
    return "";
  }

  static void ReadStdin() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      line = line.Trim();
      if (line.StartsWith("text")) {
        string id = line.Length > 5 ? line.Substring(5).Trim() : "0";
        string src = "none", txt = "";
        Thread t = new Thread(delegate () { try { txt = FocusedText(out src); } catch (Exception e) { src = "error:" + e.GetType().Name; } });
        t.SetApartmentState(ApartmentState.MTA); t.IsBackground = true; t.Start();
        if (!t.Join(2500)) src = "timeout";
        Emit("{\"t\":\"text\",\"id\":\"" + Esc(id) + "\",\"src\":\"" + Esc(src) + "\",\"text\":\"" + Esc(txt) + "\"}");
      } else if (line == "ping") {
        Emit("{\"t\":\"pong\"}");
      } else if (line == "quit") break;
    }
    Environment.Exit(0);
  }

  public static void Run() {
    Console.OutputEncoding = new UTF8Encoding(false);
    callback = new WinEventDelegate(OnEvent);
    SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, callback, 0, 0, 0);
    Thread reader = new Thread(ReadStdin);
    reader.IsBackground = true; reader.Start();
    Emit("{\"t\":\"ready\"}");
    Report();
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessage(ref m); }
  }
}
'@
[GoferHelper]::Run()
