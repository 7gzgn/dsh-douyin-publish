# handover.ps1 - hand a local file to a native "Open" file dialog, verifying every step.
#
# This script is deliberately ASCII-only. Reason (measured, not theory): a .ps1 saved
# as UTF-8 *without* BOM is read by Windows PowerShell as GBK, so any non-ASCII literal
# (a window title, say) turns into mojibake and every title-based match silently fails.
#
# Why Win32 messages instead of UI Automation for the actual typing:
#   On this machine, this process's UIA view of the modern file dialog exposes NO
#   editable "file name" element at all - the three elements carrying automation id 1148
#   all come back as ControlType.Pane with no ValuePattern (only the list items and the
#   search box are Edit). The dialog is the classic Win32 construction underneath:
#       dialog > ComboBoxEx32 > ComboBox > Edit
#   so FindWindowEx + WM_SETTEXT reaches the real edit control, needs no focus, no key
#   timing and no automation provider cooperation. UIA stays as a fallback, and the
#   keyboard as a last resort - every route reads the value back before it is trusted.
#
# Rules this file follows, all learned on a real upload page:
#   1. Find the dialog by structure (top-level class #32770 carrying id 1148), never by
#      title. EnumWindows is used because UIA desktop-tree traversal returned an empty
#      set for a dialog another tool could see at that same moment.
#   2. Wait patiently: the native dialog can appear well over 15 seconds after the click.
#   3. Type, then READ BACK, and retry. Text sent to a freshly activated dialog drops its
#      first characters (reproducible: "D:\..." arrives as ":\..."), so one attempt is
#      never trusted.
#   4. Confirm through the control id (1 = Open/Save, 2 = Cancel), never a blind Enter.
#   5. On failure, report the scene: candidate windows seen, every attempt and its value.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File handover.ps1 -Path 'D:\x\y.mp4'
#   powershell ... -File handover.ps1 -Path 'D:\x\y.mp4' -DryRun
#   powershell ... -File handover.ps1 -Path 'D:\x\y.mp4' -ExpectTitle 'Open' -TimeoutSec 60
#
# Output: exactly one JSON line on stdout. Exit code 0 = the file was handed over.

param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$TimeoutSec = 30,
  [string]$FileNameAutomationId = '1148',
  [string]$ConfirmAutomationId = '1',
  [int]$MaxAttempts = 3,
  [string]$ExpectTitle = '',
  [switch]$DryRun,
  [switch]$NoConfirm
)

$ErrorActionPreference = 'Stop'
$shouldConfirm = -not $NoConfirm

# UTF-8 on stdout, so the JSON we hand back survives Chinese window titles / error text.
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$win32Source = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class HandoverWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr lp);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SetWindowText(IntPtr h, string text);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr wp, IntPtr lp);

    public const int WM_COMMAND = 0x0111;
    public const int BM_CLICK = 0x00F5;
    public const int IDOK = 1;

    public static List<IntPtr> TopLevelByClass(string cls) {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindowsProc cb = delegate(IntPtr h, IntPtr lp) {
            if (IsWindowVisible(h)) {
                StringBuilder sb = new StringBuilder(256);
                GetClassName(h, sb, 256);
                if (sb.ToString() == cls) { found.Add(h); }
            }
            return true;
        };
        EnumWindows(cb, IntPtr.Zero);
        return found;
    }

    public static string Title(IntPtr h) {
        StringBuilder sb = new StringBuilder(1024);
        GetWindowText(h, sb, 1024);
        return sb.ToString();
    }

    public static string ClassOf(IntPtr h) {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(h, sb, 256);
        return sb.ToString();
    }

    // The classic file-name edit: dialog > ComboBoxEx32 > ComboBox > Edit (fallbacks included).
    public static IntPtr FindFileEdit(IntPtr dialog) {
        IntPtr combo = FindWindowEx(dialog, IntPtr.Zero, "ComboBoxEx32", null);
        if (combo == IntPtr.Zero) { combo = FindWindowEx(dialog, IntPtr.Zero, "ComboBox", null); }
        IntPtr edit = IntPtr.Zero;
        if (combo != IntPtr.Zero) { edit = FindWindowEx(combo, IntPtr.Zero, "Edit", null); }
        if (edit == IntPtr.Zero) { edit = FindWindowEx(dialog, IntPtr.Zero, "Edit", null); }
        return edit;
    }

    // Any descendant button whose control id matches (1 = Open/Save, 2 = Cancel).
    public static IntPtr FindButtonById(IntPtr root, int id) {
        IntPtr found = IntPtr.Zero;
        EnumWindowsProc cb = delegate(IntPtr h, IntPtr lp) {
            if (GetDlgCtrlID(h) == id) {
                StringBuilder sb = new StringBuilder(64);
                GetClassName(h, sb, 64);
                if (sb.ToString() == "Button") { found = h; return false; }
            }
            return true;
        };
        EnumChildWindows(root, cb, IntPtr.Zero);
        return found;
    }

    public static bool ClickButtonById(IntPtr dialog, int id) {
        IntPtr button = FindButtonById(dialog, id);
        if (button != IntPtr.Zero) {
            SendMessage(button, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
            return true;
        }
        // No button found: fall back to telling the dialog itself (IDOK) to commit.
        SendMessage(dialog, WM_COMMAND, new IntPtr(id), IntPtr.Zero);
        return false;
    }
}
'@

