param(
  [string]$OutputPath = "outputs/submission-video/narration.wav",
  [ValidateRange(-10, 10)]
  [int]$Rate = 0
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$resolvedOutput = Join-Path $workspaceRoot $OutputPath
$outputDirectory = Split-Path -Parent $resolvedOutput
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$available = $speaker.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
$voice = @('Microsoft Zira Desktop', 'Microsoft Zira') | Where-Object { $_ -in $available } | Select-Object -First 1
if ($voice) { $speaker.SelectVoice($voice) }
$speaker.Rate = $Rate
$speaker.Volume = 100

$narration = @'
A Phoenix field team cannot inspect every transit stop before the next heat event. Heat Priority Engine turns a verified FortyGuard surface, published ridership, and scheduled waiting into a governed inspection programme. The engine found three robust priorities and seven conditional candidates. It did not find a persistent local hotspot. Absolute heat supports exposure prioritization; a hotspot claim is withheld.

These are stored real responses: four hundred fifty cells from three completed activities at eight, fourteen, and twenty hundred on July fifteenth, twenty twenty-four. Twenty-seven Downtown Phoenix stops fall inside the returned footprint. The field, Celsius unit, local clock assumption, and hashes are visible. This is not a city-wide claim and it is not a live API call.

Each proposed stop decomposes modelled exposure into riders, scheduled expected wait, and heat above the documented thirty-degree API reference. No rider was observed and this is not a measured dose. Three stops survive all three hundred twenty-four scenarios. Seven depend on assumptions. Exposure and anomaly are never blended, and no weight slider can tune the answer.

Selected stops become inspection missions. A field worker can record shade, shelter, accessibility, notes, and a photo reference. This demonstration uses session-isolated evidence. Submitting an observation does not change the thermal ranking. A reviewer must accept it before the plan advances to version two.

The scenario lab compares the governed plan with simple baselines at capacities ten, twenty, and fifty. It does not claim causal cooling, people protected, or money saved. It shows whether the prioritization is useful under clearly stated alternatives.

The methodology exposes every evidence gate. The real pilot supports exposure only because its local anomaly did not persist out of sample. Unsupported claims are disabled in the product, not hidden in a footnote.

The report travels with its run identifier, snapshot attestation digest, assumptions, limitations, and human review. The deployment is read-only and cannot spend FortyGuard credits. The two raw extracts without redistribution terms are excluded; the retained transit sources have exact-item grants or ODC-BY terms.

This pilot turns verified heat evidence into the next defensible field action, while keeping uncertainty and scope visible.
'@

try {
  $speaker.SetOutputToWaveFile($resolvedOutput)
  $speaker.Speak($narration)
} finally {
  $speaker.Dispose()
}

Write-Output $resolvedOutput
