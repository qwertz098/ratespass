import test from 'node:test'
import assert from 'node:assert/strict'
import { db, all, get, importBatch } from './helpers.ts'
import { validateContent, type Batch } from '../server/questions.ts'
import { convertOtdb } from '../tools/fetch-opentdb.ts'
import { buildGeoQuestions } from '../tools/gen-wikidata.ts'

const q = (text: string, c = 'A1', w = ['B1', 'C1', 'D1']) => ({ text, correct: c, wrong: w })
const batch = (qs: Batch['questions'], over: Partial<Batch> = {}): Batch => ({
  format: 'ratespass-batch', version: 1, batch: 't-' + Math.random(), source: 'original', license: 'CC-BY-SA-4.0', questions: qs, ...over,
})

test('validateContent', () => {
  assert.equal(validateContent(q('Eine ganz normale Frage?')), null)
  assert.match(validateContent(q('kurz'))!, /Fragetext/)
  assert.match(validateContent(q('Eine ganz normale Frage?', 'A', ['a', 'B', 'C']))!, /verschieden/)
  assert.match(validateContent({ text: 'Eine ganz normale Frage?', correct: 'A', wrong: ['B', 'C'] })!, /3 falsche/)
  assert.match(validateContent(q('Eine ganz normale Frage?', 'x'.repeat(81)))!, /Antworten/)
})

test('Import: Duplikate, Übersetzung erbt Lizenz, strict-Rollback, Lizenz-Allowlist', () => {
  const before = get<{ n: number }>('SELECT COUNT(*) n FROM questions')!.n
  const e = { category: 'general', difficulty: 1, i18n: { en: q('What is the first question here?') } }
  let r = importBatch(batch([e]))
  assert.equal(r.inserted, 1)
  r = importBatch(batch([e]))
  assert.equal(r.inserted, 0)
  assert.equal(r.duplicates, 1)

  const group = get<{ group_id: string }>("SELECT group_id FROM questions WHERE text='What is the first question here?'")!.group_id
  r = importBatch(batch([{ group, i18n: { de: q('Was ist hier die erste Frage?') } }], { license: 'CC0-1.0' }))
  assert.equal(r.translated, 1, JSON.stringify(r))
  const de = get<{ category: string; license: string; difficulty: number }>("SELECT * FROM questions WHERE lang='de' AND text='Was ist hier die erste Frage?'")!
  assert.deepEqual([de.category, de.license, de.difficulty], ['general', 'CC-BY-SA-4.0', 1])

  // Lizenz nicht erlaubt (z. B. CC BY-NC) -> nichts importiert
  r = importBatch(batch([{ category: 'general', difficulty: 1, i18n: { en: q('A completely different question text?') } }], { license: 'CC-BY-NC-4.0' }))
  assert.ok(r.errors[0].includes('Lizenz nicht erlaubt'))
  // strict: ein fehlerhafter Eintrag verhindert den gesamten Batch
  r = importBatch(batch([
    { category: 'general', difficulty: 1, i18n: { en: q('Valid entry in a broken batch?') } },
    { category: 'nope', difficulty: 1, i18n: { en: q('Entry with a broken category?') } },
  ]))
  assert.equal(r.inserted, 0)
  assert.equal(get('SELECT 1 FROM questions WHERE text=?', 'Valid entry in a broken batch?'), undefined)
  // lenient: gültige werden übernommen
  r = importBatch(batch([
    { category: 'general', difficulty: 1, i18n: { en: q('Valid entry in a lenient batch?') } },
    { category: 'nope', difficulty: 1, i18n: { en: q('Entry with a broken category again?') } },
  ]), { lenient: true })
  assert.equal(r.inserted, 1)
  assert.equal(r.errors.length, 1)
  // dry-run schreibt nichts
  importBatch(batch([{ category: 'general', difficulty: 1, i18n: { en: q('Dry run only question text?') } }]), { dryRun: true })
  assert.equal(get('SELECT 1 FROM questions WHERE text=?', 'Dry run only question text?'), undefined)
  assert.ok(get<{ n: number }>('SELECT COUNT(*) n FROM questions')!.n > before)
})

