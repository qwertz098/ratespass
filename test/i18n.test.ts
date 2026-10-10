import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CATEGORIES } from '../server/categories.ts'

// i18n.js greift auf `document`/`navigator` nur innerhalb von Funktionen zu und lässt sich daher direkt importieren.
// @ts-expect-error -- reines JS-Modul ohne Typdeklarationen
const { dict } = (await import('../web/i18n.js')) as { dict: Record<string, Record<string, string>> }

test('Alle UI-Sprachen haben exakt dieselben Schlüssel', () => {
  const base = Object.keys(dict.de).sort()
  for (const [lang, d] of Object.entries(dict)) {
    assert.deepEqual(Object.keys(d).sort(), base, `Sprache ${lang} weicht ab`)
  }
})

test('Alle im Code verwendeten t()-Schlüssel existieren; Kategorien sind übersetzt', () => {
  const src = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
  const used = new Set([...src.matchAll(/\bt\('([\w.]+)'\s*[,)]/g)].map((m) => m[1]))
  for (const k of used) assert.ok(k in dict.de, `Schlüssel fehlt: ${k}`)
  for (const c of CATEGORIES) assert.ok(`cat.${c}` in dict.de, `Kategorie ohne Übersetzung: ${c}`)
  for (const d of [1, 2, 3]) assert.ok(`contrib.d${d}` in dict.de)
  for (const s of ['pending', 'active', 'rejected', 'disabled']) assert.ok(`status.${s}` in dict.de)
  for (const s of ['opentdb', 'wikidata', 'original', 'community', 'llm']) assert.ok(`src.${s}` in dict.de)
  // Jeder vom Server geworfene Fehlercode, den Nutzer sehen können, braucht einen UI-Text.
  const codes = new Set(fs.readdirSync(new URL('../server/', import.meta.url)).filter((f) => f.endsWith('.ts'))
    .flatMap((f) => [...fs.readFileSync(new URL(`../server/${f}`, import.meta.url), 'utf8').matchAll(/HttpError\(\d+, '(\w+)'/g)].map((m) => m[1])))
  const technical = new Set(['unauthorized', 'not_found', 'method_not_allowed', 'bad_json', 'too_large', 'bad_id', 'bad_opponent', 'bad_lang', 'bad_category', 'bad_difficulty',
    'bad_action', 'bad_answer', 'bad_report', 'not_your_turn', 'wrong_question', 'not_served', 'not_waiting', 'already_over', 'already_has_account', 'license_ack_required', 'nothing_to_export', 'forbidden_origin', 'bad_review', 'bad_region', 'bad_mode', 'privacy_changed', 'lb_banned', 'bad_answer_live', 'invalid_question', 'ai_unavailable', 'ai_failed', 'ai_limit', 'bad_target', 'bad_teams', 'bad_team', 'bad_bet'])
  for (const c of codes) if (!technical.has(c)) assert.ok(`err.${c}` in dict.de, `UI-Text für Fehler fehlt: ${c}`)
})
