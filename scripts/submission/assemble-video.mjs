import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ffmpeg = resolve(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
const inputVideo = resolve(
  process.cwd(),
  'outputs',
  'submission-video',
  process.env.WALKTHROUGH_FILE ?? 'walkthrough-jury-final.webm',
)
const inputAudio = resolve(
  process.cwd(),
  'outputs',
  'submission-video',
  process.env.NARRATION_FILE ?? 'narration-jury-final.mp3',
)
const inputCaptions = resolve(
  process.cwd(),
  process.env.CAPTION_FILE ?? 'outputs/submission-video/narration-final.vtt',
)
const outputVideo = resolve(
  process.cwd(),
  'outputs',
  'submission-video',
  process.env.OUTPUT_VIDEO ?? 'fortyguard-demo-jury-final.mp4',
)
const durationSeconds = Number(process.env.VIDEO_DURATION_SECONDS ?? '152.88')

if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 180) {
  throw new Error('VIDEO_DURATION_SECONDS must be greater than 0 and at most 180.')
}

if (!existsSync(ffmpeg)) {
  throw new Error(
    'ffmpeg-static is a local recording tool, not an application dependency. ' +
      'Install it without changing the lockfile: npm install --no-save --package-lock=false ffmpeg-static@5.2.0',
  )
}
for (const path of [inputVideo, inputAudio, inputCaptions]) {
  if (!existsSync(path)) throw new Error(`Required input is missing: ${path}`)
}

const nullOutput = process.platform === 'win32' ? 'NUL' : '/dev/null'
const analysis = spawnSync(
  ffmpeg,
  [
    '-hide_banner',
    '-nostats',
    '-i', inputAudio,
    '-af', 'loudnorm=I=-16:TP=-2:LRA=11:print_format=json',
    '-f', 'null',
    nullOutput,
  ],
  { cwd: process.cwd(), encoding: 'utf-8' },
)
if (analysis.status !== 0) {
  process.stderr.write(analysis.stderr)
  process.exit(analysis.status ?? 1)
}

const loudnessJson = /\{[\s\S]*?"target_offset"\s*:\s*"[^"]+"[\s\S]*?\}/.exec(analysis.stderr)?.[0]
if (!loudnessJson) throw new Error('Unable to read the first-pass loudness measurement.')
const loudness = JSON.parse(loudnessJson)
const audioFilter =
  '[1:a]loudnorm=I=-16:TP=-2:LRA=11:' +
  `measured_I=${loudness.input_i}:measured_TP=${loudness.input_tp}:` +
  `measured_LRA=${loudness.input_lra}:measured_thresh=${loudness.input_thresh}:` +
  `offset=${loudness.target_offset}:linear=true,apad=pad_dur=180[a]`

const outcome = spawnSync(
  ffmpeg,
  [
    '-y',
    '-i', inputVideo,
    '-i', inputAudio,
    '-i', inputCaptions,
    '-filter_complex', audioFilter,
    '-map', '0:v:0',
    '-map', '[a]',
    '-map', '2:0',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-c:a', 'aac',
    '-ar', '48000',
    '-b:a', '160k',
    '-c:s', 'mov_text',
    '-metadata:s:s:0', 'language=eng',
    '-metadata:s:s:0', 'title=English captions',
    '-disposition:s:0', 'default',
    '-t', String(durationSeconds),
    '-movflags', '+faststart',
    outputVideo,
  ],
  { cwd: process.cwd(), encoding: 'utf-8' },
)

if (outcome.status !== 0) {
  process.stderr.write(outcome.stderr)
  process.exit(outcome.status ?? 1)
}
process.stdout.write(`${outputVideo}\n`)
