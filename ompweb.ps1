<#
ompweb.ps1 -- one entry point for the source-run ompweb stack on Windows.

  .\ompweb.ps1 start        launch the web server and the host daemon (safe to re-run)
  .\ompweb.ps1 stop         stop the server            (-All also stops the daemon)
  .\ompweb.ps1 restart      bounce the server, no build (-All also bounces the daemon)
  .\ompweb.ps1 rebuild      build the client bundle, then bounce the server
  .\ompweb.ps1 status       what is running and which bundle is served
  .\ompweb.ps1 logs         the tail of the logs
  .\ompweb.ps1 supervise server|host                     (internal: the keep-running loop)

The checkout IS the install dir: bin\omp-web.js runs server\main.ts with the Bun from
node_modules and serves dist\, so deploying is a rebuild plus a restart -- no copy step
and no second copy of the app to keep in sync. Port, bind address and environment
(password hash, allowed hosts, CA certificate) come from ompweb.local.ps1 next to this
file, which is git-ignored, so the repo never carries a secret.

Two design points the rest follows from:

* The supervisor is the reaper. It is the PARENT of the process it keeps running, so the
  `taskkill /T /F` that restart/rebuild issue can never reach it and no detached watchdog
  is needed. `rebuild` records the entry chunk it just produced in pending-asset.txt; the
  server supervisor polls /login after the respawn and logs OK/FAILED to run-server.log --
  the process that starts the new build is the one that verifies it.

* Stopping the host daemon ends every agent session it owns; bouncing the web server does
  not (the daemon reconnects and the new server adopts the running children). So nothing
  here touches the daemon unless you say -All.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'rebuild', 'status', 'logs', 'supervise')]
    [string] $Command = 'status',
    [Parameter(Position = 1)]
    [ValidateSet('server', 'host')] [string] $Role = 'server',
    [switch] $All,
    [switch] $DryRun
)

$ErrorActionPreference = 'Continue'
$Repo = $PSScriptRoot
$local = Join-Path $Repo 'ompweb.local.ps1'
if (Test-Path $local) { . $local }   # may set $OmpWebPort, $OmpWebBind, $OmpWebNode and $env:OMP_WEB_*

$Port = if ($OmpWebPort) { $OmpWebPort } else { 30177 }
$Bind = if ($OmpWebBind) { $OmpWebBind } else { '127.0.0.1' }
# bin/omp-web.js resolves the bundled Bun itself, so node is the only requirement.
$Node = if ($OmpWebNode) { $OmpWebNode } else { 'node.exe' }
$Launcher = Join-Path $Repo 'bin\omp-web.js'

$StateDir = Join-Path $env:USERPROFILE '.omp\agent\ompweb-rebuild'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$PendingAsset = Join-Path $StateDir 'pending-asset.txt'
$LogPath = Join-Path $StateDir 'rebuild.log'
# Set by Stop-Instance when a kill was REFUSED and the listener still holds the port. The
# verbs must not report a hand-off in that case: nothing was bounced and nothing relaunches.
$InstanceStuck = $false

function Log([string] $m) {
    $line = "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))  $m"
    # Write-Host, not Write-Output: Stop-Instance and friends return a status, and a captured
    # call (`if (-not (Stop-Instance))`) would otherwise swallow every line they log.
    Write-Host $line
    $line | Out-File -Append -Encoding utf8 $LogPath
}
function Fail([string] $m) { Log "FATAL: $m"; exit 1 }

# The supervisors' command lines carry the `supervise` verb: that is what keeps them out
# of every kill list and what makes `start` idempotent.
function Get-Supervisors {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'powershell.exe' -and $_.ProcessId -ne $PID -and
        $_.CommandLine -match 'ompweb\.ps1\s+supervise' })
}
function Get-Supervisor([string] $role) { @(Get-Supervisors | Where-Object { $_.CommandLine -match ('\s' + $role + '\s*$') }) }

function Stop-Tree([int] $processId, [string] $why) {
    Log ('stop: taskkill /T /F pid ' + $processId + '  ' + $why)
    # taskkill writes its result in the console codepage, which lands as mojibake in a
    # UTF-8 log; the exit code is only a hint -- 128 is BOTH "already gone" and "Access
    # denied" -- which is why Stop-Instance proves the kill against the port instead.
    & taskkill /pid $processId /t /f *> $null
    Log ('  exit ' + $LASTEXITCODE)
}

