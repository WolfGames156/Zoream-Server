#by @piqseu on discord, thank him by spam pinging him. distrubuted via luatools
#ty @malonin0807 for properly porting it to powershell
#changes are commented with #+

Write-Host "Starting ST Fixer..." -ForegroundColor Cyan

# Step 1: Find Steam client install location through registry
Write-Host "`n[Step 1] Finding Steam installation location..." -ForegroundColor Yellow

$steamPath = $null

$registryPaths = @(
    "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam",
    "HKLM:\SOFTWARE\Valve\Steam",
    "HKCU:\SOFTWARE\Valve\Steam",
    "HKCU:\Software\Classes\steam\shell\open\command"
)

foreach ($regPath in $registryPaths) {
    if (-not (Test-Path $regPath)) { continue }

    try {
        $props = Get-ItemProperty -Path $regPath -ErrorAction Stop
    } catch {
        continue
    }

    # InstallPath
    if ($props.PSObject.Properties.Name -contains "InstallPath") {
        if (Test-Path $props.InstallPath) {
            $steamPath = $props.InstallPath
            break
        }
    }

    # SteamPath (bazı sistemlerde farklı)
    if ($props.PSObject.Properties.Name -contains "SteamPath") {
        if (Test-Path $props.SteamPath) {
            $steamPath = $props.SteamPath
            break
        }
    }

    # DefaultValue = steam.exe komut satırı
    if ($regPath -like "*steam\shell\open\command*") {
        $cmd = (Get-Item $regPath).GetValue("")  # <-- doğru olan burası
        if ($cmd) {
            # "C:\Program Files (x86)\Steam\steam.exe" -applaunch 730
            $exe = $cmd.Split('"')[1]
            $steamDir = Split-Path $exe -Parent

            if (Test-Path $steamDir) {
                $steamPath = $steamDir
                break
            }
        }
    }
}

if ($steamPath) {
    Write-Host "Found Steam installation: $steamPath" -ForegroundColor Green
} else {
    Write-Host "Steam installation not found!" -ForegroundColor Red
    exit 1
}

# Step 3: Count .lua files in config/stplug-in
Write-Host "`n[Step 3] Counting .lua files in config/stplug-in..." -ForegroundColor Yellow

$stplugInPath = Join-Path $steamPath "config\stplug-in"

if (Test-Path $stplugInPath) {
    $luaFiles = Get-ChildItem -Path $stplugInPath -Filter "*.lua" -ErrorAction SilentlyContinue
    $luaCount = $luaFiles.Count
    
    if ($luaCount -eq 0) {
        Write-Host "ERROR: 0 .lua files found in $stplugInPath" -ForegroundColor Red
    } else {
        Write-Host "Found $luaCount .lua file(s) in $stplugInPath" -ForegroundColor Green
    }
} else {
    Write-Host "ERROR: Directory not found: $stplugInPath" -ForegroundColor Red
    Write-Host "ERROR: 0 .lua files found (directory does not exist)" -ForegroundColor Red
}


# Step 4: Clear Steam caches while preserving achievements
Write-Host "`n[Step 4] Clearing Steam caches..." -ForegroundColor Yellow

$backupPath = Join-Path $steamPath "cache-backup"
# Create backup folder
Write-Host "Creating backup folder..." -ForegroundColor Gray
New-Item -ItemType Directory -Path $backupPath -Force | Out-Null

# Kill Steam processes
Write-Host "Closing Steam processes..." -ForegroundColor Gray
Get-Process -Name "steam*" -ErrorAction SilentlyContinue | Stop-Process -ErrorAction SilentlyContinue
Write-Host "Waiting for Steam to close..." -ForegroundColor Gray
Start-Sleep -Seconds 3

# move main caches to backup folder
Write-Host "Clearing app and depot caches..." -ForegroundColor Gray
Start-Sleep -Seconds 1

