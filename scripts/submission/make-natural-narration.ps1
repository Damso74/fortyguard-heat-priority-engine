param(
  [string]$OutputPath = "outputs/submission-video/narration-jury.mp3",
  [string]$SubtitlePath = "outputs/submission-video/narration-jury.vtt",
  [string]$Voice = "en-US-BrianMultilingualNeural",
  [string]$Rate = "-3%"
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$edgeTts = Join-Path $workspaceRoot '.cache\video-tts\Scripts\edge-tts.exe'
$narration = Join-Path $PSScriptRoot 'narration-en.txt'
$resolvedOutput = Join-Path $workspaceRoot $OutputPath
$resolvedSubtitles = Join-Path $workspaceRoot $SubtitlePath

if (-not (Test-Path -LiteralPath $edgeTts)) {
  throw 'Natural narration environment is missing. Create .cache/video-tts and install edge-tts in it.'
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedOutput) | Out-Null

& $edgeTts `
  --file $narration `
  --voice $Voice `
  "--rate=$Rate" `
  --write-media $resolvedOutput `
  --write-subtitles $resolvedSubtitles

if ($LASTEXITCODE -ne 0) {
  throw "Natural narration generation failed with exit code $LASTEXITCODE."
}

Write-Output $resolvedOutput
Write-Output $resolvedSubtitles
