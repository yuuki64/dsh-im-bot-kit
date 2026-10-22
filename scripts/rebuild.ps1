# Rebuild the patched dsh-im plugin:
#   1. restore patched sources into the installed package
#   2. rebuild lib/index.js with esbuild
#   3. verify the bundle contains the patch markers
#
# Usage:  pwsh scripts/rebuild.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$imPatch = Join-Path $root 'tools/im-patch'
$plugin = Join-Path $env:USERPROFILE '.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im'

if (-not (Test-Path $plugin)) {
  throw "dsh-im is not installed at $plugin (install it first)"
}

Push-Location $imPatch
try {
  Write-Host '[1/3] restoring patched sources...'
  node apply.mjs
  if ($LASTEXITCODE -ne 0) { throw "apply.mjs failed ($LASTEXITCODE)" }

  Write-Host '[2/3] rebuilding lib/index.js...'
  node build-im.mjs
  if ($LASTEXITCODE -ne 0) { throw "build-im.mjs failed ($LASTEXITCODE)" }

  Write-Host '[3/3] verifying bundle markers...'
  $lib = Join-Path $plugin 'lib/index.js'
  $needles = @('dsh_im_voice', 'dsh_im_sticker', '17862', 'dsh_im_persona')
  foreach ($n in $needles) {
    if (-not (Select-String -Path $lib -Pattern $n -SimpleMatch -Quiet)) {
      throw "bundle is missing marker: $n"
    }
    Write-Host "  OK $n"
  }
  $info = Get-Item $lib
  Write-Host ("bundle: {0:N0} bytes, {1}" -f $info.Length, $info.LastWriteTime)
  Write-Host 'Done. Fully quit and reopen DSH to load the new bundle.'
}
finally {
  Pop-Location
}
