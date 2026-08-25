import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const input = resolve(
  process.cwd(),
  process.env.NARRATION_TEXT ?? 'scripts/submission/narration-en.txt',
)
const output = resolve(
  process.cwd(),
  process.env.CAPTION_FILE ?? 'outputs/submission-video/narration-final.vtt',
)
const durationSeconds = Number(process.env.NARRATION_DURATION_SECONDS ?? '152.88')

if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 180) {
  throw new Error('NARRATION_DURATION_SECONDS must be greater than 0 and at most 180.')
}

const narration = readFileSync(input, 'utf-8').trim()
const units = captionUnits(narration)
const weighted = units.map((unit) => ({ text: wrap(unit), words: wordCount(unit) }))
const totalWords = weighted.reduce((sum, unit) => sum + unit.words, 0)
const startPad = 0.08
const endPad = 0.12
const spokenDuration = durationSeconds - startPad - endPad
let elapsed = startPad

const cues = weighted.map((unit, index) => {
  const start = elapsed
  const isLast = index === weighted.length - 1
  const duration = isLast ? durationSeconds - endPad - elapsed : spokenDuration * (unit.words / totalWords)
  if (duration < 1.2) {
    throw new Error(`Caption is shorter than 1.2 seconds: ${unit.text.replace('\n', ' / ')}`)
  }
  elapsed += duration
  return `${index + 1}\n${timestamp(start)} --> ${timestamp(elapsed)}\n${unit.text}`
})

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `WEBVTT\n\n${cues.join('\n\n')}\n`, 'utf-8')
process.stdout.write(`${output}\n${units.length} cues · ${totalWords} words · ${durationSeconds.toFixed(2)} seconds\n`)

function captionUnits(text) {
  const sentences = text
    .replace(/\r?\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)

  const outputUnits = []
  for (const sentence of sentences) {
    outputUnits.push(...fitCue(sentence, 68))
  }
  return outputUnits
}

function fitCue(text, maximumCharacters) {
  const words = text.split(/\s+/).filter(Boolean)
  const chunkCount = Math.max(1, Math.ceil(text.length / maximumCharacters))
  const targetCharacters = Math.ceil(text.length / chunkCount)
  const chunks = []
  let current = ''
  for (const [wordIndex, word] of words.entries()) {
    const next = current ? `${current} ${word}` : word
    const chunksRemaining = chunkCount - chunks.length
    const wordsRemaining = words.length - wordIndex
    if (
      next.length > targetCharacters &&
      current &&
      chunksRemaining > 1 &&
      wordsRemaining >= chunksRemaining
    ) {
      chunks.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function wrap(text) {
  const words = text.split(/\s+/)
  const lines = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (next.length > 42 && line) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  if (lines.length > 2) throw new Error(`Caption exceeds two lines: ${text}`)
  return lines.join('\n')
}

function wordCount(text) {
  return text.match(/[\p{L}\p{N}’'-]+/gu)?.length ?? 0
}

function timestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const secs = Math.floor((milliseconds % 60_000) / 1000)
  const millis = milliseconds % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}