test('OpenTDB-Konverter (Fixture im dokumentierten Format url3986)', () => {
  const enc = encodeURIComponent
  const out = convertOtdb([
    { category: 'Geography', type: 'multiple', difficulty: 'hard', question: enc('What is the capital of Bhutan?'), correct_answer: enc('Thimphu'), incorrect_answers: ['Paro', 'Punakha', 'Phuntsholing'].map(enc) },
    { category: 'Geography', type: 'boolean', difficulty: 'easy', question: enc('Is the Earth round?'), correct_answer: 'True', incorrect_answers: ['False'] },
    { category: 'Geography', type: 'multiple', difficulty: 'easy', question: enc('Doppelte Antworten sind kaputt?'), correct_answer: 'A', incorrect_answers: ['a', 'B', 'C'] },
  ], 22)
  assert.equal(out.length, 1)
  assert.deepEqual([out[0].category, out[0].difficulty, out[0].i18n.en.wrong.length], ['geography', 3, 3])
  const r = importBatch(batch(out, { source: 'opentdb', attribution: 'Open Trivia DB' }))
  assert.equal(r.errors.length, 0)
})

test('Wikidata-Generator (Fixture im SPARQL-JSON-Format)', () => {
  const names: any[][] = [['Q142', 'Frankreich', 'France', 'Q90', 'Paris', 'Paris', 'Q46', 'Europa', 'Europe', 67e6], ['Q183', 'Deutschland', 'Germany', 'Q64', 'Berlin', 'Berlin', 'Q46', 'Europa', 'Europe', 83e6],
    ['Q38', 'Italien', 'Italy', 'Q220', 'Rom', 'Rome', 'Q46', 'Europa', 'Europe', 59e6], ['Q29', 'Spanien', 'Spain', 'Q2807', 'Madrid', 'Madrid', 'Q46', 'Europa', 'Europe', 47e6],
    ['Q17', 'Japan', 'Japan', 'Q1490', 'Tokio', 'Tokyo', 'Q48', 'Asien', 'Asia', 125e6], ['Q148', 'China', 'China', 'Q956', 'Peking', 'Beijing', 'Q48', 'Asien', 'Asia', 1400e6],
    ['Q881', 'Vietnam', 'Vietnam', 'Q1858', 'Hanoi', 'Hanoi', 'Q48', 'Asien', 'Asia', 98e6], ['Q114', 'Kenia', 'Kenya', 'Q3870', 'Nairobi', 'Nairobi', 'Q15', 'Afrika', 'Africa', 54e6],
    ['Q1028', 'Marokko', 'Morocco', 'Q3551', 'Rabat', 'Rabat', 'Q15', 'Afrika', 'Africa', 37e6], ['Q155', 'Brasilien', 'Brazil', 'Q2844', 'Brasília', 'Brasília', 'Q18', 'Südamerika', 'South America', 214e6],
    ['Q96', 'Mexiko', 'Mexico', 'Q1489', 'Mexiko-Stadt', 'Mexico City', 'Q49', 'Nordamerika', 'North America', 126e6], ['Q408', 'Australien', 'Australia', 'Q3114', 'Canberra', 'Canberra', 'Q538', 'Ozeanien', 'Oceania', 26e6]]
  const b = (v: string) => ({ value: v })
  const rows: any[] = names.map(([id, de, en, cid, cde, cen, kid, kde, ken, pop]) => ({
    country: b('http://www.wikidata.org/entity/' + id), cde: b(de), cen: b(en), cap: b('http://www.wikidata.org/entity/' + cid), capde: b(cde), capen: b(cen),
    cont: b('http://www.wikidata.org/entity/' + kid), contde: b(kde), conten: b(ken), pop: b(String(pop)),
  }))
  // Mehrdeutig (zwei Hauptstädte) muss übersprungen werden
  rows.push({ ...rows[0], cap: b('http://www.wikidata.org/entity/Q999'), capde: b('Lyon'), capen: b('Lyon') })
  const entries = buildGeoQuestions(rows)
  assert.ok(entries.length >= 20)
  assert.equal(entries.filter((e) => e.group?.startsWith('wd:Q142')).length, 0, 'mehrdeutige Hauptstadt wird übersprungen')
  assert.deepEqual(buildGeoQuestions(rows), entries, 'deterministisch')
  const cap = entries.find((e) => e.group === 'wd:Q183:capital')!
  assert.equal(cap.i18n.de.text, 'Was ist die Hauptstadt von Deutschland?')
  assert.equal(cap.i18n.en.correct, 'Berlin')
  assert.ok(!cap.i18n.en.wrong.includes('Berlin'))
  const r = importBatch(batch(entries, { source: 'wikidata', license: 'CC0-1.0', attribution: 'Wikidata' }))
  assert.deepEqual(r.errors, [])
  assert.ok(all('SELECT 1 FROM questions WHERE license=?', 'CC0-1.0').length >= 40)
  void db
})
