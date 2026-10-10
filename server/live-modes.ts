// Spielmodi des Live-Spielabends: reine Regeln ohne Datenbankzugriff (Fragenplan, Einsätze, Rennstrecke, Teamwertung).
// Der Lebenszyklus (Lobby, Zeitgeber, SSE) liegt in live.ts.
//  - tempo:    feste Zahl Fragen, richtig = 500–1000 Punkte je nach Tempo.
//  - survival: Millionen-Leiter-Schwierigkeit; wer falsch oder gar nicht antwortet, scheidet aus.
//  - race:     jede richtige Antwort = 1 Feld, die schnellste richtige = +1 Bonusfeld; wer 12 Felder erreicht, gewinnt.
//  - bet:      vor jeder Frage (nur Kategorie sichtbar) wird ein Einsatz gesetzt; richtig +Einsatz, falsch −Einsatz; letzte Frage doppelt.
import { PRIZES, difficultyOf, shuffle } from './ladder.ts'
import { config } from './config.ts'

export const MODES = ['tempo', 'survival', 'race', 'bet'] as const
export type Mode = (typeof MODES)[number]
/** Teams gibt es dort, wo Punkte addierbar sind. */
export const TEAM_MODES: readonly Mode[] = ['tempo', 'bet']
export const TEAM_COUNTS = [0, 2, 3, 4] as const

export const RACE_LENGTH = 12
export const BET_START = 1000
export const BET_CHOICES = [100, 300, 500] as const
export const BET_ALL_IN = -1
export const BET_DEFAULT = 100

const TEMPO_DIFFS = [1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3]
const RACE_DIFFS = [1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3]
const BET_DIFFS = [1, 1, 2, 2, 2, 3, 3, 3]

/** Schwierigkeit je Frage (aufsteigend); die Länge ist die Fragenzahl. */
export function planDiffs(mode: Mode): number[] {
  if (mode === 'survival') return PRIZES.map((_, i) => difficultyOf(i + 1))
  if (mode === 'race') return RACE_DIFFS.slice(0, Math.max(1, config.live.raceQuestions))
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
