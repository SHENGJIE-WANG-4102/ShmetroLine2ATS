$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $projectRoot 'src-tauri\target\release\line2-ats.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw '请先执行 npm run app:build，生成桌面版程序。'
}
$desktopDirectory = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopDirectory '2号线ATS.lnk'
$shellObject = New-Object -ComObject WScript.Shell
$shortcut = $shellObject.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $executable
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = "$executable,0"
$shortcut.Description = '上海地铁2号线 ATS 模拟器'
$shortcut.Save()
Write-Output "已创建桌面快捷方式：$shortcutPath"
