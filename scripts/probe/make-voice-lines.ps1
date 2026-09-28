# Generates the probe caller lines as mono PCM16 WAV with the Windows built-in voices
# (ko-KR: Microsoft Heami, en-US: Microsoft Zira). Text comes from voice-lines.json (UTF-8),
# so this file stays ASCII and works in Windows PowerShell 5.1. A line with "ssml" is spoken from SSML
# (pauses with <break>).
#   powershell -ExecutionPolicy Bypass -File scripts/probe/make-voice-lines.ps1
Add-Type -AssemblyName System.Speech
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$json = [IO.File]::ReadAllText((Join-Path $here 'voice-lines.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo }
foreach ($line in $json.lines) {
  $v = $voices | Where-Object { $_.Culture.Name -eq $line.voice } | Select-Object -First 1
  if (-not $v) { Write-Output "no voice for $($line.voice), skipping $($line.id)"; continue }
  $synth.SelectVoice($v.Name)
  $synth.Rate = 0
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo([int]$line.rate, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $out = Join-Path $here ("$($line.id).wav")
  $synth.SetOutputToWaveFile($out, $fmt)
  if ($line.ssml) { $synth.SpeakSsml([string]$line.ssml) } else { $synth.Speak([string]$line.text) }
  $synth.SetOutputToNull()
  $size = (Get-Item $out).Length
  Write-Output ("{0} {1} {2} Hz {3} bytes {4:N1} s" -f $line.id, $v.Name, $line.rate, $size, (($size - 44) / (2 * [int]$line.rate)))
}
$synth.Dispose()
