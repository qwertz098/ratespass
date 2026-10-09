// Überträgt Admin-Korrekturen aus der Moderation in die Batch-Dateien im Repo, damit Neuinstallationen die korrigierte Fassung bekommen.
// Verwendung: npm run apply:edits -- edits.json [--dir batches] [--dry-run]
// edits.json = Antwort von GET /api/admin/edits (im Admin-Bereich: „Korrekturen exportieren“). Idempotent: bereits übernommene Korrekturen werden erkannt.
import fs from 'node:fs'
import path from 'node:path'
import { normalize } from '../server/questions.ts'

const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const dirI = args.indexOf('--dir')
const dir = dirI >= 0 ? args[dirI + 1] : 'batches'
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--dir')
if (!file) { console.error('Verwendung: apply-edits.ts edits.json [--dir batches] [--dry-run]'); process.exit(1) }

interface Snap { text: string; correct: string; wrong: string[]; explanation?: string; category: string; difficulty: number; region: string }
interface Edit { id: number; lang: string; old: Snap; new: Snap }
const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
const edits: Edit[] = Array.isArray(parsed) ? parsed : parsed.edits

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
  const p = path.join(dir, f)
  return { p, batch: JSON.parse(fs.readFileSync(p, 'utf8')), dirty: false }
}).filter((f) => f.batch?.format === 'ratespass-batch')

let applied = 0, already = 0, missing = 0
for (const e of edits) {
  let done = false
  for (const f of files) for (const q of f.batch.questions) {
    const c = q.i18n?.[e.lang]
    if (!c) continue
    if (normalize(c.text) === normalize(e.new.text) && c.correct === e.new.correct) { already++; done = true; continue }
    if (normalize(c.text) !== normalize(e.old.text)) continue
    q.i18n[e.lang] = { text: e.new.text, correct: e.new.correct, wrong: e.new.wrong, ...(e.new.explanation ? { explanation: e.new.explanation } : {}) }
    q.category = e.new.category; q.difficulty = e.new.difficulty
    if (e.new.region !== 'global') q.region = e.new.region; else delete q.region
    f.dirty = true; applied++; done = true
  }
  if (!done) { missing++; console.warn(`Edit #${e.id} (${e.lang}): „${e.old.text}“ in keiner Batch-Datei gefunden (z. B. Community-Frage ohne Batch)`) }
}
if (!dry) for (const f of files) if (f.dirty) fs.writeFileSync(f.p, JSON.stringify(f.batch, null, 1))
console.log(`${applied} übernommen, ${already} bereits enthalten, ${missing} nicht gefunden${dry ? ' (dry-run, nichts geschrieben)' : ''}`)
