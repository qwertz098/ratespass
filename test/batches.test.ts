import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
process.env.DB_PATH = ':memory:'
const { importBatch } = await import('../server/questions.ts')
const { all } = await import('../server/db.ts')
const { CATEGORIES } = await import('../server/categories.ts')

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

test('Bestand: jede Sprache gleich groß, jede Kategorie ausreichend gefüllt, alle Schwierigkeiten vertreten', () => {
  const perLang = Object.fromEntries(all<{ lang: string; n: number }>('SELECT lang, COUNT(*) n FROM questions GROUP BY lang').map((r) => [r.lang, r.n]))
  assert.equal(perLang.de, perLang.en, 'de und en haben gleich viele Fragen')
  assert.ok(perLang.de >= 500)
  for (const lang of ['de', 'en']) {
    const cat = Object.fromEntries(all<{ category: string; n: number }>('SELECT category, COUNT(*) n FROM questions WHERE lang=? GROUP BY category', lang).map((r) => [r.category, r.n]))
    for (const c of CATEGORIES) assert.ok((cat[c] ?? 0) >= 40, `${lang}/${c}: nur ${cat[c] ?? 0} Fragen`)
    const diff = all<{ difficulty: number; n: number }>('SELECT difficulty, COUNT(*) n FROM questions WHERE lang=? GROUP BY difficulty', lang)
    assert.deepEqual(diff.map((d) => d.difficulty).sort(), [1, 2, 3])
    assert.ok(diff.every((d) => d.n / perLang[lang] > 0.15), `${lang}: Schwierigkeiten unausgewogen ${JSON.stringify(diff.map((d) => ({ ...d })))}`)
  }
  // Jede Gruppe hat beide Sprachen, und die richtige Antwort steht nie zusätzlich bei den falschen
  assert.equal(all('SELECT group_id FROM questions GROUP BY group_id HAVING COUNT(DISTINCT lang) < 2').length, 0, 'Gruppe ohne Übersetzung')
  for (const q of all<{ correct: string; wrong: string }>('SELECT correct, wrong FROM questions')) assert.ok(!(JSON.parse(q.wrong) as string[]).includes(q.correct))
})
