// Spielmodi des Live-Spielabends: reine Regeln ohne Datenbankzugriff (Fragenplan, Einsätze, Rennstrecke, Teamwertung).
// Der Lebenszyklus (Lobby, Zeitgeber, SSE) liegt in live.ts.
//  - tempo:    feste Zahl Fragen, richtig = 500–1000 Punkte je nach Tempo.
//  - survival: Millionen-Leiter-Schwierigkeit; wer falsch oder gar nicht antwortet, scheidet aus.
//  - race:     jede richtige Antwort = 1 Feld, die schnellste richtige = +1 Bonusfeld; wer 12 Felder erreicht, gewinnt.
//  - bet:      vor jeder Frage (nur Kategorie sichtbar) wird ein Einsatz gesetzt; richtig +Einsatz, falsch −Einsatz; letzte Frage doppelt.
//  - blitz:    feste Spielzeit (45/60/90 s), jeder arbeitet dieselbe Fragenliste im eigenen Tempo ab; richtig = 1 Punkt, falsch = 2 s Pause.
//  - estimate: Schätzrunde: alle tippen eine Zahl (Jahr, Länge, Anzahl …); der nächste Tipp bekommt 1000/700/500 Punkte, weitere Tipps anteilig (scoreGuesses in estimates.ts).
//  - show:     Quizshow mit Publikum: ein Kandidat (Schnellster Finger) steigt die Millionen-Leiter hoch, alle anderen sind das Publikum (Publikumsjoker, 50:50).
import { PRIZES, SAFE_STEPS, difficultyOf, guaranteed, limitMs, prizeAt, shuffle } from './ladder.ts'
import { config } from './config.ts'

export const MODES = ['tempo', 'survival', 'race', 'bet', 'show', 'blitz', 'estimate'] as const
export type Mode = (typeof MODES)[number]
/** Teams gibt es dort, wo Punkte addierbar sind. */
export const TEAM_MODES: readonly Mode[] = ['tempo', 'bet', 'blitz', 'estimate']
export const TEAM_COUNTS = [0, 2, 3, 4] as const

export const RACE_LENGTH = 12
export const BET_START = 1000
export const BET_CHOICES = [100, 300, 500] as const
export const BET_ALL_IN = -1
export const BET_DEFAULT = 100

const TEMPO_DIFFS = [1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3]
const RACE_DIFFS = [1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3]
const BET_DIFFS = [1, 1, 2, 2, 2, 3, 3, 3]
const BLITZ_DIFFS = [1, 1, 1, 2, 2, 2, 3]
export const BLITZ_QUESTIONS = 60
export const BLITZ_DURATIONS = [45, 60, 90] as const // Sekunden
export const BLITZ_DEFAULT_S = 60

/** Schwierigkeit je Frage (aufsteigend); die Länge ist die Fragenzahl. */
export function planDiffs(mode: Mode): number[] {
  if (mode === 'survival') return PRIZES.map((_, i) => difficultyOf(i + 1))
  if (mode === 'race') return RACE_DIFFS.slice(0, Math.max(1, config.live.raceQuestions))
  if (mode === 'blitz') return shuffle(Array.from({ length: BLITZ_QUESTIONS }, (_, i) => BLITZ_DIFFS[i % BLITZ_DIFFS.length]))
  if (mode === 'show' || mode === 'estimate') return [] // show: Fragen einzeln nachgezogen; estimate: eigener Bestand
  if (mode === 'bet') return BET_DIFFS.slice(-Math.max(1, config.live.betQuestions))
  return shuffle(TEMPO_DIFFS).slice(0, config.live.tempoQuestions).sort()
}

export const hasBetPhase = (mode: Mode) => mode === 'bet'
export const isFinalQuestion = (idx: number, total: number) => idx === total - 1

/** Richtig/falsch beim Einsatz: Der Einsatz kann nie unter 0 drücken; wer pleite ist, darf trotzdem 100 riskieren (gewinnt voll, verliert nichts). */
export function betDelta(amount: number, score: number, correct: boolean, final: boolean): number {
  const base = amount === BET_ALL_IN ? Math.max(score, BET_DEFAULT) : amount
  const stake = base * (final ? 2 : 1)
  return correct ? stake : -Math.min(stake, score)
}
export const validBet = (amount: unknown): amount is number => amount === BET_ALL_IN || (BET_CHOICES as readonly number[]).includes(amount as number)

/** Tempo-Punkte: 1000 bei sofortiger Antwort, 500 beim letzten Moment. */
export const tempoPoints = (ms: number, limitMs: number) => Math.round(1000 * (1 - 0.5 * Math.min(1, ms / limitMs)))

