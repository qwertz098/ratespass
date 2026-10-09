// KI-Schnittstelle (Anthropic Messages API, ohne Zusatzbibliothek): neue Fragen erzeugen, Fragen prüfen und die
// Schwierigkeit schätzen. Grundsätze:
//  - Der API-Schlüssel bleibt auf dem Server (ANTHROPIC_API_KEY); ohne Schlüssel ist alles abgeschaltet.
//  - KI-Fragen landen immer als `pending` in der Moderation und gehen nie automatisch ins Spiel („nicht blind übernehmen“).
//  - Zweiter Durchlauf: ein getrennter Prüfaufruf verwirft Fragen mit unsicherer Lösung oder zeitabhängigem Fakt.
//  - Kostenbremse: Tageslimit für erzeugte Fragen (config.ai.dailyLimit), jedes Ergebnis wird in `ai_log` protokolliert.
//  - Steuerung der Verteilung: Zielverteilung der Schwierigkeit je Kategorie (z. B. mehr schwere Fragen) und Mindestgröße.
import crypto from 'node:crypto'
import { CATEGORIES, REGIONS, SERVABLE_SQL, tierOf, type Region } from './categories.ts'
import { config } from './config.ts'
import { all, get, run, tx, now } from './db.ts'
import { HttpError } from './http.ts'
import { applyPatch, insertQuestion, questionUid, validateContent, type QContent, type QRow } from './questions.ts'

export const aiEnabled = () => !!config.ai.key

/* ---------- Einstellungen (kv) ---------- */
export interface Target { diff: [number, number, number]; min_per_category: number }
const DEFAULT_TARGET: Target = { diff: [25, 40, 35], min_per_category: 100 }
const kvGet = (k: string) => get<{ value: string }>('SELECT value FROM kv WHERE key=?', k)?.value
const kvSet = (k: string, v: string) => run('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v)

export function getTarget(): Target {
  try { const t = JSON.parse(kvGet('ai_target') ?? 'null'); if (t && cleanTarget(t.diff, t.min_per_category)) return t } catch { /* Standard */ }
  return DEFAULT_TARGET
}
export function cleanTarget(diff: unknown, min: unknown): Target | null {
  if (!Array.isArray(diff) || diff.length !== 3 || !diff.every((x) => Number.isFinite(x) && x >= 0)) return null
  const sum = (diff as number[]).reduce((a, b) => a + b, 0)
  const m = Number(min)
  if (sum <= 0 || !Number.isInteger(m) || m < 10 || m > 5000) return null
  return { diff: (diff as number[]).map((x) => Math.round((x / sum) * 100)) as [number, number, number], min_per_category: m }
}
export function setTarget(diff: unknown, min: unknown) {
  const t = cleanTarget(diff, min)
  if (!t) throw new HttpError(400, 'bad_target')
  kvSet('ai_target', JSON.stringify(t))
  return t
}
export const autoEnabled = () => (kvGet('ai_auto') ?? (config.ai.auto ? '1' : '0')) === '1'
export const setAuto = (on: boolean) => kvSet('ai_auto', on ? '1' : '0')

/* ---------- Tageslimit & Protokoll ---------- */
const dayStart = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime() }
export const usedToday = () => get<{ n: number }>("SELECT COALESCE(SUM(n),0) n FROM ai_log WHERE kind='generate' AND created_at>=?", dayStart())!.n
export const remainingToday = () => Math.max(0, config.ai.dailyLimit - usedToday())
const log = (kind: string, n: number, detail: unknown) => run('INSERT INTO ai_log(kind,model,n,detail,created_at) VALUES(?,?,?,?,?)', kind, config.ai.model, n, JSON.stringify(detail).slice(0, 4000), now())