$appcachePath = Join-Path $steamPath "appcache"
$appcacheBackupPath = Join-Path $backupPath "appcache"
if (Test-Path $appcachePath) {
    New-Item -ItemType Directory -Path $appcacheBackupPath -Force | Out-Null
    Get-ChildItem -Path $appcachePath -Force -Exclude "stats" | Move-Item -Destination $appcacheBackupPath -Force -ErrorAction SilentlyContinue
    Copy-Item -Path (Join-Path $appcachePath "stats") -Destination $appcacheBackupPath -Recurse -Force -ErrorAction SilentlyContinue
}

$depotcachePath = Join-Path $steamPath "depotcache"
$depotcacheBackupPath = Join-Path $backupPath "depotcache"
if (Test-Path $depotcachePath) {
    New-Item -ItemType Directory -Path $depotcacheBackupPath -Force | Out-Null
    Get-ChildItem -Path $depotcachePath -Force | Move-Item -Destination $depotcacheBackupPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $depotcachePath -Recurse -Force -ErrorAction SilentlyContinue
}

# Clear user caches
Write-Host "Clearing user caches..." -ForegroundColor Gray
$userdataPath = Join-Path $steamPath "userdata"
$userCount = 0
if (Test-Path $userdataPath) {
    $userFolders = Get-ChildItem -Path $userdataPath -Directory -ErrorAction SilentlyContinue
    foreach ($userFolder in $userFolders) {
        $userConfigPath = Join-Path $userFolder.FullName "config"
        if (Test-Path $userConfigPath) {
            $userCount++
            $userBackupPath = Join-Path -Path $backupPath -ChildPath (Join-Path "userdata" $userFolder.Name)
            if (-not (Test-Path $userBackupPath)) {
                New-Item -ItemType Directory -Path $userBackupPath -Force | Out-Null
            }
            $userConfigBackup = Join-Path $userBackupPath "config"
            Move-Item -Path $userConfigPath -Destination $userConfigBackup -Force -ErrorAction SilentlyContinue
            #+ restore playtime (stole it from the achievements restore section lmao)
            Write-Host "Restoring playtime for $($userFolder.Name) ..." -ForegroundColor Gray
            Start-Sleep -Seconds 1
            if (Test-Path $userBackupPath) {
                if (-not (Test-Path (Split-Path $userConfigPath -Parent))) {
                    New-Item -ItemType Directory -Path (Split-Path $userConfigPath -Parent) -Force | Out-Null
                }
                New-Item -ItemType Directory -Path $userConfigPath -Force | Out-Null
                Copy-Item (Join-Path $userBackupPath "config\localconfig.vdf") -Destination (Join-Path $userConfigPath "localconfig.vdf") -Force -ErrorAction SilentlyContinue
                Write-Host "Playtime for $($userFolder.Name) restored." -ForegroundColor Green
                }
        }
    }
    if ($userCount -gt 0) {
        Write-Host "Clearing user cache for $userCount userid(s)..." -ForegroundColor Gray
    }
}
Write-Host "User cache cleared!" -ForegroundColor Green


# Restart Steam with -clearbeta flag
Write-Host "Starting Steam (beta disabled)..." -ForegroundColor Gray
$steamExe = Join-Path $steamPath "steam.exe"
if (Test-Path $steamExe) {
    Start-Process -FilePath $steamExe -ArgumentList "-clearbeta"
    Write-Host "Steam started." -ForegroundColor Green
} else {
    Write-Host "ERROR: steam.exe not found at $steamExe" -ForegroundColor Red
}

Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host "If you want to revert the cache clearing:" -ForegroundColor Yellow
Write-Host "Rerun this script and choose 'y' when prompted" -ForegroundColor Yellow
Write-Host "OR manually move the folders inside $backupPath back to $steamPath" -ForegroundColor Yellow
Write-Host "================================================================" -ForegroundColor Cyan

Write-Host "Have a nice game"
Read-Host
