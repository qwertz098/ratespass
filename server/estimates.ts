// Schätzfragen („Wie hoch ist …?“, „In welchem Jahr …?“): Zahlenantworten für die Live-Schätzrunde. Eigener Bestand neben den
// Multiple-Choice-Fragen (Tabelle `estimates`), Batches im Verzeichnis batches/estimates/ (Format `ratespass-estimates`).
// Die Antworten zählen nicht in Bestenliste und Statistik: es gibt kein richtig/falsch, sondern nur „wie nah“.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { LICENSES, SOURCES, isCategory, isRegion } from './categories.ts'
import { all, get, run, tx, now } from './db.ts'

export interface EstimateEntry {
  category: string
  region?: string
  answer: number
  i18n: Record<string, { text: string; unit?: string; explanation?: string }>
}
export interface EstimateBatch {
  format: 'ratespass-estimates'; version: 1; batch: string; source: string; license: string; attribution?: string
  questions: EstimateEntry[]
}
export interface EstimateRow { id: number; group_id: string; lang: string; category: string; text: string; unit: string; answer: number; explanation: string | null }

const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex')
const norm = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const LANGS = ['de', 'en']

export function importEstimates(batch: EstimateBatch) {
  const report = { batch: batch?.batch, inserted: 0, duplicates: 0, errors: [] as string[] }
  if (batch?.format !== 'ratespass-estimates' || batch.version !== 1 || !batch.batch || !Array.isArray(batch.questions)) { report.errors.push('Kein gültiges ratespass-estimates (format/version/batch/questions)'); return report }
  if (!LICENSES[batch.license]) report.errors.push(`Lizenz nicht erlaubt: ${batch.license}`)
  if (!(SOURCES as readonly string[]).includes(batch.source)) report.errors.push(`Unbekannte Quelle: ${batch.source}`)
  if (report.errors.length) return report
  const run1 = () => {
    batch.questions.forEach((e, n) => {
      const where = `#${n + 1}`
      const region = e.region ?? 'global'
      if (!isCategory(e.category)) return report.errors.push(`${where}: unbekannte Kategorie ${e.category}`)
      if (!isRegion(region)) return report.errors.push(`${where}: unbekannte Region ${region}`)
      if (typeof e.answer !== 'number' || !Number.isFinite(e.answer) || Math.abs(e.answer) > 1e12) return report.errors.push(`${where}: Antwort keine gültige Zahl`)
      const langs = Object.keys(e.i18n ?? {})
      if (langs.some((l) => !LANGS.includes(l)) || !e.i18n?.de) return report.errors.push(`${where}: Sprachen nur de/en, deutsche Fassung Pflicht`)
      if (region === 'global' && !e.i18n.en) return report.errors.push(`${where}: globale Frage braucht eine englische Fassung`)
      if (region !== 'global' && e.i18n.en) return report.errors.push(`${where}: regionale Frage nur auf Deutsch`)
      for (const l of langs) {
        const c = e.i18n[l]
        if (typeof c.text !== 'string' || c.text.trim().length < 8 || c.text.length > 300) return report.errors.push(`${where}/${l}: Text 8–300 Zeichen`)
        if (c.unit !== undefined && (typeof c.unit !== 'string' || c.unit.length > 24)) return report.errors.push(`${where}/${l}: Einheit max. 24 Zeichen`)
        if (c.explanation !== undefined && (typeof c.explanation !== 'string' || c.explanation.length > 300)) return report.errors.push(`${where}/${l}: Erklärung max. 300 Zeichen`)
      }
      const group = 'e:' + sha1(norm(e.i18n.de.text)).slice(0, 16)
      for (const l of langs) {
        const c = e.i18n[l], uid = sha1(`${l}|${norm(c.text)}`)
        if (get('SELECT 1 FROM estimates WHERE uid=? OR (group_id=? AND lang=?)', uid, group, l)) { report.duplicates++; continue }
        run('INSERT INTO estimates(uid,group_id,lang,category,region,text,unit,answer,explanation,source,license,attribution,batch,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          uid, group, l, e.category, region, c.text.trim(), (c.unit ?? '').trim(), e.answer, c.explanation?.trim() ?? null, batch.source, batch.license, batch.attribution ?? null, batch.batch, now())
        report.inserted++
      }
    })
    if (report.errors.length) throw new Error('strict')
    run('INSERT OR REPLACE INTO batches(name,source,license,inserted,imported_at) VALUES(?,?,?,?,?)', batch.batch, batch.source, batch.license, report.inserted, now())
  }
  try { tx(run1) } catch (e: any) { if (e.message === 'strict') report.inserted = report.duplicates = 0; else throw e }
  return report
}

/** Importiert beim Start alle noch unbekannten Schätz-Batches aus <batchDir>/estimates/. */
export function importPendingEstimates(dir: string, log: (m: string) => void = console.log) {
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let batch: EstimateBatch
    try { batch = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { log(`estimates ${f}: ungültiges JSON`); continue }
    if (batch?.batch && get('SELECT 1 FROM batches WHERE name=?', batch.batch)) continue
    const r = importEstimates(batch)
    log(`estimates ${f}: +${r.inserted} neu, ${r.duplicates} Duplikate` + (r.errors.length ? `, FEHLER: ${r.errors.slice(0, 3).join(' | ')}` : ''))
  }
}

/** Zufällige Schätzfragen (höchstens `perCat` je Kategorie), ohne bereits benutzte Gruppen. */
export function pickEstimates(lang: string, cats: string[], n: number, exclude: Iterable<string> = [], perCat = 2): EstimateRow[] {
  const skip = new Set(exclude)
  const marks = cats.map(() => '?').join(',')
  const pool = all<EstimateRow>(`SELECT id, group_id, lang, category, text, unit, answer, explanation FROM estimates WHERE lang=? AND status='active' AND category IN (${marks}) ORDER BY RANDOM()`, lang, ...cats)
  const out: EstimateRow[] = [], count = new Map<string, number>()
  for (const q of pool) {
    if (skip.has(q.group_id) || (count.get(q.category) ?? 0) >= perCat) continue
    out.push(q); count.set(q.category, (count.get(q.category) ?? 0) + 1)
    if (out.length === n) return out
  }
  for (const q of pool) { if (out.length === n) break; if (!skip.has(q.group_id) && !out.includes(q)) out.push(q) } // zu wenig Vielfalt: auffüllen
  return out
}

/* ---------- Wertung ---------- */
/** Relativer Abstand zur richtigen Zahl (bei Antworten nahe 0 absolut zu 1 gerechnet). */
export const estimateError = (guess: number, answer: number) => Math.abs(guess - answer) / Math.max(Math.abs(answer), 1)
export const ESTIMATE_TOP = [1000, 700, 500] as const

/** Der nächste Tipp bekommt 1000, der zweite 700, der dritte 500 Punkte (Gleichstand teilt den Rang) – sofern er höchstens 100 % daneben liegt.
 *  Alle anderen bekommen bis zu 300 Punkte, linear fallend bis 50 % Abweichung. */
export function scoreGuesses(rows: { pid: number; value: number }[], answer: number): Map<number, { points: number; rank: number; error: number }> {
  const sorted = rows.map((r) => ({ ...r, error: estimateError(r.value, answer) })).sort((a, b) => a.error - b.error)
  const out = new Map<number, { points: number; rank: number; error: number }>()
  sorted.forEach((r, i) => {
    const rank = i > 0 && r.error === sorted[i - 1].error ? out.get(sorted[i - 1].pid)!.rank : i + 1
    const points = rank <= ESTIMATE_TOP.length && r.error < 1 ? ESTIMATE_TOP[rank - 1] : Math.round(300 * Math.max(0, 1 - 2 * r.error))
    out.set(r.pid, { points, rank, error: r.error })
  })
  return out
}
