import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CATEGORIES, LICENSES, REGIONS, SOURCES, isCategory, isRegion } from './categories.ts'
import { all, get, run, tx, now } from './db.ts'
import { HttpError } from './http.ts'

export interface QContent { text: string; correct: string; wrong: string[]; explanation?: string }
export interface BatchEntry {
  /** Verknüpft Übersetzungen; fehlt sie, wird sie aus dem Text abgeleitet. */
  group?: string
  category?: string
  difficulty?: number
  /** `global` (Standard) oder `dach`; regionale Fragen werden nur in den Sprachen aus REGION_LANGS ausgespielt. */
  region?: string
  source?: string
  license?: string
  attribution?: string
  source_ref?: string
  i18n: Record<string, QContent>
}
export interface Batch {
  format: 'ratespass-batch'
  version: 1
  batch: string
  source: string
  license: string
  attribution?: string
  questions: BatchEntry[]
}
export interface ImportReport { batch: string; inserted: number; translated: number; duplicates: number; errors: string[] }

const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex')
export const normalize = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
export const questionUid = (lang: string, text: string) => sha1(`${lang}|${normalize(text)}`)

const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/

/** Gemeinsame Prüfung für Importe und Community-Einreichungen. Gibt Fehlertext oder null zurück. */
export function validateContent(c: QContent): string | null {
  if (!c || typeof c !== 'object') return 'Inhalt fehlt'
  const { text, correct, wrong } = c
  if (typeof text !== 'string' || text.trim().length < 8 || text.length > 300) return 'Fragetext 8–300 Zeichen'
  if (typeof correct !== 'string' || !Array.isArray(wrong) || wrong.length !== 3) return 'Eine richtige und genau 3 falsche Antworten nötig'
  const answers = [correct, ...wrong]
  if (answers.some((a) => typeof a !== 'string' || !a.trim() || a.length > 80)) return 'Antworten 1–80 Zeichen'
  if (new Set(answers.map(normalize)).size !== 4) return 'Antworten müssen verschieden sein'
  // eslint-disable-next-line no-control-regex
  if ([text, ...answers, c.explanation ?? ''].some((s) => /[\u0000-\u0008\u000b-\u001f\u007f]/.test(s))) return 'Steuerzeichen nicht erlaubt'
  if (c.explanation !== undefined && (typeof c.explanation !== 'string' || c.explanation.length > 300)) return 'Erklärung max. 300 Zeichen'
  return null
}

export interface InsertInput {
  group: string; lang: string; category: string; difficulty: number; region?: string
  content: QContent; source: string; license: string
  attribution?: string | null; source_ref?: string | null; batch?: string | null
  status?: 'active' | 'pending'; submitted_by?: number | null
}

