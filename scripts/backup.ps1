# Create a restorable backup of the bot kit.
#   - the git-tracked project files
#   - runtime configs / personas / sticker library
#   - voice service sources, fine-tuned weights, character references, small datasets
#   - a copy of AGENTS.md
# Large model files are NOT included (documented in docs/MAINTENANCE.md: re-downloadable).
#
# Usage: pwsh scripts/backup.ps1 [-OutDir D:\backups]

param(
  [string]$OutDir = 'D:\backups'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
$work = Join-Path $env:TEMP "dsh-im-backup-$stamp"
$zip = Join-Path $OutDir "dsh-im-kit-$stamp.zip"

New-Item -ItemType Directory -Force -Path $work, $OutDir | Out-Null

function Copy-IfExists($source, $target) {
  if (-not (Test-Path $source)) { Write-Host "  skip (missing): $source"; return }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item $source $target -Recurse -Force
  Write-Host "  + $target"
}

Write-Host '[1/4] project files'
Copy-IfExists $repoRoot (Join-Path $work 'project')
Get-ChildItem (Join-Path $work 'project') -Recurse -Directory -Filter '.git' -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force

Write-Host '[2/4] dsh-im runtime configs'
$im = Join-Path $dshHome 'integrations/dsh-im'
Copy-IfExists (Join-Path $im 'voice.json') (Join-Path $work 'runtime/voice.json')
Copy-IfExists (Join-Path $im 'stickers.json') (Join-Path $work 'runtime/stickers.json')
Copy-IfExists (Join-Path $im 'group-reasoning.json') (Join-Path $work 'runtime/group-reasoning.json')
Copy-IfExists (Join-Path $im 'persona.md') (Join-Path $work 'runtime/persona.md')
Copy-IfExists (Join-Path $im 'personas') (Join-Path $work 'runtime/personas')
Copy-IfExists (Join-Path $im 'stickers') (Join-Path $work 'runtime/stickers')
Copy-IfExists (Join-Path $dshHome 'AGENTS.md') (Join-Path $work 'runtime/AGENTS.md')

Write-Host '[3/4] voice services and weights'
Copy-IfExists 'D:/tools/gpt-sovits/server.py' (Join-Path $work 'voice/gpt-sovits/server.py')
Copy-IfExists 'D:/tools/gpt-sovits/tts_infer_finetuned.yaml' (Join-Path $work 'voice/gpt-sovits/tts_infer_finetuned.yaml')
Copy-IfExists 'D:/tools/gpt-sovits/s2_dafeiyu.json' (Join-Path $work 'voice/gpt-sovits/s2_dafeiyu.json')
Copy-IfExists 'D:/tools/gpt-sovits/weights' (Join-Path $work 'voice/gpt-sovits/weights')
Copy-IfExists 'D:/tools/gpt-sovits/characters' (Join-Path $work 'voice/gpt-sovits/characters')
Copy-IfExists 'D:/tools/gpt-sovits/dataset/metadata.csv' (Join-Path $work 'voice/gpt-sovits/dataset/metadata.csv')
Copy-IfExists 'D:/tools/gpt-sovits/dataset/dafeiyu.list' (Join-Path $work 'voice/gpt-sovits/dataset/dafeiyu.list')
Copy-IfExists 'D:/tools/tts-gpu/server.py' (Join-Path $work 'voice/f5/server.py')
Copy-IfExists 'D:/tools/tts-gpu/characters' (Join-Path $work 'voice/f5/characters')

Write-Host '[4/4] writing archive'
$manifest = @"
backup: $stamp
project: $root
dsh home: $home
not included: GPT-SoVITS/F5 model weights, venvs, node_modules
restore notes: see project/docs/MAINTENANCE.md
"@
Set-Content -Path (Join-Path $work 'BACKUP-INFO.txt') -Value $manifest -Encoding UTF8
Compress-Archive -Path (Join-Path $work '*') -DestinationPath $zip -Force
Remove-Item $work -Recurse -Force
$info = Get-Item $zip
Write-Host ("backup: {0} ({1:N1} MB)" -f $info.FullName, ($info.Length / 1MB))
