# Drive Skitter with the real mouse and keyboard on Windows and check he answers every click.
#   Round 1: click him, type, Enter -> he fetches; click the card -> the file opens
#   Round 2: another app has the foreground; click him -> the task box opens again (the 0.3.1 bug), fetch
#   Round 3: with the card still up, click him -> the task box opens again; fetch; "Not this one" -> retry
#   Round 4: a PDF with a preview: hover the picture (card opens wide), glide down, click "click to open"
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

# Earlier pipeline steps open the test spreadsheet on a runner with no Excel, which leaves Windows'
# "Open with" dialog holding the keyboard; start from a clean desktop.
Get-Process OpenWith -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
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
  function Ask($label, $query = 'budget') {
    ClickHim
    $ok = WaitFor 'task box' { (Mode) -eq 'ask' } 4
    Check "$label`: clicking him opens the task box" $ok
    if (-not $ok) { return $false }
    Start-Sleep -Milliseconds 500
    [System.Windows.Forms.SendKeys]::SendWait($query + '{ENTER}')
    $ok = WaitFor 'card' { (Mode) -eq 'present' } 20
    Check "$label`: what I typed reached the box and he came back with a file" $ok
    Start-Sleep 1
    return $ok
  }
  if (Ask 'round 1') {
    ClickCard
    Check 'round 1: clicking the card opens the file' (WaitFor 'accept' { (Lines | Select-String '\[mode\] happy') } 4)
    Start-Process notepad.exe; Start-Sleep 2   # stand in for Excel/Word taking the foreground
    WaitFor 'idle' { (Mode) -eq 'idle' } 5 | Out-Null
    Start-Sleep 1
    if (Ask 'round 2 (after a file opened)') {
      if (Ask 'round 3 (card still up)') {
        $z = Zones; $k = $z | Where-Object { $_[2] -gt 200 } | Select-Object -First 1
        $before = (Lines | Select-String '\[mode\] trip').Count
        Write-Host "click Not this one at $($k[0] + $k[2] - 50),$($k[1] + $k[3] - 24)"
        [M]::Click($wa.X + $k[0] + $k[2] - 50, $wa.Y + $k[1] + $k[3] - 24)
        Check "'Not this one' sends him for another" (WaitFor 'retry' { (Lines | Select-String '\[mode\] trip').Count -gt $before } 4)
        WaitFor 'card' { (Mode) -eq 'present' } 20 | Out-Null
        Start-Sleep 1
        # Round 4: a file with a picture. Hover the picture (the card opens wide), then move down to
        # "click to open" the way a hand does and click it. 0.3.2 shrank the card on the way down.
        if (Ask 'round 4 (file with a preview)' 'asteroid roguelike') {
          Start-Sleep 2
          $zz = Zones; $k = $zz | Where-Object { $_[2] -gt 200 } | Select-Object -First 1
          [M]::SetCursorPos($wa.X + $k[0] + [int]($k[2] / 2), $wa.Y + $k[1] + 70); Start-Sleep -Milliseconds 300
          [M]::SetCursorPos($wa.X + $k[0] + [int]($k[2] / 2) + 2, $wa.Y + $k[1] + 72); Start-Sleep 1
          $zz = Zones; $k = $zz | Where-Object { $_[2] -gt 200 } | Select-Object -First 1
          Check 'round 4: hovering the picture opens the card wide' ($k[2] -gt 500)
          $x = $wa.X + $k[0] + 50; $y0 = $wa.Y + $k[1] + 80; $y1 = $wa.Y + $k[1] + $k[3] - 24
          for ($i = 1; $i -le 25; $i++) { [M]::SetCursorPos($x, [int]($y0 + ($y1 - $y0) * $i / 25)); Start-Sleep -Milliseconds 25 }
          Start-Sleep -Milliseconds 400
          $zz = Zones; $k2 = $zz | Where-Object { $_[2] -gt 200 } | Select-Object -First 1
          Write-Host "card on arrival at the footer: $($k2 -join ','); clicking at $x,$y1"
          $happy = (Lines | Select-String '\[mode\] happy').Count
          [M]::Click($x, $y1)
          Check "round 4: 'click to open' opens the file" (WaitFor 'open' { (Lines | Select-String '\[mode\] happy').Count -gt $happy } 4)
        }
      }
    }
  }
} finally {
  Lines | Select-String -NotMatch '\[zones\]' | Select-Object -Last 40 | ForEach-Object { Write-Host "  log: $_" }
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process electron, Skitter -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
$failed = $results | Where-Object { -not $_.Pass }
if ($failed -or $results.Count -lt 12) { Write-Host "click test failed"; exit 1 }
Write-Host "click test passed"
