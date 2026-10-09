// Holt Fragen von https://opentdb.com (CC BY-SA 4.0) und schreibt ein Batch (englisch).
// Verwendung: npm run fetch:opentdb -- --amount 200 --name otdb-001 [--out batches/otdb-001.json]
// Hinweise: API-Limit 1 Anfrage/5 s pro IP. Ein Session-Token (data/opentdb-token.txt) verhindert Wiederholungen
// über mehrere Läufe. Übersetzung ins Deutsche: siehe tools/export-missing.ts.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Batch, BatchEntry } from '../server/questions.ts'
import { validateContent } from '../server/questions.ts'
import { config } from '../server/config.ts'

export const OTDB_CATEGORY: Record<number, string> = {
  9: 'general', 10: 'literature', 11: 'film_tv', 12: 'music', 13: 'art', 14: 'film_tv', 15: 'games', 16: 'games',
  17: 'science', 18: 'tech', 19: 'science', 20: 'history', 21: 'sports', 22: 'geography', 23: 'history',
  24: 'general', 25: 'art', 26: 'general', 27: 'nature', 28: 'tech', 29: 'literature', 30: 'tech', 31: 'film_tv', 32: 'film_tv',
}
const DIFF: Record<string, number> = { easy: 1, medium: 2, hard: 3 }

export interface OtdbResult { category: string; type: string; difficulty: string; question: string; correct_answer: string; incorrect_answers: string[] }

/** Wandelt eine OpenTDB-Antwort (encode=url3986) in Batch-Einträge um. Nur Multiple-Choice mit 3 falschen Antworten. */
export function convertOtdb(results: OtdbResult[], categoryId: number, log: (m: string) => void = () => {}): BatchEntry[] {
  const out: BatchEntry[] = []
  for (const r of results) {
    if (r.type !== 'multiple') continue
    const dec = (s: string) => decodeURIComponent(s).trim()
    const content = { text: dec(r.question), correct: dec(r.correct_answer), wrong: r.incorrect_answers.map(dec) }
    const err = validateContent(content)
    if (err) { log(`übersprungen (${err}): ${content.text.slice(0, 60)}`); continue }
    out.push({
      category: OTDB_CATEGORY[categoryId], difficulty: DIFF[r.difficulty] ?? 2,
      source_ref: `https://opentdb.com/api_category.php#${categoryId}`, i18n: { en: content },
    })
  }
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function otdb(params: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`https://opentdb.com/${params}`, { headers: { 'user-agent': 'ratespass/0.1' } })
    const json: any = await res.json()
    if (json.response_code === 5 || res.status === 429) { await sleep(6000); continue }
    return json
  }
  throw new Error('OpenTDB: Rate-Limit')
}

async function main() {
  const arg = (k: string, d: string) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
  const amount = Number(arg('amount', '200'))
  const name = arg('name', 'otdb-' + Date.now())
  const out = arg('out', path.join(config.batchDir, `${name}.json`))
  const tokenFile = path.join(config.dataDir, 'opentdb-token.txt')
  fs.mkdirSync(config.dataDir, { recursive: true })
  let token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : ''
  if (!token) {
    token = (await otdb('api_token.php?command=request')).token
    fs.writeFileSync(tokenFile, token)
    await sleep(5500)
  }
  const ids = Object.keys(OTDB_CATEGORY).map(Number)
  const perCat = Math.ceil(amount / ids.length)
  const entries: BatchEntry[] = []
  for (const id of ids) {
    if (entries.length >= amount) break
    const want = Math.min(50, perCat, amount - entries.length)
    const j = await otdb(`api.php?amount=${want}&category=${id}&type=multiple&encode=url3986&token=${token}`)
    if (j.response_code === 0) entries.push(...convertOtdb(j.results, id, console.warn))
    else console.warn(`Kategorie ${id}: response_code ${j.response_code} (1=zu wenige, 4=erschöpft)`)
    console.log(`Kategorie ${id}: ${entries.length}/${amount}`)
    await sleep(5500)
  }
  const batch: Batch = {
    format: 'ratespass-batch', version: 1, batch: name, source: 'opentdb', license: 'CC-BY-SA-4.0',
    attribution: 'Open Trivia DB (https://opentdb.com), CC BY-SA 4.0', questions: entries.slice(0, amount),
  }
  fs.writeFileSync(out, JSON.stringify(batch, null, 1))
  console.log(`${batch.questions.length} Fragen -> ${out}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
