// Wortlisten für Wordle: reine Filterlogik (keine Datenbank, kein Netz). Erzeugt von tools/fetch-wordlists.ts, geladen von server/wordle.ts.
// Konvention: genau 5 Buchstaben, Kleinbuchstaben; Deutsch mit ä, ö, ü als eigene Buchstaben und OHNE ß; Englisch a–z.

export const WORDLE_LANGS = ['de', 'en'] as const
export type WordleLang = (typeof WORDLE_LANGS)[number]
export const WORD_LEN = 5

const RE: Record<WordleLang, RegExp> = { de: /^[a-zäöü]{5}$/, en: /^[a-z]{5}$/ }
export const isWordleLang = (l: unknown): l is WordleLang => WORDLE_LANGS.includes(l as WordleLang)

/** Eingabe oder Listeneintrag → gültiges Wort der Sprache (klein, NFC) oder null. */
export function normalizeWord(lang: WordleLang, raw: unknown): string | null {
  const w = String(raw ?? '').normalize('NFC').trim().toLowerCase()
  return RE[lang].test(w) ? w : null
}

export interface WordlistInput {
  lang: WordleLang
  /** Große Wörterliste (de: mit Groß-/Kleinschreibung der Wörterbuchform, en: Rateliste). */
  big: string[]
  /** Häufigkeitsliste, häufigste zuerst (nur das Wort pro Eintrag). */
  freq: string[]
  /** Vornamen (kleingeschrieben möglich), werden aus den Lösungen entfernt. */
  names?: string[]
  /** Fremdsprachige Wörter, die in den Lösungen nicht auftauchen sollen (de: englische Wörter). */
  foreign?: string[]
  /** Zeilen: „wort“ = nur aus den Lösungen entfernen, „!wort“ = überall entfernen. Kommentare mit #. */
  blocklist?: string[]
}

export interface Wordlist { words: string[]; solutions: string[] }

const FREQ_VALID = 30_000 // häufige Wörter zählen als gültige Eingaben
const LIMIT = { de: { lower: 30_000, caps: 15_000 }, en: { lower: 20_000, caps: 20_000 } } as const

export function buildWordlist(i: WordlistInput): Wordlist {
  const { lang } = i
  const lower = new Set<string>(), caps = new Set<string>()
  for (const raw of i.big) {
    const w = String(raw).normalize('NFC').trim()
    const lw = w.toLowerCase()
    if (!RE[lang].test(lw)) continue
    if (w === lw) lower.add(lw)
    else if (w[0] !== lw[0] && w.slice(1) === lw.slice(1)) caps.add(lw) // Substantiv: nur der erste Buchstabe groß
  }
  const rank = new Map<string, number>()
  i.freq.forEach((raw, n) => { const w = normalizeWord(lang, raw); if (w && !rank.has(w)) rank.set(w, n) })
  const names = new Set((i.names ?? []).map((n) => String(n).normalize('NFC').trim().toLowerCase()))
  const foreign = new Set((i.foreign ?? []).map((n) => String(n).trim().toLowerCase()))
  const everywhere = new Set<string>(), solutionsOnly = new Set<string>()
  for (const line of i.blocklist ?? []) {
    const t = line.replace(/#.*/, '').trim().toLowerCase()
    if (!t) continue
    if (t.startsWith('!')) everywhere.add(t.slice(1)); else solutionsOnly.add(t)
  }

  const valid = new Set<string>([...lower, ...caps])
  for (const [w, r] of rank) if (r < FREQ_VALID) valid.add(w)
  const solutions = new Set<string>()
  const lim = LIMIT[lang]
  for (const w of valid) {
    const r = rank.get(w)
    if (r === undefined) continue
    const isLower = lower.has(w)
    if (r >= (isLower ? lim.lower : lim.caps)) continue
    if (names.has(w) || foreign.has(w) || solutionsOnly.has(w)) continue
    if (!isLower && !caps.has(w)) continue // nur Wörter, die in der Wörterliste stehen
    solutions.add(w)
  }
  for (const w of everywhere) { valid.delete(w); solutions.delete(w) }
  const sort = (s: Iterable<string>) => [...s].sort((a, b) => a.localeCompare(b, lang))
  return { words: sort(valid), solutions: sort(solutions) }
}
