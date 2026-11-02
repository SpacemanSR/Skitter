# Drive Skitter with the real mouse and keyboard on Windows and check he answers every click.
#   Round 1: click him, type, Enter -> he fetches; click the card -> file opens
#   Round 2: click him again -> the task box must open again (the bug from 0.3.1), type, Enter -> he fetches
#   Round 3: while the card is up, click him -> he goes back for another file
# Usage: powershell -File tools/click-test.ps1 -Exe <Skitter.exe | electron.exe> [-AppArg .]
param([Parameter(Mandatory = $true)][string]$Exe, [string]$AppArg = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public static void Click(int x, int y) { SetCursorPos(x, y); System.Threading.Thread.Sleep(250); SetCursorPos(x + 1, y); System.Threading.Thread.Sleep(250);
    mouse_event(2, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(60); mouse_event(4, 0, 0, 0, UIntPtr.Zero); }
}
"@
$root = Split-Path $PSScriptRoot -Parent
$Exe = (Resolve-Path $Exe).Path
$data = Join-Path $env:TEMP ("skitter-click-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$env:GOFER_USERDATA = $data
$env:GOFER_DEBUG = '1'
$env:GOFER_ROOTS = (Join-Path $root 'tests\fixtures\Documents') + ';' + (Join-Path $root 'tests\fixtures\Desktop')
if (-not $env:GOFER_MODEL_DIR -and (Test-Path (Join-Path $root 'model'))) { $env:GOFER_MODEL_DIR = Join-Path $root 'model' }
$log = Join-Path $data 'gofer.log'
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
Write-Host "work area $($wa.X),$($wa.Y) $($wa.Width)x$($wa.Height)"

# Something to steal the foreground the way a real document app does after the card is clicked.
$p = if ($AppArg) { Start-Process -FilePath $Exe -ArgumentList $AppArg -WorkingDirectory $root -PassThru } else { Start-Process -FilePath $Exe -PassThru }
function Lines { if (Test-Path $log) { Get-Content $log } else { @() } }
function Mode { $m = Lines | Select-String '\[mode\] (\w+)' | Select-Object -Last 1; if ($m) { $m.Matches[0].Groups[1].Value } else { 'idle' } }
function Zones { $z = Lines | Select-String '\[zones\] (.*)$' | Select-Object -Last 1; if ($z) { ,($z.Matches[0].Groups[1].Value | ConvertFrom-Json) } else { $null } }
function WaitFor($what, $test, $sec) { $t = [DateTime]::Now.AddSeconds($sec); while ([DateTime]::Now -lt $t) { if (& $test) { return $true }; Start-Sleep -Milliseconds 200 }; Write-Host "TIMEOUT waiting for $what (mode=$(Mode))"; return $false }
function ClickHim { $z = Zones; $c = $z[0]; Write-Host "click him at $($c[0] + 36),$($c[1] + 36)"; [M]::Click($wa.X + $c[0] + 36, $wa.Y + $c[1] + 36) }
function ClickCard { $z = Zones; $k = $z | Where-Object { $_[2] -gt 200 } | Select-Object -First 1; Write-Host "click card at $($k[0] + 40),$($k[1] + 30)"; [M]::Click($wa.X + $k[0] + 40, $wa.Y + $k[1] + 30) }
$results = @()
function Check($name, $ok) { $script:results += [pscustomobject]@{ Check = $name; Pass = [bool]$ok }; Write-Host ($(if ($ok) { 'PASS ' } else { 'FAIL ' }) + $name) }

try {
  WaitFor 'index' { (Lines | Select-String 'scan done') -and (Zones) } 90 | Out-Null
  Start-Sleep 2
  foreach ($round in 1, 2) {
    ClickHim
    $ok = WaitFor 'task box' { (Mode) -eq 'ask' } 4
    Check "round $round`: click opens the task box" $ok
    if (-not $ok) { break }
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait('budget{ENTER}')
    $ok = WaitFor 'card' { (Mode) -eq 'present' } 20
    Check "round $round`: typing reached the box and he came back with a file" $ok
    if (-not $ok) { break }
    Start-Sleep 1
    if ($round -eq 1) {
      ClickCard
      Check "round 1: clicking the card opens the file" (WaitFor 'accept' { (Lines | Select-String '"outcome":"accept"|\[mode\] happy') } 4)
      # stand in for Excel/Word grabbing the foreground
      Start-Process notepad.exe; Start-Sleep 2
      WaitFor 'idle' { (Mode) -eq 'idle' } 5 | Out-Null
      Start-Sleep 1
    } else {
      ClickHim
      Check 'round 2: clicking him while the card is up sends him for another' (WaitFor 'retry' { (Lines | Select-String 'fetch task .*excl|\[mode\] trip' | Measure-Object).Count -ge 3 } 5)
    }
  }
} finally {
  Lines | Select-String -NotMatch '\[zones\]' | Select-Object -Last 40 | ForEach-Object { Write-Host "  log: $_" }
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process electron, Skitter -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
$failed = $results | Where-Object { -not $_.Pass }
if ($failed -or $results.Count -lt 5) { Write-Host "click test failed"; exit 1 }
Write-Host "click test passed"
