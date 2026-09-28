# Generates the synthesized demo caller (lines C1-C7 of the design script) with the Windows built-in
# en-US voice (Microsoft Zira) as 24 kHz mono PCM16 WAV, the Voice Agent API input format.
# Lines come from web/src/demo-lines.json; a line with "parts" gets real pauses ({"pause_ms": 1200}).
# Output: web/public/demo/<id>.wav (git-ignored, generated per machine).
#   powershell -ExecutionPolicy Bypass -File scripts/make-demo-audio.ps1
# This file stays ASCII so it runs in Windows PowerShell 5.1.
Add-Type -AssemblyName System.Speech
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$json = [IO.File]::ReadAllText((Join-Path $root 'web/src/demo-lines.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
$outDir = Join-Path $root 'web/public/demo'
New-Item -ItemType Directory -Force $outDir | Out-Null

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | Where-Object { $_.Culture.Name -eq $json.voice } | Sort-Object { $_.Name -notmatch 'Zira' } | Select-Object -First 1
if (-not $voice) { Write-Output "no $($json.voice) voice installed"; exit 1 }
$synth.SelectVoice($voice.Name)
$synth.Rate = 0
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo([int]$json.rate, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

foreach ($line in $json.lines) {
  $out = Join-Path $outDir ("$($line.id).wav")
  $pb = New-Object System.Speech.Synthesis.PromptBuilder
  if ($line.parts) {
    foreach ($p in $line.parts) {
      if ($p -is [string]) { $pb.AppendText($p) }
      elseif ($p.pause_ms) { $pb.AppendBreak([TimeSpan]::FromMilliseconds([int]$p.pause_ms)) }
    }
  } else {
    $pb.AppendText([string]$line.text)
  }
  $synth.SetOutputToWaveFile($out, $fmt)
  $synth.Speak($pb)
  $synth.SetOutputToNull()
  $size = (Get-Item $out).Length
  Write-Output ("{0} {1} {2} Hz {3:N1} s" -f $line.id, $voice.Name, $json.rate, (($size - 44) / (2 * [int]$json.rate)))
}
$synth.Dispose()
