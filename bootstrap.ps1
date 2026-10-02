$MiseVersion = "v2026.5.2"
$MiseDir = Join-Path $env:LOCALAPPDATA "mise\bin"
$Mise = Join-Path $MiseDir "mise.exe"

if (-not (Test-Path $Mise)) {
  New-Item -ItemType Directory -Force -Path $MiseDir | Out-Null
  Invoke-WebRequest "https://github.com/jdx/mise/releases/download/$MiseVersion/mise-$MiseVersion-windows-x64.exe" -OutFile $Mise
}

$env:PATH = "$MiseDir;$env:PATH"
Get-ChildItem -Recurse -File -Filter ".mise.toml" | ForEach-Object {
  & $Mise trust -a -y (Split-Path $_.FullName)
}
& $Mise install