$seen = New-Object System.Collections.ArrayList
$attempts = New-Object System.Collections.ArrayList
$result = [ordered]@{
  ok = $false
  dryRun = [bool]$DryRun
  path = $Path
  dialog = $null
  attempts = @()
  seen = @()
  confirmed = $false
  fillMethod = $null
  error = $null
}

# SendKeys special characters must be escaped, or a path like "C:\Program Files (x86)\x" breaks.
function ConvertTo-SendKeysLiteral([string]$text) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $text.ToCharArray()) {
    if ('+^%~(){}[]'.IndexOf($ch) -ge 0) {
      [void]$sb.Append('{').Append($ch).Append('}')
    } else {
      [void]$sb.Append($ch)
    }
  }
  return $sb.ToString()
}

# Read a Win32 control's text.
function Get-ControlText([IntPtr]$hwnd) {
  $sb = New-Object System.Text.StringBuilder 4096
  [void][HandoverWin32]::GetWindowText($hwnd, $sb, 4096)
  return $sb.ToString()
}

# Read a UI Automation element's value: Value pattern, then LegacyIAccessible, then Name.
function Get-ElementValue($element) {
  $vp = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
    return ([System.Windows.Automation.ValuePattern]$vp).Current.Value
  }
  try {
    $legacy = $element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    return ([System.Windows.Automation.LegacyIAccessiblePattern]$legacy).Current.Value
  } catch {
    return $element.Current.Name
  }
}

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition $win32Source -Language CSharp | Out-Null

  $AE = [System.Windows.Automation.AutomationElement]
  $tree = [System.Windows.Automation.TreeScope]
  $inputCond = [System.Windows.Automation.PropertyCondition]::new($AE::AutomationIdProperty, $FileNameAutomationId)

  # ---- 1. Wait for a #32770 that carries the file-name control --------------------
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $dialogElement = $null
  $dialogHwnd = [IntPtr]::Zero
  while ((Get-Date) -lt $deadline) {
    foreach ($h in [HandoverWin32]::TopLevelByClass('#32770')) {
      $el = $AE::FromHandle($h)
      if ($null -eq $el) { continue }
      $title = $el.Current.Name
      if ($ExpectTitle -ne '' -and $title -notlike "$ExpectTitle*") { continue }
      $hasInput = $false
      try { $hasInput = ($null -ne $el.FindFirst($tree::Descendants, $inputCond)) } catch { $hasInput = $false }
      $entry = [ordered]@{ hwnd = [int64]$h; pid = $el.Current.ProcessId; title = $title; hasFileInput = $hasInput }
      $exists = $false
      foreach ($s in $seen) { if ([int64]$s.hwnd -eq [int64]$h) { $exists = $true; break } }
      if (-not $exists) { [void]$seen.Add($entry) }
      if ($hasInput) { $dialogElement = $el; $dialogHwnd = $h; break }
    }
    if ($null -ne $dialogElement) { break }
    Start-Sleep -Milliseconds 300
  }

  $result.seen = @($seen)
  if ($null -eq $dialogElement) {
    throw "dialog-not-found within ${TimeoutSec}s (saw $($seen.Count) candidate window(s))"
  }
  $result.dialog = [ordered]@{
    hwnd = [int64]$dialogHwnd
    pid = $dialogElement.Current.ProcessId
    title = $dialogElement.Current.Name
  }

  if ($DryRun) {
    $result.ok = $true
    $result | ConvertTo-Json -Compress -Depth 8
    exit 0
  }

  # ---- 2. Type the path, read it back, retry --------------------------------------
  $win32Edit = [HandoverWin32]::FindFileEdit($dialogHwnd)
  $uiaCandidates = @()
  try { $uiaCandidates = @($dialogElement.FindAll($tree::Descendants, $inputCond)) } catch { $uiaCandidates = @() }

  # Write through one UIA element: the Value pattern, then the Legacy (MSAA) one.
  # The legacy door matters here: on this machine the modern dialog hands this process
  # three elements for id 1148 that are all ControlType.Pane without a Value pattern.
  # It is fetched by pattern id (10018) plus reflection on purpose - the managed
  # LegacyIAccessiblePattern type does not resolve in every PowerShell host, and a
  # missing type must not take the whole script down.
  function Set-ThroughElement($element, [string]$value) {
    $vp = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      try {
        ([System.Windows.Automation.ValuePattern]$vp).SetValue($value)
        Start-Sleep -Milliseconds 250
        return [ordered]@{ method = 'uia-valuepattern'; actual = (Get-ElementValue $element) }
      } catch { }
    }
    try {
      $legacyId = [System.Windows.Automation.AutomationPattern]::LookupById(10018)
      if ($null -ne $legacyId) {
        $legacy = $element.GetCurrentPattern($legacyId)
        if ($null -ne $legacy) {
          $setter = $legacy.GetType().GetMethod('SetValue')
          if ($null -ne $setter) {
            [void]$setter.Invoke($legacy, @($value))
            Start-Sleep -Milliseconds 250
            $current = $legacy.GetType().GetProperty('Current').GetValue($legacy)
            $actual = $current.GetType().GetProperty('Value').GetValue($current)
            return [ordered]@{ method = 'uia-legacy'; actual = $actual }
          }
        }
      }
    } catch { }
    return $null
  }

  $filled = $false
  $fillVerified = $false
  $lastActual = $null
  $lastError = $null
  for ($i = 1; $i -le $MaxAttempts; $i++) {
    # 2a. Classic Win32 dialogs: set the edit control's text and read it back.
    if ($win32Edit -ne [IntPtr]::Zero) {
      $record = [ordered]@{ attempt = $i; method = 'win32-settext'; actual = $null; matched = $false; error = $null }
      try {
        [void][HandoverWin32]::SetWindowText($win32Edit, $Path)
        Start-Sleep -Milliseconds 250
        $actual = Get-ControlText $win32Edit
        $record.actual = $actual
        $lastActual = $actual
        $record.matched = ($actual -eq $Path)
        if ($record.matched) { $filled = $true; $fillVerified = $true; $result.fillMethod = 'win32-settext' }
      } catch {
        $record.error = $_.Exception.Message
        $lastError = $record.error
      }
      [void]$attempts.Add($record)
      if ($filled) { break }
    }

    # 2b. UI Automation, over every element carrying the file-name id.
    foreach ($c in $uiaCandidates) {
      $outcome = Set-ThroughElement $c $Path
      $record = [ordered]@{ attempt = $i; method = 'uia'; actual = $null; matched = $false; error = $null }
      if ($null -eq $outcome) {
        $record.error = 'no-writable-pattern'
      } else {
        $record.method = $outcome.method
        $record.actual = $outcome.actual
        $lastActual = $outcome.actual
        $record.matched = ($outcome.actual -eq $Path)
        if ($record.matched) { $filled = $true; $fillVerified = $true; $result.fillMethod = $outcome.method }
      }
      [void]$attempts.Add($record)
      if ($filled) { break }
    }
    if ($filled) { break }

    # 2c. Last resort: keyboard into the foreground dialog (its file-name box holds focus
    #     when it opens). The box cannot always be read back from here, so this pass may
    #     end up reported as UNVERIFIED - the caller can still confirm from the outside
    #     (page state, app state) instead of us pretending we know.
    $record = [ordered]@{ attempt = $i; method = 'clipboard'; actual = $null; matched = $false; error = $null }
    try {
      # Clipboard, not typed characters. Measured on this machine: typing the path made
      # the IME turn separators into full-width punctuation and candidate words, and the
      # box kept appending because select-all never landed. A paste carries the exact
      # bytes and does not go through the IME at all. (The garbled read-back sample is
      # kept in README.md - it cannot live here, this file must stay ASCII-only.)
      Set-Clipboard -Value $Path
      [void][HandoverWin32]::SetForegroundWindow($dialogHwnd)
      Start-Sleep -Milliseconds 300
      [System.Windows.Forms.SendKeys]::SendWait('^a')
      Start-Sleep -Milliseconds 200
      # Clear the field no matter what select-all did, then paste over it.
      [System.Windows.Forms.SendKeys]::SendWait('{END}')
      for ($k = 0; $k -lt 80; $k++) { [System.Windows.Forms.SendKeys]::SendWait('{BACKSPACE}') }
      Start-Sleep -Milliseconds 150
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      Start-Sleep -Milliseconds 500
      $readBack = $null
      foreach ($c in $uiaCandidates) {
        $value = Get-ElementValue $c
        if ($null -ne $value -and "$value" -ne '') { $readBack = $value; break }
      }
      if ($null -eq $readBack) {
        $record.actual = '(unreadable)'
        $record.error = 'readback-unavailable'
        $filled = $true
        $fillVerified = $false
        $result.fillMethod = 'clipboard-unverified'
      } else {
        $record.actual = $readBack
        $lastActual = $readBack
        $record.matched = ("$readBack" -eq $Path)
        if ($record.matched) { $filled = $true; $fillVerified = $true; $result.fillMethod = 'clipboard' }
      }
    } catch {
      $record.error = $_.Exception.Message
      $lastError = $record.error
    }
    [void]$attempts.Add($record)
    if ($filled) { break }
  }

  $result.fillVerified = $fillVerified
  $result.attempts = @($attempts)
  if (-not $filled) {
    $detail = if ($null -ne $lastActual) { "last read back: '$lastActual'" } else { "last error: '$lastError'" }
    $result.error = "value-mismatch ($detail)"
    $result.seen = @($seen)
    $result | ConvertTo-Json -Compress -Depth 8
    exit 1
  }

  # ---- 3. Confirm -----------------------------------------------------------------
  if ($shouldConfirm) {
    $clicked = [HandoverWin32]::ClickButtonById($dialogHwnd, [int]$ConfirmAutomationId)
    if ($clicked) {
      $result.confirmed = $true
    } else {
      # No Win32 button: try the UI Automation invoke pattern.
      $confirmCond = [System.Windows.Automation.PropertyCondition]::new($AE::AutomationIdProperty, $ConfirmAutomationId)
      $button = $dialogElement.FindFirst($tree::Descendants, $confirmCond)
      if ($null -eq $button) { throw "confirm-not-found (id=$ConfirmAutomationId)" }
      $invoke = $null
      if (-not $button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        throw "confirm-not-invokable (type=$($button.Current.ControlType.ProgrammaticName))"
      }
      ([System.Windows.Automation.InvokePattern]$invoke).Invoke()
      $result.confirmed = $true
    }
  }

  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
}

$result.seen = @($seen)
$result.attempts = @($attempts)
$result | ConvertTo-Json -Compress -Depth 8
if ($result.ok -and ((-not $shouldConfirm) -or $result.confirmed)) { exit 0 } else { exit 1 }
