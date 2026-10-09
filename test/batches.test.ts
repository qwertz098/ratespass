import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
process.env.DB_PATH = ':memory:'
const { importBatch } = await import('../server/questions.ts')
const { all } = await import('../server/db.ts')
const { CATEGORIES, SERVABLE_SQL } = await import('../server/categories.ts')

const dir = new URL('../batches/', import.meta.url)
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()

test('Alle Batch-Dateien im Repo sind gültig, lizenziert und überschneidungsfrei', () => {
  assert.ok(files.length >= 4)
  const names = new Set<string>()
  for (const f of files) {
    const batch = JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'))
    assert.ok(!names.has(batch.batch), `Batch-Name doppelt: ${batch.batch}`)
    names.add(batch.batch)
    assert.equal(f, `${batch.batch}.json`, 'Dateiname = Batch-Name')
    const r = importBatch(batch)
    assert.deepEqual(r.errors, [], `${f}: ${r.errors.slice(0, 3).join(' | ')}`)
    assert.equal(r.duplicates, 0, `${f} enthält Fragen, die schon in anderen Batches stehen`)
  }
})

test('Bestand: ausspielbare Fragen je Sprache ausreichend, Regionen konsistent, alle Schwierigkeiten vertreten', () => {
  const servable = (lang: string) => `lang='${lang}' AND ${SERVABLE_SQL}`
  const total = (lang: string) => all<{ n: number }>(`SELECT COUNT(*) n FROM questions WHERE ${servable(lang)}`)[0].n
  assert.ok(total('de') >= 500)
  assert.ok(total('en') >= 500, 'Englisch hat genug internationale (globale) Fragen')
  for (const lang of ['de', 'en']) {
    const cat = Object.fromEntries(all<{ category: string; n: number }>(`SELECT category, COUNT(*) n FROM questions WHERE ${servable(lang)} GROUP BY category`).map((r) => [r.category, r.n]))
    for (const c of CATEGORIES) assert.ok((cat[c] ?? 0) >= 40, `${lang}/${c}: nur ${cat[c] ?? 0} ausspielbare Fragen`)
    const diff = all<{ difficulty: number; n: number }>(`SELECT difficulty, COUNT(*) n FROM questions WHERE ${servable(lang)} GROUP BY difficulty`)
    assert.deepEqual(diff.map((d) => d.difficulty).sort(), [1, 2, 3])
    assert.ok(diff.every((d) => d.n / total(lang) > 0.15), `${lang}: Schwierigkeiten unausgewogen ${JSON.stringify(diff.map((d) => ({ ...d })))}`)
  }
  // Globale Fragen gibt es in beiden Sprachen; regionale (dach) mindestens auf Deutsch. Die richtige Antwort steht nie zusätzlich bei den falschen.
  assert.equal(all("SELECT group_id FROM questions WHERE region='global' GROUP BY group_id HAVING COUNT(DISTINCT lang) < 2").length, 0, 'globale Gruppe ohne Übersetzung')
  assert.equal(all("SELECT group_id FROM questions WHERE region<>'global' GROUP BY group_id HAVING SUM(lang='de') = 0").length, 0, 'regionale Gruppe ohne deutsche Fassung')
  assert.equal(all('SELECT group_id FROM questions GROUP BY group_id HAVING COUNT(DISTINCT region) > 1').length, 0, 'Region je Gruppe einheitlich')
  for (const q of all<{ correct: string; wrong: string }>('SELECT correct, wrong FROM questions')) assert.ok(!(JSON.parse(q.wrong) as string[]).includes(q.correct))
})
