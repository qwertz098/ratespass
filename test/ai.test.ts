import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { boot, get, all, run } from './helpers.ts'

const t = await boot()
const { call } = t
const adm = { 'x-admin-token': 'test-admin-token' }
const { config } = await import('../server/config.ts')

/* Fake-Anthropic-API: Antworten je nach System-Prompt */
let mode: 'ok' | 'down' = 'ok'
let verdictOk = [true, false, true, true]
const calls: string[] = []
const fake = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d)).on('end', () => {
    const b = JSON.parse(body)
    calls.push(b.system.slice(0, 20))
    if (mode === 'down') { res.writeHead(500); return res.end('{}') }
    const user = JSON.parse(b.messages[0].content)
    let out: unknown
    if (b.system.includes('Faktenprüfer')) out = user.fragen.map((f: any) => ({ i: f.i, ok: verdictOk[f.i] ?? false, issue: 'zweifelhaft' }))
    else if (b.system.includes('schätzt')) out = user.fragen.map((f: any) => ({ i: f.i, schwierigkeit: f.i % 2 ? 1 : 3, sicherheit: f.i % 2 ? 0.9 : 0.5, kurz: 'Test' }))
    else out = [
      { region: 'global', schwierigkeit_schaetzung: 3, sicherheit: 0.8, de: { text: 'Welcher Planet hat die meisten bekannten Monde (Teststand)?', correct: 'Saturn', wrong: ['Mars', 'Venus', 'Merkur'] }, en: { text: 'Which planet has the most known moons (test)?', correct: 'Saturn', wrong: ['Mars', 'Venus', 'Mercury'] } },
      { region: 'dach', de: { text: 'Welcher Fluss fließt durch die Stadt Passau (Test)?', correct: 'Inn, Donau und Ilz', wrong: ['Rhein', 'Elbe', 'Weser'] } },
      { region: 'global', de: { text: 'Ungültige Frage mit doppelten Antworten?', correct: 'A', wrong: ['A', 'B', 'C'] }, en: { text: 'Invalid question with duplicate answers?', correct: 'A', wrong: ['A', 'B', 'C'] } },
      { region: 'global', de: { text: 'Welche Farbe hat der Himmel bei klarem Wetter am Tag?', correct: 'Blau', wrong: ['Rot', 'Grün', 'Gelb'] }, en: { text: 'What colour is the clear daytime sky?', correct: 'Blue', wrong: ['Red', 'Green', 'Yellow'] } },
    ]
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ content: [{ type: 'text', text: '```json\n' + JSON.stringify(out) + '\n```' }] }))
  })
})
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
test.after(() => { t.close(); fake.close() })

test('Ohne API-Schlüssel ist die KI aus; Endpunkte nur für den Admin', async () => {
  assert.equal((await call('GET', '/api/admin/ai/status')).status, 401)
  const s = (await call('GET', '/api/admin/ai/status', undefined, undefined, adm)).json
  assert.equal(s.enabled, false)
  assert.ok(s.plan.length > 0 && s.total_deficit > 0, 'Plan zeigt Lücken')
  assert.equal((await call('POST', '/api/admin/ai/generate', { category: 'general', difficulty: 2 }, undefined, adm)).status, 503)
  assert.equal((await call('POST', '/api/admin/ai/estimate', {}, undefined, adm)).status, 503)
})

test('Zielverteilung: mehr schwere Fragen einstellen, ungültige Werte abweisen', async () => {
  const set = (b: unknown) => call('POST', '/api/admin/ai/settings', b, undefined, adm)
  assert.equal((await set({ diff: [1, 2], min_per_category: 100 })).status, 400)
  assert.equal((await set({ diff: [0, 0, 0], min_per_category: 100 })).status, 400)
  assert.equal((await set({ diff: [10, 30, 60], min_per_category: 5 })).status, 400)
  const r = (await set({ diff: [10, 30, 60], min_per_category: 150 })).json
  assert.deepEqual(r.target, { diff: [10, 30, 60], min_per_category: 150 })
  const hard = r.plan.filter((g: any) => g.difficulty === 3)
  assert.ok(hard.length > 0 && hard[0].want >= 90, 'schwere Fragen stehen im Soll weit oben')
})