/** Fügt eine Frage ein. Gibt false zurück, wenn sie (oder die Sprachversion der Gruppe) schon existiert. */
export function insertQuestion(q: InsertInput): boolean {
  const uid = questionUid(q.lang, q.content.text)
  if (get('SELECT 1 FROM questions WHERE uid=?', uid)) return false
  if (get('SELECT 1 FROM questions WHERE group_id=? AND lang=?', q.group, q.lang)) return false
  run(
    `INSERT INTO questions(uid,group_id,lang,category,difficulty,region,text,correct,wrong,explanation,source,license,attribution,source_ref,batch,status,submitted_by,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    uid, q.group, q.lang, q.category, q.difficulty, q.region ?? 'global', q.content.text.trim(), q.content.correct.trim(),
    JSON.stringify(q.content.wrong.map((w) => w.trim())), q.content.explanation?.trim() ?? null,
    q.source, q.license, q.attribution ?? null, q.source_ref ?? null, q.batch ?? null,
    q.status ?? 'active', q.submitted_by ?? null, now(),
  )
  return true
}

interface GroupMeta { category: string; difficulty: number; region: string; source: string; license: string; attribution: string | null; source_ref: string | null }

export function importBatch(batch: Batch, opts: { dryRun?: boolean; lenient?: boolean } = {}): ImportReport {
  const report: ImportReport = { batch: batch?.batch, inserted: 0, translated: 0, duplicates: 0, errors: [] }
  if (batch?.format !== 'ratespass-batch' || batch.version !== 1 || !batch.batch || !Array.isArray(batch.questions)) {
    report.errors.push('Kein gültiges ratespass-batch (format/version/batch/questions)')
    return report
  }
  if (!LICENSES[batch.license]) report.errors.push(`Lizenz nicht erlaubt: ${batch.license} (erlaubt: ${Object.keys(LICENSES).join(', ')})`)
  if (!(SOURCES as readonly string[]).includes(batch.source)) report.errors.push(`Unbekannte Quelle: ${batch.source}`)
  if (report.errors.length) return report

  const run1 = () => {
    batch.questions.forEach((e, n) => {
      const where = `#${n + 1}`
      const langs = Object.keys(e.i18n ?? {})
      if (!langs.length) return report.errors.push(`${where}: i18n leer`)
      if (langs.some((l) => !LANG_RE.test(l))) return report.errors.push(`${where}: ungültiger Sprachcode`)
      const first = e.i18n[langs.includes('en') ? 'en' : langs[0]]
      const group = e.group ?? 'g:' + sha1(normalize(first?.text ?? '')).slice(0, 16)
      const existing = get<GroupMeta>(
        'SELECT category,difficulty,region,source,license,attribution,source_ref FROM questions WHERE group_id=? LIMIT 1', group)
      const category = e.category ?? existing?.category
      const difficulty = e.difficulty ?? existing?.difficulty
      if (!isCategory(category)) return report.errors.push(`${where}: Kategorie fehlt/ungültig (${category}); erlaubt: ${CATEGORIES.join(', ')}`)
      if (![1, 2, 3].includes(difficulty as number)) return report.errors.push(`${where}: difficulty muss 1–3 sein`)
      const region = e.region ?? existing?.region ?? 'global'
      if (!isRegion(region)) return report.errors.push(`${where}: Region ungültig (${region}); erlaubt: ${REGIONS.join(', ')}`)
      const license = e.license ?? existing?.license ?? batch.license
      const source = e.source ?? existing?.source ?? batch.source
      if (!LICENSES[license]) return report.errors.push(`${where}: Lizenz nicht erlaubt: ${license}`)
      if (existing && license !== existing.license) return report.errors.push(`${where}: Übersetzung darf Lizenz der Gruppe nicht ändern`)
      const attribution = e.attribution ?? existing?.attribution ?? batch.attribution ?? null
      for (const lang of langs) {
        const err = validateContent(e.i18n[lang])
        if (err) { report.errors.push(`${where} [${lang}]: ${err}`); continue }
        const had = !!existing
        const ok = insertQuestion({
          group, lang, category, difficulty: difficulty as number, region, content: e.i18n[lang], source, license,
          attribution, source_ref: e.source_ref ?? existing?.source_ref ?? null, batch: batch.batch,
        })
        if (!ok) report.duplicates++
        else if (had) report.translated++
        else report.inserted++
      }
    })
    if (report.errors.length && !opts.lenient) throw new Error('strict')
    if (opts.dryRun) throw new Error('dry')
    run('INSERT OR REPLACE INTO batches(name,source,license,inserted,imported_at) VALUES(?,?,?,?,?)',
      batch.batch, batch.source, batch.license, report.inserted + report.translated, now())
  }
  try {
    tx(run1)
  } catch (e: any) {
    if (e.message === 'strict') { report.inserted = report.translated = 0; report.errors.push('Abgebrochen (strict): nichts importiert') }
    else if (e.message === 'dry') { /* Rollback gewollt */ }
    else throw e
  }
  return report
}

/** Importiert beim Start alle noch unbekannten Batch-Dateien aus dem batches/-Verzeichnis. */
export function importPendingBatches(dir: string, log: (m: string) => void = console.log) {
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let batch: Batch
    try { batch = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { log(`batch ${f}: ungültiges JSON`); continue }
    if (batch?.batch && get('SELECT 1 FROM batches WHERE name=?', batch.batch)) continue
    const r = importBatch(batch)
    log(`batch ${f}: +${r.inserted} neu, +${r.translated} Übersetzungen, ${r.duplicates} Duplikate` + (r.errors.length ? `, FEHLER: ${r.errors.slice(0, 3).join(' | ')}` : ''))
  }
}

export interface QRow {
  id: number; uid: string; group_id: string; lang: string; category: string; difficulty: number
  text: string; correct: string; wrong: string; explanation: string | null
  source: string; license: string; attribution: string | null; source_ref: string | null
  batch: string | null; status: string; submitted_by: number | null; created_at: number; region: string
}

export function datasetLines(): string[] {
  return all<QRow>("SELECT * FROM questions WHERE status='active' ORDER BY id").map((q) =>
    JSON.stringify({
      group: q.group_id, lang: q.lang, category: q.category, difficulty: q.difficulty, region: q.region,
      text: q.text, correct: q.correct, wrong: JSON.parse(q.wrong), explanation: q.explanation,
      source: q.source, license: q.license, attribution: q.attribution, source_ref: q.source_ref,
    }))
}

export function licenseSummary() {
  const rows = all<{ source: string; license: string; attribution: string | null; n: number }>(
    "SELECT source, license, attribution, COUNT(*) n FROM questions WHERE status='active' GROUP BY source, license, attribution ORDER BY n DESC")
  return rows.map((r) => ({ ...r, license_url: LICENSES[r.license] }))
}

