$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
$ElectronExe = Join-Path $RootDir "node_modules\electron\dist\electron.exe"
$InstallScript = Join-Path $RootDir "node_modules\electron\install.js"
$MainScript = Join-Path $RootDir "scripts\desktop-main.cjs"
$IconPath = Join-Path $RootDir "assets\icon.ico"

if (-not (Test-Path $ElectronExe)) {
  Write-Host "Installing Electron binary..."
  node $InstallScript
}

if (-not (Test-Path $ElectronExe)) {
  throw "electron.exe not found at $ElectronExe"
}

$WshShell = New-Object -ComObject WScript.Shell

# 1. Project root shortcut
$RootShortcutPath = Join-Path $RootDir "Screen Demo Studio.lnk"
if (Test-Path $RootShortcutPath) { Remove-Item $RootShortcutPath -Force }
$Shortcut1 = $WshShell.CreateShortcut($RootShortcutPath)
$Shortcut1.TargetPath = $ElectronExe
$Shortcut1.Arguments = "`"$MainScript`""
$Shortcut1.WorkingDirectory = $RootDir
$Shortcut1.IconLocation = "$IconPath,0"
$Shortcut1.Description = "Screen Demo Studio - AI Manual Video Automation Studio"
$Shortcut1.Save()

# 2. User Desktop shortcut
$DesktopDir = [Environment]::GetFolderPath("Desktop")
if ($DesktopDir -and (Test-Path $DesktopDir)) {
  $DesktopShortcutPath = Join-Path $DesktopDir "Screen Demo Studio.lnk"
  if (Test-Path $DesktopShortcutPath) { Remove-Item $DesktopShortcutPath -Force }
  $Shortcut2 = $WshShell.CreateShortcut($DesktopShortcutPath)
  $Shortcut2.TargetPath = $ElectronExe
  $Shortcut2.Arguments = "`"$MainScript`""
  $Shortcut2.WorkingDirectory = $RootDir
  $Shortcut2.IconLocation = "$IconPath,0"
  $Shortcut2.Description = "Screen Demo Studio - AI Manual Video Automation Studio"
  $Shortcut2.Save()
  Write-Host "Created Desktop shortcut: $DesktopShortcutPath"
}

Write-Host "Created Project shortcut: $RootShortcutPath"
