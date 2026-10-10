// Datenschutzerklärung und Impressum: vorbereitete Textvorlagen (legal/datenschutz.de.md und .en.md) mit den Angaben des Betreibers
// aus den Umgebungsvariablen (nur Verantwortlicher/Impressum, Hoster, Speicherdauer) und den aktiven Funktionen.
// `version` ist die Prüfsumme des gesamten Textes (de + en): Ändert sich Text, Verantwortlicher oder eine Funktion, ändert sich die Version
// und alle Spieler stimmen einmal erneut zu – sonst nie. Jede ausgelieferte Version wird mit vollem Text archiviert (Nachweis der Zustimmung).
// Hinweis: Das ist eine technische Vorlage, keine Rechtsberatung – bitte vor dem öffentlichen Betrieb prüfen lassen.
import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from './auth.ts'
import { config } from './config.ts'
import { all, get, run, now } from './db.ts'

export interface Section { title: string; paras?: string[]; items?: string[] }
export interface Doc { title: string; summary: string[]; sections: Section[] }
export interface Privacy { version: string; de: Doc; en: Doc; missing: string[] }

const REQUIRED = ['CONTROLLER_NAME', 'CONTROLLER_ADDRESS', 'CONTROLLER_EMAIL'] as const

/** Variablen für die Textvorlagen: Angaben des Betreibers aus der Umgebung plus Funktionsschalter. */
function vars(): Record<string, string> {
  const p = config.privacy
  return {
    CONTROLLER_NAME: p.controllerName, CONTROLLER_ADDRESS: p.controllerAddress, CONTROLLER_EMAIL: p.controllerEmail, CONTROLLER_PHONE: p.controllerPhone,
    CONTROLLER_REPRESENTATIVE: p.representative, CONTROLLER_REGISTER: p.register, CONTROLLER_VAT_ID: p.vatId, DPO_CONTACT: p.dpoContact,
    SUPERVISORY_AUTHORITY: p.supervisoryAuthority, HOSTING_PROVIDER: p.hosting, PRIVACY_RETENTION_DAYS: String(p.retentionDays),
    DUEL_FORFEIT_DAYS: String(config.duel.forfeitDays), DUEL_TAKEOVER_HOURS: String(config.duel.takeoverHours),
    ai: config.ai.key ? '1' : '',
  }
}

export function missingSettings(): string[] {
  const v = vars()
  return REQUIRED.filter((k) => !v[k])
}

/**
 * Markdown-ähnliche Vorlage → Dokument. `# Titel`, `## Abschnitt`, `- Listenpunkt`, sonst Absatz je Zeile; `<!-- Kommentar -->` wird ignoriert.
 * `{{NAME}}` wird ersetzt (fehlende Angaben erscheinen als „[nicht konfiguriert: NAME]“); `{{?NAME}}`/`{{!NAME}}` am Zeilenanfang
 * lassen die Zeile nur erscheinen, wenn NAME gesetzt bzw. nicht gesetzt ist. Der erste Abschnitt „Kurzfassung/Summary“ wird zur Zusammenfassung.
 */
export function renderTemplate(src: string, v: Record<string, string>): Doc {
  const doc: Doc = { title: '', summary: [], sections: [] }
  let cur: Section | null = null
  const text = src.replace(/<!--[\s\S]*?-->/g, '')
  for (const raw of text.split('\n')) {
    let line = raw.trim()
    if (!line) continue
    const cond = /^\{\{([?!])(\w+)\}\}/.exec(line)
    if (cond) { if ((cond[1] === '?') !== !!v[cond[2]]) continue; line = line.slice(cond[0].length) }
    line = line.replace(/\{\{(\w+)\}\}/g, (_, k: string) => v[k] || `[nicht konfiguriert: ${k}]`)
    if (line.startsWith('# ')) doc.title = line.slice(2)
    else if (line.startsWith('## ')) cur = { title: line.slice(3) }, doc.sections.push(cur)
    else if (cur) { if (line.startsWith('- ')) (cur.items ??= []).push(line.slice(2)); else (cur.paras ??= []).push(line) }
  }
  if (doc.sections.length && /^(Kurzfassung|Summary)$/i.test(doc.sections[0].title)) doc.summary = doc.sections.shift()!.items ?? []
  return doc
}

let cache: { key: string; value: Privacy } | undefined
export function buildPrivacy(): Privacy {
  const dir = config.legalDir
  const files = ['de', 'en'].map((l) => path.join(dir, `datenschutz.${l}.md`))
  const stamps = files.map((f) => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}` } catch { return '0' } })
  const key = JSON.stringify([vars(), stamps, dir])
  if (cache?.key === key) return cache.value
  const [de, en] = files.map((f) => renderTemplate(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '# Datenschutz\n## Fehlt\nTextvorlage nicht gefunden: ' + f, vars()))
  const value = { version: sha256(JSON.stringify({ de, en })), de, en, missing: missingSettings() }
  cache = { key, value }
  return value
}

/** Aktueller Text; jede Version wird beim ersten Ausliefern mit vollem Wortlaut archiviert. */
export function currentPrivacy(): Privacy {
  const p = buildPrivacy()
  if (!get('SELECT 1 FROM privacy_versions WHERE version=?', p.version)) run('INSERT INTO privacy_versions(version,text_json,first_seen) VALUES(?,?,?)', p.version, JSON.stringify({ de: p.de, en: p.en }), now())
  return p
}

export interface ConsentState { current: string; accepted: string | null; at: number | null }
export function consentState(playerId: number): ConsentState {
  const cur = currentPrivacy().version
  const c = get<{ version: string; accepted_at: number }>('SELECT version, accepted_at FROM consents WHERE player_id=? ORDER BY id DESC LIMIT 1', playerId)
  return { current: cur, accepted: c?.version ?? null, at: c?.accepted_at ?? null }
}
export const hasConsent = (playerId: number) => { const s = consentState(playerId); return s.accepted === s.current }

export function recordConsent(playerId: number, version: unknown, ageOk: unknown, lang: unknown) {
  const cur = currentPrivacy().version
  if (version !== cur) return 'changed' as const
  if (ageOk !== true) return 'age' as const
  run('INSERT INTO consents(player_id,version,accepted_at,age_ok,lang) VALUES(?,?,?,?,?)', playerId, cur, now(), 1, typeof lang === 'string' ? lang.slice(0, 5) : null)
  return 'ok' as const
}

export const consentStats = () => all<{ version: string; n: number; first_seen: number }>(
  'SELECT c.version, COUNT(DISTINCT c.player_id) n, v.first_seen FROM consents c JOIN privacy_versions v ON v.version=c.version GROUP BY c.version ORDER BY v.first_seen DESC')
