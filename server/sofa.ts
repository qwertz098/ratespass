// Sofa-Modus: ein Gerät, mehrere Spieler reihum – ohne Konten und ohne Netz-Spielzustand. Der Server liefert nur den Fragensatz
// (mit Lösung, der Fragenbestand ist ohnehin über /api/dataset.jsonl öffentlich); Namen, Punkte und Reihenfolge bleiben im Browser.
// Es wird nichts gespeichert und nichts für Statistik/Bestenliste gezählt.
import type { PlayerRow } from './auth.ts'
import { shuffle, shown } from './ladder.ts'
import { pickQuestions } from './rooms.ts'
import { effectiveFor } from './settings.ts'

export const SOFA_MAX = 60
const DIFFS = [1, 2, 2, 3]

export function sofaQuestions(me: PlayerRow, lang: string, rawN: unknown) {
  const n = Math.min(SOFA_MAX, Math.max(2, Math.round(Number(rawN) || 12)))
  const eff = effectiveFor([me.id])
  const diffs = shuffle(Array.from({ length: n }, (_, i) => DIFFS[i % DIFFS.length]))
  return pickQuestions(lang, eff.cats, [me.id], diffs).map((q) => {
    const perm = shuffle([0, 1, 2, 3])
    return { text: q.text, options: shown(q, perm), correct_index: perm.indexOf(0), category: q.category, explanation: q.explanation ?? null }
  })
}
