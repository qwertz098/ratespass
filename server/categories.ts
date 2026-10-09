export const CATEGORIES = [
  'general', 'geography', 'history', 'science', 'nature', 'sports',
  'film_tv', 'music', 'literature', 'art', 'games', 'tech',
] as const
export type Category = (typeof CATEGORIES)[number]

/** Erlaubte Lizenzen für Fragen (Wert = Lizenztext-URL). */
export const LICENSES: Record<string, string> = {
  'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC-BY-SA-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
}

export const SOURCES = ['opentdb', 'wikidata', 'original', 'community', 'llm'] as const

export const isCategory = (c: unknown): c is Category => CATEGORIES.includes(c as Category)
