$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
function Install-PackageIfMissing([string]$Id) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22.14+ and Google Chrome, then run setup.ps1 again. winget is unavailable.' }
    & winget show --exact --id $Id --source winget
    if ($LASTEXITCODE -ne 0) { throw "Cannot verify installer: $Id" }
    & winget install --exact --id $Id --source winget --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw "Installation failed: $Id" }
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
    & node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=14)?0:1)"
    $nodeOk = $LASTEXITCODE -eq 0
}
if (-not $nodeOk) { Install-PackageIfMissing 'OpenJS.NodeJS.LTS' }
$chromePaths = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
if (-not @($chromePaths | Where-Object { Test-Path -LiteralPath $_ }).Count) { Install-PackageIfMissing 'Google.Chrome' }
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
& npm.cmd run doctor
if ($LASTEXITCODE -ne 0) { throw 'doctor failed' }
Write-Host 'Setup complete. Run npm.cmd start, then npm.cmd run login.' -ForegroundColor Green
