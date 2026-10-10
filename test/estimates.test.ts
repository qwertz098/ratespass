import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { boot, get, all } from './helpers.ts'

const t = await boot()
test.after(() => t.close())
const { importEstimates, importPendingEstimates, pickEstimates, scoreGuesses, estimateError } = await import('../server/estimates.ts')
const file = JSON.parse(fs.readFileSync(new URL('../batches/estimates/estimates-001.json', import.meta.url), 'utf8'))

test('Wertung: nächster Tipp 1000, dann 700/500, Gleichstand teilt den Rang, weit daneben nur Teilpunkte', () => {
  assert.equal(estimateError(90, 100), 0.1); assert.equal(estimateError(1, 0), 1, 'nahe 0 absolut zu 1')
  const s = scoreGuesses([{ pid: 1, value: 100 }, { pid: 2, value: 110 }, { pid: 3, value: 90 }, { pid: 4, value: 150 }, { pid: 5, value: 400 }], 100)
  assert.deepEqual([1, 2, 3, 4, 5].map((p) => [s.get(p)!.rank, s.get(p)!.points]), [[1, 1000], [2, 700], [2, 700], [4, 0], [5, 0]])
  const far = scoreGuesses([{ pid: 1, value: 60 }, { pid: 2, value: 5 }], 100)
  assert.deepEqual([far.get(1)!.points, far.get(2)!.points], [1000, 700], 'Podium zählt, solange der Tipp weniger als 100 % daneben liegt')
  assert.equal(scoreGuesses([{ pid: 1, value: 500 }], 100).get(1)!.points, 0, 'mehr als 100 % daneben: kein Podiumspreis')
  const mid = scoreGuesses([{ pid: 1, value: 100 }, { pid: 2, value: 101 }, { pid: 3, value: 102 }, { pid: 4, value: 120 }], 100)
  assert.equal(mid.get(4)!.points, Math.round(300 * (1 - 2 * 0.2)))
})

test('Import: Datei gültig, Dubletten werden erkannt, Regeln werden geprüft', () => {
  const r = importEstimates(file)
  assert.deepEqual(r.errors, []); assert.ok(r.inserted >= 180, `eingefügt: ${r.inserted}`)
  const again = importEstimates(file); assert.equal(again.inserted, 0); assert.equal(again.duplicates, r.inserted)
  const bad = (patch: any) => importEstimates({ ...file, batch: 'x-' + Math.random(), questions: [{ category: 'history', answer: 1, i18n: { de: { text: 'Wie viele Jahre dauerte etwas?', unit: 'Jahre' }, en: { text: 'How many years did it last?', unit: 'years' } }, ...patch }] })
  assert.match(bad({ category: 'nope' }).errors[0], /Kategorie/)
  assert.match(bad({ answer: 'x' }).errors[0], /Zahl/)
  assert.match(bad({ i18n: { de: { text: 'Wie viele Jahre dauerte etwas?' } } }).errors[0], /englische/)
  assert.match(bad({ region: 'dach' }).errors[0], /nur auf Deutsch/)
  assert.match(bad({ i18n: { de: { text: 'Wie viele Jahre dauerte etwas?', unit: 'x'.repeat(30) }, en: { text: 'How many years did it last?' } } }).errors[0], /Einheit/)
  assert.match(importEstimates({ ...file, license: 'WTFPL' }).errors[0], /Lizenz/)
})

test('Auswahl: je Kategorie begrenzt, ohne ausgeschlossene Gruppen, Sprache getrennt', () => {
  const cats = all<{ category: string }>('SELECT DISTINCT category FROM estimates').map((r) => r.category)
  const picked = pickEstimates('de', cats, 8, [], 1)
  assert.equal(picked.length, 8); assert.equal(new Set(picked.map((p) => p.category)).size, 8); assert.ok(picked.every((p) => p.lang === 'de'))
  const none = pickEstimates('en', cats, 5, picked.map((p) => p.group_id))
  assert.ok(none.every((p) => !picked.some((q) => q.group_id === p.group_id)))
  assert.equal(get<{ n: number }>("SELECT COUNT(*) n FROM estimates WHERE status='active' AND text=''")!.n, 0)
})

test('importPendingEstimates liest ein Verzeichnis nur einmal ein', () => {
  const dir = fs.mkdtempSync(new URL('.', import.meta.url).pathname + '../.tmp-est-')
  try {
    fs.writeFileSync(dir + '/e.json', JSON.stringify({ ...file, batch: 'pending-test', questions: file.questions.slice(0, 2).map((q: any) => ({ ...q, i18n: { de: { ...q.i18n.de, text: q.i18n.de.text + ' (Test)' }, en: { ...q.i18n.en, text: q.i18n.en.text + ' (test)' } } })) }))
    const log: string[] = []
    importPendingEstimates(dir, (m) => log.push(m)); importPendingEstimates(dir, (m) => log.push(m))
    assert.equal(log.length, 1); assert.match(log[0], /\+4 neu/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