# Only the instance listening on $Port is ever targeted -- never another ompweb that
# happens to run on this machine. That is the listener itself plus its launcher/Bun pair
# (sharing its parent, or naming this port on the command line).
function Get-Instance {
    $targets = @()
    $listenerPids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                      Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($listenerPid in $listenerPids) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction SilentlyContinue
        if ($p) { $targets += $p }
    }
    foreach ($p in Get-CimInstance Win32_Process) {
        if (-not $p.CommandLine) { continue }
        if ($p.ProcessId -eq $PID -or $targets.ProcessId -contains $p.ProcessId) { continue }
        if ($p.CommandLine -match 'ompweb\.ps1\s+supervise') { continue }
        if ($p.CommandLine -match '\bhost\b' -and -not $All) { continue }
        if ($p.Name -ne 'ompweb.exe' -and $p.CommandLine -notmatch 'omp-web\.js|server[\\/]main\.ts') { continue }
        $related = $targets | Where-Object { $_.ParentProcessId -eq $p.ProcessId -or $p.ParentProcessId -eq $_.ParentProcessId }
        if ($p.CommandLine -match ('-p\s*"?' + $Port + '\b') -or $related) { $targets += $p }
    }
    return @($targets | Sort-Object { $_.CommandLine.Length } -Descending)
}

# The pids holding $Port right now. The port is the only real proof a kill took: an instance
# started from an ELEVATED shell can never be killed from a normal one, and taskkill's exit
# code cannot tell that apart from a process that was already gone.
function Get-ListenerPids {
    @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
}

# Is this script itself running INSIDE the instance it is about to kill? The seeded
# "OmpWeb Rebuild & Restart" task is a child of the web server, so its own tree burns with
# the target -- anything it launches after the kill never happens.
function Test-InsideInstance {
    $targets = @(Get-Instance)
    if (-not $targets) { return $false }
    $current = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID) -ErrorAction SilentlyContinue
    $guard = 0
    while ($current -and $current.ParentProcessId -and $guard -lt 30) {
        if (@($targets).ProcessId -contains $current.ParentProcessId) { return $true }
        $current = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $current.ParentProcessId) -ErrorAction SilentlyContinue
        $guard++
    }
    return $false
}

# Bounce the instance and leave the supervisor ALIVE: it is what relaunches the process and
# verifies the served bundle, so killing it would leave nothing to bring the instance back.
function Stop-Instance {
    $script:InstanceStuck = $false
    $targets = @(Get-Instance)
    if (-not $targets) { Log ('stop: nothing running on port ' + $Port); return $false }
    foreach ($p in $targets) { Stop-Tree $p.ProcessId ('[' + $p.Name + '] ' + $p.CommandLine) }
    for ($i = 0; $i -lt 8; $i++) {
        if (-not @(Get-ListenerPids)) { return $true }
        Start-Sleep -Milliseconds 400
    }
    $left = @(Get-ListenerPids)
    Log ('FAILED: port ' + $Port + ' is still held by pid ' + ($left -join ', ') +
         ' -- the kill was refused, nothing was bounced. An instance started from an elevated' +
         ' shell needs an elevated ' + $PSCommandPath + ' stop.')
    $script:InstanceStuck = $true
    return $false
}

# `stop` also ends the supervisor -- otherwise it simply relaunches what was killed. The
# supervisor is the parent, so its tree kill takes the child along.
function Stop-Supervisor([string] $role) {
    $sup = @(Get-Supervisor $role)
    if (-not $sup) { return $false }
    foreach ($s in $sup) { Stop-Tree $s.ProcessId ('[supervisor] ' + $s.CommandLine) }
    return $true
}

function Stop-Host {
    if (Stop-Supervisor 'host') { return }
    foreach ($p in @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'omp-web\.js host' })) {
        Stop-Tree $p.ProcessId ('[' + $p.Name + '] ' + $p.CommandLine)
    }
}