test('Erzeugen: Prüfdurchlauf, Validierung, Moderation (pending), Tageslimit', async () => {
  Object.assign(config.ai, { key: 'test-key', baseUrl: `http://127.0.0.1:${(fake.address() as any).port}`, dailyLimit: 6 })
  const r = await call('POST', '/api/admin/ai/generate', { category: 'general', difficulty: 3, count: 4 }, undefined, adm)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const res = r.json.results[0]
  assert.equal(res.requested, 4); assert.equal(res.created, 2, 'zwei bestehen: Planet und Himmel (falls nicht schon vorhanden)')
  const reasons = res.rejected.map((x: any) => x.reason).join('|')
  assert.match(reasons, /Antworten müssen verschieden sein/); assert.match(reasons, /Prüfung: zweifelhaft/)
  const rows = all<any>("SELECT * FROM questions WHERE source='llm'")
  assert.ok(rows.length >= 3, 'de+en je Gruppe'); assert.ok(rows.every((q) => q.status === 'pending' && q.license === 'CC-BY-SA-4.0'), 'nie direkt im Spiel')
  assert.ok(rows.every((q) => q.category === 'general' && q.difficulty === 3 && q.ai_difficulty !== null))
  assert.deepEqual(calls.slice(-2).map((c) => c.slice(0, 8)), ['Du bist ', 'Du bist '])
  // Tageslimit 6: 4 verbraucht, 2 übrig → nächste Anfrage wird gekürzt, danach 429
  const r2 = await call('POST', '/api/admin/ai/generate', { category: 'science', difficulty: 3, count: 10 }, undefined, adm)
  assert.equal(r2.json.results[0].requested, 2)
  assert.equal((await call('POST', '/api/admin/ai/generate', { category: 'science', difficulty: 3, count: 1 }, undefined, adm)).status, 429)
  assert.equal((await call('GET', '/api/admin/ai/status', undefined, undefined, adm)).json.used_today, 6)
})

test('Gescheiterte KI-Aufrufe liefern einen Fehler statt Datenmüll', async () => {
  config.ai.dailyLimit = 100; mode = 'down'
  assert.equal((await call('POST', '/api/admin/ai/generate', { category: 'music', difficulty: 2 }, undefined, adm)).status, 502)
  mode = 'ok'
  assert.equal((await call('POST', '/api/admin/ai/generate', { category: 'nope', difficulty: 2 }, undefined, adm)).status, 400)
})

test('Schwierigkeit schätzen lassen und mit Sicherheitsgrenze übernehmen', async () => {
  const est = (await call('POST', '/api/admin/ai/estimate', { limit: 10, category: 'geography' }, undefined, adm)).json
  assert.ok(est.rated > 0)
  const rated = all<any>("SELECT group_id, difficulty, ai_difficulty, ai_confidence FROM questions WHERE lang='de' AND category='geography' AND ai_difficulty IS NOT NULL")
  assert.equal(rated.length, est.rated)
  assert.ok(all<any>("SELECT 1 FROM questions WHERE category='geography' AND lang='en' AND ai_difficulty IS NOT NULL").length > 0, 'gilt für die ganze Gruppe')
  const edits0 = all('SELECT 1 FROM edits').length
  const strict = (await call('POST', '/api/admin/ai/apply', { min_confidence: 0.8 }, undefined, adm)).json.changed
  const loose = (await call('POST', '/api/admin/ai/apply', { min_confidence: 0.4 }, undefined, adm)).json.changed
  assert.ok(strict >= 0 && loose >= 0 && strict + loose > 0)
  assert.ok(all('SELECT 1 FROM edits').length > edits0, 'in den Korrekturen protokolliert')
  assert.equal(all<any>("SELECT 1 FROM questions WHERE lang='de' AND status='active' AND ai_difficulty<>difficulty AND ai_confidence>=0.4").length, 0)
})

test('Freigegebene KI-Fragen lassen sich als ai-Batch exportieren; Auto-Lauf respektiert Schalter und Intervall', async () => {
  run("UPDATE questions SET status='active' WHERE source='llm'")
  const res = await call('GET', '/api/admin/community-batch?source=llm', undefined, undefined, adm)
  assert.equal(res.status, 200)
  assert.equal(res.json.batch, 'ai-001'); assert.equal(res.json.source, 'llm')
  assert.ok(res.json.questions.every((q: any) => q.source === 'llm' && q.i18n.de))
  const { autoRun } = await import('../server/ai.ts')
  assert.equal(await autoRun(), null, 'Auto aus')
  await call('POST', '/api/admin/ai/settings', { auto: true }, undefined, adm)
  const before = calls.length
  const out = await autoRun()
  assert.ok(out && out.length > 0 && calls.length > before, 'Auto-Lauf erzeugt')
  assert.equal(await autoRun(), null, 'nicht noch einmal innerhalb des Intervalls')
  assert.ok(out.every((r) => r.requested > 0 && r.requested <= 10), 'je Aufruf höchstens 10 Fragen')
})
