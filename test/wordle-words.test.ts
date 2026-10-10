import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildWordlist, normalizeWord } from '../server/wordle-words.ts'
import { freqWords } from '../tools/fetch-wordlists.ts'

test('Wortfilter: genau 5 Buchstaben a–z; Wörter mit Umlauten oder ß fallen weg (de und en)', () => {
  assert.equal(normalizeWord('de', 'Bauch'), 'bauch'); assert.equal(normalizeWord('de', 'Bäume'), null); assert.equal(normalizeWord('de', 'Straße'), null); assert.equal(normalizeWord('de', 'große'), null); assert.equal(normalizeWord('de', 'schön'), null)
  assert.equal(normalizeWord('de', 'Hund'), null); assert.equal(normalizeWord('de', 'Hunde1'), null); assert.equal(normalizeWord('en', 'bäume'), null)
  assert.equal(normalizeWord('en', ' Apple '), 'apple'); assert.equal(normalizeWord('en', "don't"), null); assert.equal(normalizeWord('en', 'a-bcd'), null)
})

test('buildWordlist: Lösungen = häufige echte Wörter ohne Namen/Fremdwörter/Sperren; gültig = größere Menge', () => {
  const r = buildWordlist({
    lang: 'de',
    big: ['Bäume', 'Bauch', 'Hunde', 'laufe', 'Felix', 'Award', 'Arsch', 'Straße', 'Katze', 'selten', 'Kater'],
    freq: freqWords('laufe 900\nhunde 800\nbäume 700\nbauch 650\nfelix 600\naward 500\narsch 400\nkatze 300\nkater 200\nfoo 1\nzzzzz 1'),
    names: ['Felix'], foreign: ['award'], blocklist: ['# Kommentar', 'kater', '!arsch'],
  })
  assert.deepEqual(r.solutions, ['bauch', 'hunde', 'katze', 'laufe'], 'Umlautwörter (bäume) sind nie dabei')
  assert.ok(r.words.includes('award') && r.words.includes('felix') && r.words.includes('kater') && r.words.includes('zzzzz'), 'als Eingabe weiter gültig')
  assert.ok(!r.words.includes('arsch'), '„!“ sperrt auch als Eingabe')
  assert.ok(!r.words.includes('straße') && !r.words.includes('selten') && !r.words.includes('bäume'))
})

test('Gelieferte Wortlisten im Repo: alle Wörter gültig formatiert, Lösungen ⊂ gültige, ausreichend viele', () => {
  for (const lang of ['de', 'en'] as const) {
    const read = (n: string) => fs.readFileSync(new URL(`../wordlists/${lang}.${n}.txt`, import.meta.url), 'utf8').split('\n').filter(Boolean)
    const words = read('words'), sol = read('solutions'), set = new Set(words)
    assert.ok(words.every((w) => normalizeWord(lang, w) === w), `${lang}: ungültiges Wort`)
    assert.ok(sol.every((w) => set.has(w)), `${lang}: Lösung nicht in der Rateliste`)
    assert.ok(sol.length >= 1000 && words.length >= 5000, `${lang}: zu wenige Wörter (${sol.length}/${words.length})`)
    assert.equal(new Set(words).size, words.length, 'keine Dubletten')
  }
})