function Get-ServedAsset {
    try {
        $html = (Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/login') -UseBasicParsing -TimeoutSec 5).Content
        $m = [regex]::Match($html, '/assets/[^"]+\.js')
        if ($m.Success) { return $m.Value }
        return 'reachable on ' + $Port + ', no asset marker'
    } catch { return 'not reachable on ' + $Port }
}

# Which processes a supervisor is currently keeping alive, as pid:name pairs.
function Get-Supervised([string] $role) {
    $pattern = if ($role -eq 'host') { 'omp-web\.js host' } else { '-p\s*"?' + $Port + '\b' }
    $kids = @(Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -match $pattern -and $_.Name -in @('node.exe', 'bun.exe', 'ompweb.exe') })
    if (-not $kids) { return 'no process yet' }
    return (($kids | ForEach-Object { $_.ProcessId.ToString() + ':' + $_.Name }) -join ' ')
}

function Start-Supervisor([string] $role) {
    Start-Process powershell -WindowStyle Minimized -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, 'supervise', $role) | Out-Null
    Log ('start: ' + $role + ' supervisor launched (log: ' + (Join-Path $StateDir ('run-' + $role + '.log')) + ')')
}

# A supervisor launched for a bounce has to OUTLIVE it. Win32_Process.Create starts the
# process outside the caller's tree, so a `taskkill /T` on the instance cannot reach it --
# that is the only way a rebuild run from INSIDE the web server can leave a relauncher
# behind. It needs elevation (which the elevated path already has); Start-Process is the
# fallback, correct whenever the caller survives the kill.
function Start-SupervisorDetached([string] $role) {
    $line = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" supervise ' + $role
    $created = $null
    try {
        $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -ErrorAction Stop -Arguments @{
            CommandLine = $line; CurrentDirectory = $Repo }
    } catch { $created = $null }
    if ($created -and $created.ReturnValue -eq 0) {
        Log ('start: ' + $role + ' supervisor launched outside this process tree (pid ' + $created.ProcessId +
             ', log: ' + (Join-Path $StateDir ('run-' + $role + '.log')) + ')')
        return
    }
    Log ('start: the detached launch was refused; the supervisor will not survive a kill of this process')
    Start-Supervisor $role
}

# Make sure something will bring the instance back. An instance whose supervisor died earlier
# (or that was started by hand -- see `status`) has nothing to relaunch it, and the hand-off
# would then wait for a verification that can never run. Never start a SECOND host daemon:
# two daemons would run competing children on one agent dir.
function Ensure-Supervisor([string] $role) {
    if (@(Get-Supervisor $role).Count -gt 0) { return $true }
    if ($role -eq 'host' -and @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'omp-web\.js host' })) {
        Log 'start: a host daemon is running without a supervisor -- left alone (never run two daemons)'
        return $false
    }
    Log ('start: no ' + $role + ' supervisor -- launching one so the instance comes back')
    Start-SupervisorDetached $role
    return $true
}

# One bounce, honestly reported. The relauncher is put in place BEFORE the kill when this
# script runs inside the instance (a supervisor launched afterwards would die with the tree);
# otherwise after it, so a refused kill cannot leave a supervisor crash-looping on a busy
# port. Returns $true only when a process was actually stopped.
function Restart-Instance {
    $inside = Test-InsideInstance
    if ($inside) {
        Ensure-Supervisor 'server' | Out-Null
        if ($All) { Ensure-Supervisor 'host' | Out-Null }
    }
    $wasRunning = Stop-Instance
    if ($script:InstanceStuck) { return $false }
    if (-not $inside) {
        if (@(Get-ListenerPids)) {
            # Nothing ompweb-owned was running, yet the port is taken: starting a supervisor
            # would only spawn a child that fails to bind every 3 seconds forever.
            Log ('FAILED: port ' + $Port + ' is held by a process that is not this instance; no supervisor started')
            $script:InstanceStuck = $true
            return $false
        }
        Ensure-Supervisor 'server' | Out-Null
        if ($All) { Ensure-Supervisor 'host' | Out-Null }
    }
    return $wasRunning
}

function Start-Stack {
    foreach ($role in @('server', 'host')) {
        if (@(Get-Supervisor $role).Count -gt 0) { Log ('start: ' + $role + ' supervisor already running -- left alone') }
        else { Start-Supervisor $role }
    }
    Log ('start: instance on http://127.0.0.1:' + $Port)
}

