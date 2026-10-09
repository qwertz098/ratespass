import test from 'node:test'
import assert from 'node:assert/strict'
import { boot, get, all, run, importBatch } from './helpers.ts'

const t = await boot()
test.after(() => t.close())
const { call, newPlayer } = t
const adm = { 'x-admin-token': 'test-admin-token' }
const exportBatch = (mark: boolean) => call('GET', `/api/admin/community-batch${mark ? '?mark=1' : ''}`, undefined, undefined, adm)
const submit = (token: string, text: string, correct: string) =>
  call('POST', '/api/submissions', { lang: 'de', category: 'science', difficulty: 2, text, correct, wrong: ['Falsch A', 'Falsch B', 'Falsch C'], license_ack: true }, token)
const idOf = (text: string) => get<{ id: number }>('SELECT id FROM questions WHERE text=?', text)!.id

test('Community-Export: nur Freigegebenes, ohne Personenbezug, einmalig, mit Rückweg in die Datenbank', async () => {
  const a = await newPlayer('Beitragender')
  const texts = ['Welches Element hat das Symbol Zz im Test?', 'Welche Zahl ist im Test die Antwort auf alles?', 'Welcher Test-Planet ist dem Stern am nächsten?', 'Welcher Test-Stoff ist hier unfertig?']
  for (const [i, text] of texts.entries()) assert.equal((await submit(a.token, text, 'Richtig ' + i)).status, 200)
  await call('POST', `/api/admin/questions/${idOf(texts[0])}`, { action: 'approve' }, undefined, adm)
  await call('POST', `/api/admin/questions/${idOf(texts[1])}`, { action: 'approve', patch: { correct: 'Korrigiert 42' } }, undefined, adm)
  await call('POST', `/api/admin/questions/${idOf(texts[2])}`, { action: 'reject' }, undefined, adm)   // abgelehnt
  // texts[3] bleibt „pending“

  assert.equal((await call('GET', '/api/admin/community-batch')).status, 401, 'nur mit Admin-Token')

  const dry = await exportBatch(false)
  assert.equal(dry.status, 200)
  assert.match(String(dry.headers.get('content-disposition')), /community-001\.json/)
  const b = dry.json
  assert.deepEqual([b.format, b.batch, b.source, b.license], ['ratespass-batch', 'community-001', 'community', 'CC-BY-SA-4.0'])
  assert.equal(b.questions.length, 2, 'nur freigegebene Fragen, weder pending noch rejected')
  assert.ok(b.questions.every((q: any) => q.source === 'community' && q.license === 'CC-BY-SA-4.0' && q.group.startsWith('c:')))
  assert.equal(b.questions.find((q: any) => q.i18n.de.text === texts[1]).i18n.de.correct, 'Korrigiert 42', 'Admin-Korrekturen sind enthalten')
  assert.ok(!JSON.stringify(b).includes('submitted_by') && !JSON.stringify(b).includes('Beitragender'), 'kein Personenbezug')
  assert.equal(get('SELECT 1 FROM questions WHERE batch=?', 'community-001'), undefined, 'Trockenlauf markiert nichts')

  // Export mit Markierung: einmalig
  const real = await exportBatch(true)
  assert.equal(real.json.batch, 'community-001')
  assert.equal(all('SELECT 1 FROM questions WHERE batch=?', 'community-001').length, 2)
  assert.equal(get<{ inserted: number }>('SELECT inserted FROM batches WHERE name=?', 'community-001')!.inserted, 2)
  assert.equal((await exportBatch(true)).status, 404, 'zweiter Export findet nichts Neues')

  // Neue Freigabe -> nächste Nummer
  await call('POST', `/api/admin/questions/${idOf(texts[3])}`, { action: 'approve' }, undefined, adm)
  assert.equal((await exportBatch(true)).json.batch, 'community-002')

  // Rückweg: Zeilen aus der DB entfernen und die exportierte Datei wieder importieren (wie nach Datenverlust/Neuaufbau)
  run("DELETE FROM questions WHERE source='community'")
  assert.equal(get('SELECT 1 FROM questions WHERE text=?', texts[1]), undefined)
  const r = importBatch(real.json)
  assert.deepEqual(r.errors, [])
  assert.equal(r.inserted, 2)
  const back = get<{ status: string; source: string; license: string; correct: string; submitted_by: number | null }>(
    'SELECT status, source, license, correct, submitted_by FROM questions WHERE text=?', texts[1])!
  assert.deepEqual({ ...back }, { status: 'active', source: 'community', license: 'CC-BY-SA-4.0', correct: 'Korrigiert 42', submitted_by: null })
  assert.equal(importBatch(real.json).duplicates, 2, 'erneuter Import erzeugt keine Dubletten')
})