/** Rennen: Felder für diese Frage (richtig = 1, schnellste richtige = +1). */
export const raceFields = (correct: boolean, fastest: boolean) => (correct ? 1 + (fastest ? 1 : 0) : 0)

/** Teams: Durchschnitt je Mitglied (fair bei ungleich großen Gruppen). Gibt je Team Rang, Mitgliederzahl und Wertung zurück. */
export function teamStandings(members: { team: number; value: number }[], teams: number): { team: number; members: number; value: number; rank: number }[] {
  const rows = Array.from({ length: teams }, (_, i) => {
    const m = members.filter((x) => x.team === i + 1)
    return { team: i + 1, members: m.length, value: m.length ? Math.round(m.reduce((a, x) => a + x.value, 0) / m.length) : 0, rank: 0 }
  })
  const sorted = [...rows].sort((a, b) => b.value - a.value || b.members - a.members || a.team - b.team)
  sorted.forEach((r, i) => { r.rank = i > 0 && sorted[i - 1].value === r.value ? sorted[i - 1].rank : i + 1 })
  return rows.sort((a, b) => a.rank - b.rank || a.team - b.team)
}

/** Automatisch ausgleichen: Unzugeordnete (team 0) wandern reihum in das jeweils kleinste Team. */
export function balanceTeams(players: { id: number; team: number }[], teams: number): Map<number, number> {
  const size = Array.from({ length: teams }, (_, i) => players.filter((p) => p.team === i + 1).length)
  const out = new Map<number, number>()
  for (const p of shuffle(players.filter((x) => x.team < 1 || x.team > teams))) {
    const t = size.indexOf(Math.min(...size))
    size[t]++; out.set(p.id, t + 1)
  }
  return out
}

/* ---------- Quizshow mit Publikum ---------- */
export const SHOW_STEPS = PRIZES.length
export const SHOW_AUDIENCE_POINTS = 100
export interface ShowState {
  stage: 'qualify' | 'climb'
  candidate: number | null // Spieler-ID des aktuellen Kandidaten
  step: number // aktuelle Leiterstufe (1–15)
  fifty: boolean; audience: boolean // Joker bereits verbraucht
  audienceOn: boolean // Publikumsvoten werden angezeigt (nur zur aktuellen Frage)
  hidden: number[] // per 50:50 ausgeblendete Antwortplätze
  quit: boolean; done: boolean // Kandidat hat ausgestiegen / sein Durchgang ist beendet
  retries: number // Qualifikationsrunden ohne richtige Antwort
  results: { pid: number; prize: number; step: number; how: 'won' | 'lost' | 'quit' }[]
}
export const newShowState = (): ShowState => ({ stage: 'qualify', candidate: null, step: 0, fifty: false, audience: false, audienceOn: false, hidden: [], quit: false, done: false, retries: 0, results: [] })

/** Zeit je Leiterstufe, skaliert mit der eingestellten Fragezeit (20 s Standard = 30/45/60 s wie solo). */
export const showLimitMs = (step: number, questionMs: number) => Math.max(500, Math.round((limitMs(step) * questionMs) / 20_000))

/** Ergebnis der Leiterstufe `step` für den Kandidaten. */
export function showOutcome(step: number, correct: boolean, quit: boolean): { done: boolean; prize: number; how?: 'won' | 'lost' | 'quit' } {
  if (quit) return { done: true, prize: prizeAt(step - 1), how: 'quit' }
  if (!correct) return { done: true, prize: guaranteed(step - 1), how: 'lost' }
  if (step >= SHOW_STEPS) return { done: true, prize: PRIZES[SHOW_STEPS - 1], how: 'won' }
  return { done: false, prize: prizeAt(step) }
}

/** 50:50: zwei falsche Antworten ausblenden (Plätze im gezeigten Fragebild). */
export function fiftyHidden(correctIdx: number): number[] {
  return shuffle([0, 1, 2, 3].filter((i) => i !== correctIdx)).slice(0, 2).sort()
}

/** Publikumsvotum in Prozent (rundet auf 100). */
export function audiencePercent(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0)
  if (!total) return counts.map(() => 0)
  const raw = counts.map((c) => (c / total) * 100), out = raw.map(Math.floor)
  let rest = 100 - out.reduce((a, b) => a + b, 0)
  for (const i of raw.map((r, i) => [r - out[i], i] as const).sort((a, b) => b[0] - a[0]).map((x) => x[1])) { if (rest-- <= 0) break; out[i]++ }
  return out
}
export { SAFE_STEPS, difficultyOf as showDifficulty }