# Confirm the fresh client bundle is what is actually served, right after the respawn.
# /login is the gate-exempt page route: it serves the same index.html and needs no session
# cookie. The marker is single-use, so an unrelated restart never re-verifies an old build.
function Verify-PendingRestart {
    if (-not (Test-Path $PendingAsset)) { return }
    $marker = (Get-Content -Raw $PendingAsset).Trim()
    if (-not $marker) { Remove-Item $PendingAsset -Force; return }
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 1500
        $html = try { (Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/login') -UseBasicParsing -TimeoutSec 5).Content } catch { '' }
        if ($html -like ('*' + $marker + '*')) {
            Log ('OK: port ' + $Port + ' serving ' + $marker)
            Remove-Item $PendingAsset -Force
            return
        }
    }
    Log ('FAILED: port ' + $Port + ' never served ' + $marker + ' within 90s (supervisor pid ' + $PID + ')')
}

# One role's keep-running loop: spawn, wait, pause, spawn again. What entrypoint.sh's
# loops do in the container.
function Start-Loop([string] $role) {
    if (-not (Test-Path $Launcher)) { Fail ('launcher not found: ' + $Launcher) }
    # A supervisor owns its own log: run-server.log / run-host.log, so the OK/FAILED line of a
    # bounce sits next to the spawn that produced it instead of in the rebuild log.
    $script:LogPath = Join-Path $StateDir ('run-' + $role + '.log')
    $argList = if ($role -eq 'host') { @($Launcher, 'host') }
               else { @($Launcher, '-p', [string] $Port, '-H', $Bind, '--no-open') }
    Log ('supervisor started (role=' + $role + ' repo=' + $Repo + ' port=' + $Port + ' bind=' + $Bind + ' node=' + $Node + ')')
    while ($true) {
        $child = Start-Process -FilePath $Node -ArgumentList $argList -WorkingDirectory $Repo -WindowStyle Hidden -PassThru
        if (-not $child) { Log 'Start-Process failed; retrying'; Start-Sleep -Seconds 3; continue }
        Log ('spawned ' + $child.Id + ' [' + ($argList -join ' ') + ']')
        # Verify against the process that is now up, not the one that just died.
        if ($role -eq 'server') { Verify-PendingRestart }
        try { $child.WaitForExit() } catch { Log ('wait failed: ' + $_.Exception.Message) }
        $code = try { $child.ExitCode } catch { '?' }
        Log ('pid ' + $child.Id + ' exited (code=' + $code + '); restarting in 3s')
        Start-Sleep -Seconds 3
    }
}

function Show-Status {
    Log ('status: ' + $Repo + '  port ' + $Port + '  bind ' + $Bind)
    foreach ($role in @('server', 'host')) {
        $sup = @(Get-Supervisor $role)
        if ($sup) {
            Log ('  ' + $role + ': supervisor pid ' + (($sup | ForEach-Object { $_.ProcessId }) -join ',') + ' -> ' + (Get-Supervised $role))
        } else {
            Log ('  ' + $role + ': not running')
        }
    }
    $listenerPids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                      Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($listenerPid in $listenerPids) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction SilentlyContinue
        if ($p) {
            # A process running at a HIGHER elevation is visible only as a bare pid: its
            # command line reads back empty and no supervisor/child of it can be listed, so
            # the roles above say "not running" while the port is served. Say what is going on
            # instead of letting the reader conclude the instance was started by hand.
            if (-not $p.CommandLine) {
                Log ('  listener: pid ' + $p.ProcessId + ' [' + $p.Name + '] -- this shell cannot read it:' +
                     ' the instance runs elevated, so run ' + $PSCommandPath + ' from an elevated shell' +
                     ' to see and control it')
                continue
            }
            $note = if (@(Get-Supervisor 'server').Count -gt 0) { '' } else { '  (no ompweb.ps1 supervisor: started by hand?)' }
            Log ('  listener: pid ' + $p.ProcessId + ' [' + $p.Name + '] ' + $p.CommandLine + $note)
        }
    }
    Log ('  served: ' + (Get-ServedAsset))
    $index = Join-Path $Repo 'dist\index.html'
    if (Test-Path $index) {
        $m = Select-String -Path $index -Pattern '/assets/[^"]+\.js' | Select-Object -First 1
        if ($m) { Log ('  in dist: ' + $m.Matches[0].Value) }
    }
    if (Test-Path $PendingAsset) { Log ('  pending: ' + (Get-Content -Raw $PendingAsset).Trim()) }
}

