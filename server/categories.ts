/**
 * Kategorien nach Stufe. Jeder Spieler wählt selbst sein Level (`basic` < `nerd` < `expert`) und kann einzelne Extra-Kategorien
 * (alle außer `basic`) abwählen, siehe server/settings.ts. Im Duell gilt immer die niedrigste Einstellung.
 * Die Stufe gehört zur Kategorie, nicht zur Frage.
 */
export const TIERS = ['basic', 'nerd', 'expert'] as const
export type Tier = (typeof TIERS)[number]
export const CATEGORY_TIERS = {
  general: 'basic', geography: 'basic', history: 'basic', science: 'basic', nature: 'basic', sports: 'basic',
  film_tv: 'basic', music: 'basic', literature: 'basic', art: 'basic', games: 'basic', tech: 'basic',
  scifi_fantasy: 'nerd', coding: 'nerd', anime: 'nerd', retro_games: 'nerd',
  expert_mint: 'expert', expert_humanities: 'expert', expert_arts: 'expert', expert_it: 'expert',
} as const satisfies Record<string, Tier>
export type Category = keyof typeof CATEGORY_TIERS
export const CATEGORIES = Object.keys(CATEGORY_TIERS) as Category[]
export const isTier = (t: unknown): t is Tier => TIERS.includes(t as Tier)
export const tierOf = (c: string): Tier => (CATEGORY_TIERS as Record<string, Tier>)[c] ?? 'basic'
export const tierRank = (t: Tier) => TIERS.indexOf(t)

/** Erlaubte Lizenzen für Fragen (Wert = Lizenztext-URL). */
export const LICENSES: Record<string, string> = {
  'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC-BY-SA-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
}

export const SOURCES = ['opentdb', 'wikidata', 'original', 'community', 'llm'] as const

export const isCategory = (c: unknown): c is Category => CATEGORIES.includes(c as Category)

/**
 * Region einer Frage: `global` = weltweit bekanntes Wissen (für alle Sprachen), `dach` = Wissen, das vor allem im
 * deutschsprachigen Raum geläufig ist (Bundesländer, Bundesliga, deutsche Redewendungen …).
 * REGION_LANGS legt fest, in welchen Sprachen eine regionale Frage ausgespielt wird; `global` geht immer.
 * Englisch bildet damit internationales Wissen ab.
 */
export const REGIONS = ['global', 'dach'] as const
export type Region = (typeof REGIONS)[number]
export const REGION_LANGS: Record<Exclude<Region, 'global'>, readonly string[]> = { dach: ['de'] }
export const isRegion = (r: unknown): r is Region => REGIONS.includes(r as Region)

/** SQL-Bedingung (auf `questions`): Frage darf in ihrer Sprache ausgespielt werden. Nur feste Konstanten, keine Nutzereingaben. */
export const SERVABLE_SQL = '(' + [
  "region='global'",
  ...Object.entries(REGION_LANGS).map(([r, langs]) => `(region='${r}' AND lang IN (${langs.map((l) => `'${l}'`).join(',')}))`),
].join(' OR ') + ')'