/** Nächster freier Batch-Name `community-NNN` (Datenbank und Dateien im Batch-Verzeichnis berücksichtigt). */
function nextCommunityName(dir: string): string {
  const used = [
    ...all<{ name: string }>("SELECT name FROM batches WHERE name LIKE 'community-%'").map((r) => r.name),
    ...(fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => f.replace(/\.json$/, '')) : []),
  ]
  const max = Math.max(0, ...used.map((n) => Number(/^community-(\d+)$/.exec(n)?.[1] ?? 0)))
  return `community-${String(max + 1).padStart(3, '0')}`
}

/**
 * Exportiert freigegebene Community-Fragen, die noch in keinem Batch stehen, als Batch (für das Repo).
 * Mit mark=true werden sie danach dem Batch zugeordnet und in `batches` vermerkt, sodass sie nicht erneut
 * exportiert und beim Neustart nicht doppelt importiert werden. Personenbezug (submitted_by) wird nicht exportiert.
 */
export function exportCommunityBatch(opts: { mark: boolean; dir: string }): Batch | null {
  return tx(() => {
    const rows = all<QRow>("SELECT * FROM questions WHERE source='community' AND status='active' AND batch IS NULL ORDER BY id")
    if (!rows.length) return null
    const groups = new Map<string, QRow[]>()
    for (const r of rows) groups.set(r.group_id, [...(groups.get(r.group_id) ?? []), r])
    const name = nextCommunityName(opts.dir)
    const questions: BatchEntry[] = [...groups.entries()].map(([group, rs]) => ({
      group, category: rs[0].category, difficulty: rs[0].difficulty, ...(rs[0].region !== 'global' ? { region: rs[0].region } : {}),
      source: 'community', license: rs[0].license, attribution: rs[0].attribution ?? 'Community contribution',
      i18n: Object.fromEntries(rs.map((r) => [r.lang, {
        text: r.text, correct: r.correct, wrong: JSON.parse(r.wrong) as string[], ...(r.explanation ? { explanation: r.explanation } : {}),
      }])),
    }))
    const batch: Batch = { format: 'ratespass-batch', version: 1, batch: name, source: 'community', license: 'CC-BY-SA-4.0', attribution: 'Community contribution', questions }
    if (opts.mark) {
      for (const r of rows) run('UPDATE questions SET batch=? WHERE id=?', name, r.id)
      run('INSERT INTO batches(name,source,license,inserted,imported_at) VALUES(?,?,?,?,?)', name, 'community', 'CC-BY-SA-4.0', rows.length, now())
    }
    return batch
  })
}

/* ---------- Korrekturen durch Admins ---------- */
export interface QPatch extends Partial<QContent> { category?: string; difficulty?: number; region?: string }
const snapshot = (q: QRow) => ({
  text: q.text, correct: q.correct, wrong: JSON.parse(q.wrong) as string[], explanation: q.explanation ?? undefined,
  category: q.category, difficulty: q.difficulty, region: q.region,
})

/**
 * Ändert Inhalt/Metadaten einer Frage (mit denselben Prüfregeln wie beim Import) und protokolliert die Änderung in `edits`.
 * Kategorie, Schwierigkeit und Region gelten für die ganze Gruppe (alle Sprachen). Der Status bleibt unberührt.
 */
export function applyPatch(q: QRow, patch: QPatch): void {
  const content: QContent = {
    text: patch.text ?? q.text, correct: patch.correct ?? q.correct,
    wrong: patch.wrong ?? JSON.parse(q.wrong), explanation: patch.explanation ?? q.explanation ?? undefined,
  }
  const err = validateContent(content)
  if (err) throw new HttpError(400, 'invalid_question', err)
  const category = patch.category ?? q.category
  const difficulty = patch.difficulty ?? q.difficulty
  const region = patch.region ?? q.region
  if (!isCategory(category)) throw new HttpError(400, 'bad_category')
  if (![1, 2, 3].includes(difficulty)) throw new HttpError(400, 'bad_difficulty')
  if (!isRegion(region)) throw new HttpError(400, 'bad_region')
  const uid = questionUid(q.lang, content.text)
  if (uid !== q.uid && get('SELECT 1 FROM questions WHERE uid=?', uid)) throw new HttpError(409, 'duplicate')
  const before = snapshot(q)
  tx(() => {
    run('UPDATE questions SET uid=?, text=?, correct=?, wrong=?, explanation=? WHERE id=?',
      uid, content.text.trim(), content.correct.trim(), JSON.stringify(content.wrong.map((w) => w.trim())), content.explanation?.trim() ?? null, q.id)
    run('UPDATE questions SET category=?, difficulty=?, region=? WHERE group_id=?', category, difficulty, region, q.group_id)
    const after = snapshot(get<QRow>('SELECT * FROM questions WHERE id=?', q.id)!)
    if (JSON.stringify(before) !== JSON.stringify(after))
      run('INSERT INTO edits(question_id,group_id,lang,batch,old,new,created_at) VALUES(?,?,?,?,?,?,?)',
        q.id, q.group_id, q.lang, q.batch, JSON.stringify(before), JSON.stringify(after), now())
  })
}