/* ---------- API-Aufruf ---------- */
export async function ask(system: string, user: string, maxTokens = 8000): Promise<string> {
  if (!aiEnabled()) throw new HttpError(503, 'ai_unavailable')
  let res: Response
  try {
    res = await fetch(`${config.ai.baseUrl}/v1/messages`, {
      method: 'POST', signal: AbortSignal.timeout(120_000),
      headers: { 'content-type': 'application/json', 'x-api-key': config.ai.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.ai.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    })
  } catch (e) { throw new HttpError(502, 'ai_failed', `KI nicht erreichbar: ${(e as Error).message}`) }
  if (!res.ok) throw new HttpError(502, 'ai_failed', `KI-Dienst antwortet mit ${res.status}`)
  const body = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[] } | null
  const text = body?.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
  if (!text) throw new HttpError(502, 'ai_failed', 'Leere Antwort der KI')
  return text
}

/** Erstes JSON-Array bzw. -Objekt aus einer Antwort lesen (Modelle setzen gelegentlich Text oder ```-Zäune drumherum). */
export function extractJson(text: string): unknown {
  const t = text.replace(/```(?:json)?/g, '')
  for (const [open, close] of [['[', ']'], ['{', '}']] as const) {
    const a = t.indexOf(open), b = t.lastIndexOf(close)
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)) } catch { /* nächster Versuch */ } }
  }
  throw new HttpError(502, 'ai_failed', 'Antwort der KI war kein gültiges JSON')
}

/* ---------- Plan: wo fehlen Fragen? ---------- */
const DIFF_NAME = { 1: 'leicht', 2: 'mittel', 3: 'schwer' } as const
export interface Gap { category: string; difficulty: 1 | 2 | 3; have: number; want: number; deficit: number }

/** Soll-Ist-Vergleich je Kategorie und Schwierigkeit (deutsche, ausspielbare, aktive Fragen plus bereits wartende KI-Fragen). */
export function plan(target = getTarget()): Gap[] {
  const rows = all<{ category: string; difficulty: number; status: string; n: number }>(
    `SELECT category, difficulty, status, COUNT(*) n FROM questions WHERE lang='de' AND ${SERVABLE_SQL} AND (status='active' OR (status='pending' AND source='llm'))
     GROUP BY category, difficulty, status`)
  const have = new Map<string, number>()
  for (const r of rows) have.set(`${r.category}|${r.difficulty}`, (have.get(`${r.category}|${r.difficulty}`) ?? 0) + r.n)
  const gaps: Gap[] = []
  for (const category of CATEGORIES) {
    const h = [1, 2, 3].map((d) => have.get(`${category}|${d}`) ?? 0)
    const basis = Math.max(h[0] + h[1] + h[2], target.min_per_category)
    for (const d of [1, 2, 3] as const) {
      const want = Math.round((basis * target.diff[d - 1]) / 100)
      gaps.push({ category, difficulty: d, have: h[d - 1], want, deficit: Math.max(0, want - h[d - 1]) })
    }
  }
  return gaps.sort((a, b) => b.deficit - a.deficit)
}

/* ---------- Fragen erzeugen ---------- */
const CAT_HINT: Record<string, string> = {
  general: 'Allgemeinwissen', geography: 'Geografie', history: 'Geschichte', science: 'Naturwissenschaften', nature: 'Natur und Tiere', sports: 'Sport',
  film_tv: 'Film und Fernsehen', music: 'Musik', literature: 'Literatur', art: 'Kunst und Kultur', games: 'Spiele', tech: 'Technik',
  scifi_fantasy: 'Science-Fiction und Fantasy (Bücher, Filme, Serien)', coding: 'Programmieren und IT-Alltag', anime: 'Anime und Manga', retro_games: 'Retro-Videospiele und Heimcomputer',
  expert_mint: 'MINT und Ingenieurwesen auf Hochschulniveau', expert_humanities: 'Geisteswissenschaften (Philosophie, Linguistik, Soziologie, Geschichtswissenschaft, Religionswissenschaft)',
  expert_arts: 'Kunst- und Literaturwissenschaft, Musik- und Filmgeschichte auf Expertenniveau', expert_it: 'Informatik auf Hochschulniveau (Algorithmen, Systeme, Netze, Sicherheit)',
}
const LEVEL_HINT = { 1: 'leicht: die meisten Erwachsenen kennen die Antwort', 2: 'mittel: Allgemeinbildung und etwas Interesse nötig', 3: 'schwer: nur Kenner oder Fachinteressierte wissen es' } as const
const SYSTEM = `Du bist Redakteur eines Quiz-Spiels (Multiple Choice mit genau 4 Antworten). Du schreibst eigene, sachlich korrekte Fragen in eigenen Worten.
Regeln: genau eine eindeutig richtige Antwort, drei klar falsche aber plausible Distraktoren; Antworten höchstens 80 Zeichen; Frage 8–300 Zeichen; zeitlos formuliert (keine Angaben wie „aktuell“, „derzeit“, „neuester“); keine Fragen aus bekannten Quizshows oder Fragenkatalogen übernehmen; keine Meinungsfragen; keine Politik-Tagesfragen; die falschen Antworten dürfen nicht ebenfalls richtig sein.
Antworte ausschließlich mit JSON, ohne Erklärtext.`

interface Candidate { de: QContent; en?: QContent; region: Region; estimate: number; confidence: number | null }

const asContent = (o: any): QContent | undefined =>
  o && typeof o === 'object' ? { text: String(o.text ?? ''), correct: String(o.correct ?? ''), wrong: Array.isArray(o.wrong) ? o.wrong.map(String) : [], ...(o.explanation ? { explanation: String(o.explanation) } : {}) } : undefined

export interface GenResult { requested: number; created: number; rejected: { text: string; reason: string }[]; groups: string[] }

export async function generate(opts: { category: string; difficulty: number; count: number }): Promise<GenResult> {
  if (!aiEnabled()) throw new HttpError(503, 'ai_unavailable')
  if (!(CATEGORIES as readonly string[]).includes(opts.category)) throw new HttpError(400, 'bad_category')
  if (![1, 2, 3].includes(opts.difficulty)) throw new HttpError(400, 'bad_difficulty')
  const count = Math.min(25, Math.max(1, Math.floor(opts.count)))
  const left = remainingToday()
  if (left <= 0) throw new HttpError(429, 'ai_limit')
  const n = Math.min(count, left)

  const existing = all<{ text: string }>("SELECT text FROM questions WHERE lang='de' AND category=? AND status<>'rejected' ORDER BY RANDOM() LIMIT 40", opts.category).map((r) => r.text)
  const user = JSON.stringify({
    aufgabe: `Erzeuge ${n} neue Quizfragen.`, kategorie: CAT_HINT[opts.category], stufe: tierOf(opts.category), schwierigkeit: `${opts.difficulty} = ${LEVEL_HINT[opts.difficulty as 1 | 2 | 3]}`,
    sprachen: 'Jede Frage auf Deutsch (de) und Englisch (en). Wissen, das nur im deutschsprachigen Raum geläufig ist, bekommt region "dach" und nur die deutsche Fassung; alles andere region "global" mit beiden Sprachen.',
    bereits_vorhanden_nicht_wiederholen: existing,
    ausgabeformat: '[{"region":"global|dach","schwierigkeit_schaetzung":1-3,"sicherheit":0-1,"de":{"text":"","correct":"","wrong":["","",""],"explanation":"optional"},"en":{…wie de, entfällt bei dach}}]',
  })
  const raw = extractJson(await ask(SYSTEM, user))
  if (!Array.isArray(raw)) throw new HttpError(502, 'ai_failed', 'Antwort der KI war kein Array')

  const rejected: GenResult['rejected'] = []
  const cands: Candidate[] = []
  for (const item of raw.slice(0, n + 5) as any[]) {
    const de = asContent(item?.de), en = asContent(item?.en)
    const region = item?.region === 'dach' ? 'dach' : 'global'
    const label = de?.text?.slice(0, 80) ?? '(leer)'
    const err = (de ? validateContent(de) : 'deutsche Fassung fehlt') || (region === 'global' ? (en ? validateContent(en) : 'englische Fassung fehlt') : null)
    if (err) { rejected.push({ text: label, reason: err }); continue }
    if (!(REGIONS as readonly string[]).includes(region)) { rejected.push({ text: label, reason: 'Region' }); continue }
    if (get('SELECT 1 FROM questions WHERE uid=?', questionUid('de', de!.text))) { rejected.push({ text: label, reason: 'Dublette' }); continue }
    const est = Number(item?.schwierigkeit_schaetzung)
    cands.push({ de: de!, en: region === 'global' ? en : undefined, region, estimate: [1, 2, 3].includes(est) ? est : opts.difficulty, confidence: Number.isFinite(Number(item?.sicherheit)) ? Math.min(1, Math.max(0, Number(item.sicherheit))) : null })
  }

  // Zweiter, unabhängiger Prüfdurchlauf (Faktencheck, Eindeutigkeit, Zeitlosigkeit)
  let verdicts: { i: number; ok: boolean; issue?: string }[] = []
  if (cands.length) {
    const check = extractJson(await ask('Du bist ein strenger Faktenprüfer für ein Quiz. Antworte ausschließlich mit JSON.', JSON.stringify({
      aufgabe: 'Prüfe jede Frage: Ist die mit correct markierte Antwort eindeutig und nachprüfbar richtig? Sind alle wrong-Antworten eindeutig falsch? Ist die Frage zeitlos und nicht mehrdeutig? Im Zweifel ok=false.',
      fragen: cands.map((c, i) => ({ i, text: c.de.text, correct: c.de.correct, wrong: c.de.wrong })),
      ausgabeformat: '[{"i":0,"ok":true|false,"issue":"kurzer Grund bei false"}]',
    }), 4000))
    if (Array.isArray(check)) verdicts = check as typeof verdicts
  }
  const ok = (i: number) => verdicts.find((v) => v.i === i)?.ok === true

  const groups: string[] = []
  tx(() => {
    cands.forEach((c, i) => {
      if (!ok(i)) { rejected.push({ text: c.de.text.slice(0, 80), reason: 'Prüfung: ' + (verdicts.find((v) => v.i === i)?.issue ?? 'nicht bestätigt') }); return }
      const group = 'a:' + crypto.randomBytes(8).toString('hex')
      const base = { group, category: opts.category, difficulty: opts.difficulty, region: c.region, source: 'llm', license: 'CC-BY-SA-4.0', attribution: 'Ratespaß-Projekt (KI-gestützt erstellt, redaktionell geprüft)', status: 'pending' as const }
      if (!insertQuestion({ ...base, lang: 'de', content: c.de })) { rejected.push({ text: c.de.text.slice(0, 80), reason: 'Dublette' }); return }
      if (c.en) insertQuestion({ ...base, lang: 'en', content: c.en })
      run('UPDATE questions SET ai_difficulty=?, ai_confidence=?, ai_note=? WHERE group_id=?', c.estimate, c.confidence, 'Erzeugt für Stufe ' + DIFF_NAME[opts.difficulty as 1 | 2 | 3], group)
      groups.push(group)
    })
  })
  log('generate', n, { category: opts.category, difficulty: opts.difficulty, created: groups.length, rejected: rejected.length })
  return { requested: n, created: groups.length, rejected, groups }
}

/** Füllt die größten Lücken des Plans (für den Auto-Lauf und den Admin-Knopf „Lücken füllen“). */
export async function fillGaps(maxQuestions: number): Promise<GenResult[]> {
  const out: GenResult[] = []
  let budget = Math.min(maxQuestions, remainingToday())
  for (const gap of plan().filter((g) => g.deficit > 0)) {
    if (budget <= 0) break
    const r = await generate({ category: gap.category, difficulty: gap.difficulty, count: Math.min(10, gap.deficit, budget) })
    out.push(r); budget -= r.requested
    if (out.length >= 6) break // pro Lauf höchstens 6 Aufrufe
  }
  return out
}

/* ---------- Schwierigkeit schätzen ---------- */
/** Lässt die KI die Schwierigkeit noch nicht bewerteter Fragen (je Gruppe) schätzen. Gibt die Zahl der bewerteten Gruppen zurück. */
export async function estimate(opts: { limit: number; category?: string }): Promise<{ rated: number; skipped: number }> {
  if (!aiEnabled()) throw new HttpError(503, 'ai_unavailable')
  const limit = Math.min(60, Math.max(1, Math.floor(opts.limit)))
  const rows = all<QRow>(
    `SELECT * FROM questions WHERE lang='de' AND status IN ('active','pending') AND ai_difficulty IS NULL ${opts.category ? 'AND category=?' : ''} ORDER BY id LIMIT ?`,
    ...(opts.category ? [opts.category, limit] : [limit]))
  let rated = 0, skipped = 0
  for (let a = 0; a < rows.length; a += 10) {
    const part = rows.slice(a, a + 10)
    const res = extractJson(await ask('Du schätzt die Schwierigkeit von Quizfragen für erwachsene Spieler im deutschsprachigen Raum. 1 = leicht (die meisten wissen es, Lösungsquote ab ca. 75 %), 2 = mittel (ca. 50–75 %), 3 = schwer (unter ca. 50 %; bei 4 Antworten liegt die Ratequote bei 25 %). Antworte ausschließlich mit JSON.', JSON.stringify({
      fragen: part.map((q, i) => ({ i, kategorie: q.category, text: q.text, richtig: q.correct, falsch: JSON.parse(q.wrong) })),
      ausgabeformat: '[{"i":0,"schwierigkeit":1-3,"sicherheit":0-1,"kurz":"Begründung in einem Satz"}]',
    }), 3000))
    for (const v of (Array.isArray(res) ? res : []) as any[]) {
      const q = part[Number(v?.i)]
      const d = Number(v?.schwierigkeit)
      if (!q || ![1, 2, 3].includes(d)) { skipped++; continue }
      const conf = Math.min(1, Math.max(0, Number(v?.sicherheit)))
      run('UPDATE questions SET ai_difficulty=?, ai_confidence=?, ai_note=? WHERE group_id=?', d, Number.isFinite(conf) ? conf : null, String(v?.kurz ?? '').slice(0, 200), q.group_id)
      rated++
    }
  }
  log('estimate', rated, { category: opts.category ?? null, skipped })
  return { rated, skipped }
}

/** Übernimmt KI-Schätzungen als Schwierigkeit (nur bei ausreichender Sicherheit und echter Abweichung); wird in `edits` protokolliert. */
export function applyEstimates(minConfidence: number): { changed: number } {
  const rows = all<QRow>(`SELECT * FROM questions WHERE lang='de' AND status='active' AND ai_difficulty IS NOT NULL AND ai_difficulty<>difficulty AND ai_confidence>=? GROUP BY group_id`, minConfidence)
  let changed = 0
  for (const q of rows) { applyPatch(q, { difficulty: q.ai_difficulty! }); changed++ }
  if (changed) log('apply', changed, { minConfidence })
  return { changed }
}

export function status() {
  const g = plan()
  return {
    enabled: aiEnabled(), model: config.ai.model, daily_limit: config.ai.dailyLimit, used_today: usedToday(), auto: autoEnabled(), auto_interval_hours: config.ai.autoIntervalHours,
    target: getTarget(), plan: g.filter((x) => x.deficit > 0).slice(0, 40), total_deficit: g.reduce((s, x) => s + x.deficit, 0),
    pending_ai: get<{ n: number }>("SELECT COUNT(DISTINCT group_id) n FROM questions WHERE source='llm' AND status='pending'")!.n,
    unrated: get<{ n: number }>("SELECT COUNT(*) n FROM questions WHERE lang='de' AND status IN ('active','pending') AND ai_difficulty IS NULL")!.n,
  }
}

/** Auto-Lauf: höchstens einmal je Intervall, nur mit Schlüssel und eingeschaltetem Auto-Modus. Ergebnisse landen in der Moderation. */
export async function autoRun(): Promise<GenResult[] | null> {
  if (!aiEnabled() || !autoEnabled()) return null
  const last = Number(kvGet('ai_last_auto') ?? 0)
  if (now() - last < config.ai.autoIntervalHours * 3_600_000) return null
  kvSet('ai_last_auto', String(now()))
  return fillGaps(config.ai.autoBatch)
}