switch ($Command) {
    'start' { Start-Stack }

    'stop' {
        if (-not (Stop-Supervisor 'server')) { Stop-Instance | Out-Null }
        if ($All) { Stop-Host }
        # A refused kill must not be reported as a stopped stack.
        if ($script:InstanceStuck) { exit 1 }
        if ($All) {
            Log 'stop: server and host stopped'
        } else {
            Log 'stop: the host daemon was left running so agent sessions survive; use -All to stop it too'
        }
    }

    'restart' {
        if ($All) { Log 'restart: bouncing the server and the host daemon (running sessions will resume)' }
        else { Log 'restart: bouncing the server' }
        # -All makes Get-Instance include the daemon, so one bounce covers both roles.
        $wasRunning = Restart-Instance
        if ($script:InstanceStuck) { exit 1 }
        if (-not $wasRunning) { Log 'restart: nothing was running; the supervisor brings the instance up' }
        Log 'restart: issued; the supervisors relaunch and the server verifies the served bundle'
    }

    'rebuild' {
        if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { Fail 'node.exe is not on PATH' }
        if (-not (Test-Path $Launcher)) { Fail ('launcher not found: ' + $Launcher) }
        if (-not (Test-Path (Join-Path $Repo 'bin\bun-runtime.js'))) { Fail 'bin/bun-runtime.js is missing' }
        if (-not (Test-Path (Join-Path $Repo 'scripts\build-client.ts'))) { Fail 'scripts/build-client.ts is missing' }
        $index = Join-Path $Repo 'dist\index.html'
        if (-not (Test-Path $index)) { Fail ('no ' + $index + ' -- run the first build manually (npm run build)') }
        $m = Select-String -Path $index -Pattern '/assets/[^"]+\.js' | Select-Object -First 1
        if (-not $m) { Fail 'no /assets/<hash>.js marker in dist/index.html' }
        $asset = $m.Matches[0].Value
        $preAsset = $asset
        if ($DryRun) {
            Log ('rebuild: (dry run) would build, expect ' + $asset + ', and stop:')
            foreach ($s in @(Get-Supervisor 'server')) { Log ('  pid ' + $s.ProcessId + ' [supervisor] ' + $s.CommandLine) }
            foreach ($p in Get-Instance) { Log ('  pid ' + $p.ProcessId + ' [' + $p.Name + '] ' + $p.CommandLine) }
            break
        }
        Log ('build: bun scripts/build-client.ts in ' + $Repo + ' (serving ' + (Get-ServedAsset) + ')')
        # bin/bun-runtime.js runs Bun with the given args; the node_modules\.bin\bun shims
        # are unreliable on this box. The instance keeps serving the old build throughout.
        # Run from the repo: the entry is resolved against the cwd, and Automation Tasks
        # spawn script entries with cwd = dirname(script) -- System32 for this one.
        Push-Location $Repo
        try {
            & node 'bin\bun-runtime.js' 'scripts\build-client.ts' 2>&1 | ForEach-Object {
                "$_" | Out-File -Append -Encoding utf8 $LogPath
                Write-Host $_
            }
            $buildExit = $LASTEXITCODE
        } finally { Pop-Location }
        if ($buildExit -ne 0) { Fail ('build failed (exit ' + $buildExit + '); the running instance was left untouched') }
        # The build decides the hash, so the marker is read again after it ran.
        $m = Select-String -Path $index -Pattern '/assets/[^"]+\.js' | Select-Object -First 1
        if (-not $m) { Fail 'no /assets/<hash>.js marker in dist/index.html' }
        $asset = $m.Matches[0].Value
        if ($asset -eq $preAsset) { Log ('build: entry chunk unchanged (' + $asset + '); nothing client-side to pick up') }
        Set-Content -Path $PendingAsset -Value $asset -Encoding ascii -NoNewline
        Log ('hand-off: expecting ' + $asset + ' (the server supervisor verifies it in run-server.log)')
        $wasRunning = Restart-Instance
        if ($script:InstanceStuck) { exit 1 }
        if (-not $wasRunning) { Log 'rebuild: nothing was running; the supervisor brings the fresh build up' }
        Log ('rebuild: issued; the supervisor relaunches the instance and verifies ' + $asset)
    }

    'status' { Show-Status }

    'logs' {
        foreach ($f in @('run-server.log', 'run-host.log', 'rebuild.log')) {
            $path = Join-Path $StateDir $f
            if (Test-Path $path) {
                Write-Output ('==> ' + $f)
                Get-Content -Tail 12 $path | ForEach-Object { Write-Output $_ }
            }
        }
    }

    'supervise' { Start-Loop $Role }
}
