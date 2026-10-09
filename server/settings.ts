// Spielstufe und Extra-Kategorien: jeder Spieler wählt selbst, im Duell zählt die niedrigste Einstellung.
//  - Level: basic < nerd < expert; erlaubt alle Kategorien bis zu dieser Stufe.
//  - Extra-Kategorien (alle außer „basic“) lassen sich einzeln abwählen (`disabled_cats`); Basis-Kategorien sind immer an.
// Für ein Spiel gilt das niedrigste Level aller menschlichen Teilnehmer und der Schnitt ihrer aktiven Kategorien.
import { CATEGORIES, isCategory, isTier, tierOf, tierRank, type Tier } from './categories.ts'
import { get } from './db.ts'
import { HttpError } from './http.ts'

export interface Effective { level: Tier; cats: string[] }

export function cleanSettings(level: unknown, disabled: unknown): { level: Tier; disabled: string[] } {
  if (!isTier(level)) throw new HttpError(400, 'bad_level')
  if (!Array.isArray(disabled) || disabled.length > CATEGORIES.length || !disabled.every((c) => isCategory(c) && tierOf(c) !== 'basic')) throw new HttpError(400, 'bad_category')
  return { level, disabled: [...new Set(disabled as string[])] }
}

const basicCats = () => CATEGORIES.filter((c) => tierOf(c) === 'basic')

/** Wirksame Stufe und Kategorien für die genannten Spieler (Bots zählen nicht; ohne Mensch: nur Basis). */
export function effectiveFor(playerIds: (number | null)[]): Effective {
  const humans = playerIds.filter((id): id is number => !!id)
    .map((id) => get<{ level: Tier; disabled_cats: string; is_bot: number }>('SELECT level, disabled_cats, is_bot FROM players WHERE id=?', id))
    .filter((p): p is { level: Tier; disabled_cats: string; is_bot: number } => !!p && !p.is_bot)
  if (!humans.length) return { level: 'basic', cats: basicCats() }
  const level = humans.map((p) => p.level).reduce((a, b) => (tierRank(b) < tierRank(a) ? b : a))
  const off = new Set(humans.flatMap((p) => JSON.parse(p.disabled_cats) as string[]))
  return { level, cats: CATEGORIES.filter((c) => tierRank(tierOf(c)) <= tierRank(level) && (tierOf(c) === 'basic' || !off.has(c))) }
}
