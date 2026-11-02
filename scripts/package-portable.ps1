param(
  [string]$OutputZip = ''
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$root = (Resolve-Path (Join-Path $project '..')).Path
if (-not $OutputZip) {
  $OutputZip = Join-Path $root 'TapNow-Studio-Edge.zip'
}
if (Test-Path -LiteralPath $OutputZip) {
  throw "Archive already exists. Refusing to overwrite: $OutputZip"
}
Add-Type -AssemblyName System.IO.Compression

$includeDirs = @(
  'src',
  'public',
  'scripts'
)
$includeRootFiles = @(
  'package.json',
  'package-lock.json',
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  'README.md',
  '.gitignore',
  'start.bat'
)
$files = @()
foreach ($dir in $includeDirs) {
  $files += @(Get-ChildItem -LiteralPath (Join-Path $project $dir) -Recurse -File)
}
$files += @(Get-ChildItem -LiteralPath (Join-Path $project 'server') -File -Filter '*.mjs')
foreach ($file in $includeRootFiles) {
  $files += Get-Item -LiteralPath (Join-Path $project $file)
}

$zip = [System.IO.Compression.ZipFile]::Open(
  $OutputZip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in $files) {
    $entryName = $file.FullName.Substring($project.Length + 1).Replace('\','/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip, $file.FullName, $entryName,
      [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally {
  $zip.Dispose()
}

$verify = [System.IO.Compression.ZipFile]::OpenRead($OutputZip)
try {
  $names = @($verify.Entries | ForEach-Object FullName)
  foreach ($required in @(
    'server/doubao.mjs',
    'server/chromium-binary.mjs',
    'src/App.tsx',
    'package.json',
    'start.bat'
  )) {
    if ($names -notcontains $required) {
      throw "Required archive entry missing: $required"
    }
  }
  foreach ($name in $names) {
    if ($name -match '(^|/)(browser_data|doubao-profiles|doubao-secrets|node_modules|data|uploads|dist)(/|$)' -or
        $name -match '(\.dpapi|\.devtools|\.har)$') {
      throw "Sensitive or generated data found in archive: $name"
    }
  }
  Write-Output "ARCHIVE=$OutputZip"
  Write-Output "FILE_COUNT=$($names.Count)"
  Write-Output "BYTES=$((Get-Item -LiteralPath $OutputZip).Length)"
  Write-Output "SHA256=$((Get-FileHash -LiteralPath $OutputZip -Algorithm SHA256).Hash)"
} finally {
  $verify.Dispose()
}
