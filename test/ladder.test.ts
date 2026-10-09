import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { boot, get, run, importBatch } from './helpers.ts'

const t = await boot()
test.after(() => t.close())
const { call, newPlayer } = t
for (const f of ['original-001', 'original-002']) {
  const r = importBatch(JSON.parse(fs.readFileSync(new URL(`../batches/${f}.json`, import.meta.url), 'utf8')))
  assert.deepEqual(r.errors, [])
}
const { PRIZES, guaranteed, difficultyOf, limitMs } = await import('../server/ladder.ts')

const correctIdx = (ladderId: number, step: number) =>
  (JSON.parse(get<{ perm: string }>('SELECT perm FROM ladder_steps WHERE ladder_id=? AND step=?', ladderId, step)!.perm) as number[]).indexOf(0)

async function start(token: string) {
  const r = await call('POST', '/api/ladders', { lang: 'de' }, token)
  assert.equal(r.status, 200)
  return r.json.id as number
}
/** Beantwortet die nächste Frage richtig (ok) oder falsch. */
async function play(token: string, id: number, step: number, ok: boolean) {
  const q = await call('GET', `/api/ladders/${id}/question`, undefined, token)
  assert.equal(q.status, 200, JSON.stringify(q.json))
  assert.equal(q.json.step, step)
  assert.ok(!('correct' in q.json) && !('correct_index' in q.json), 'richtige Antwort wird nicht verraten')
  const right = correctIdx(id, step)
  return call('POST', `/api/ladders/${id}/answer`, { step, choice: ok ? right : (right + 1) % 4 }, token)
}

test('Regeln: Betragsleiter, Sicherheitsstufen, Schwierigkeit und Zeit je Frage', () => {
  assert.equal(PRIZES.length, 15); assert.equal(PRIZES[14], 1_000_000)
  assert.deepEqual([0, 4, 5, 9, 10, 14].map(guaranteed), [0, 0, 1_000, 1_000, 32_000, 32_000])
  assert.deepEqual([1, 5, 6, 10, 11, 15].map(difficultyOf), [1, 1, 2, 2, 3, 3])
  assert.ok(limitMs(1) < limitMs(6) && limitMs(6) < limitMs(11))
})

test('Alle 15 Fragen richtig: Gewinn, Bestleistung wird gemerkt', async () => {
  const p = await newPlayer('Gewinner')
  const id = await start(p.token)
  assert.equal((await call('POST', '/api/ladders', { lang: 'de' }, p.token)).json.id, id, 'laufende Leiter wird fortgesetzt')
  let last: any
  for (let s = 1; s <= 15; s++) {
    last = await play(p.token, id, s, true)
    assert.equal(last.status, 200); assert.equal(last.json.correct, true)
    assert.equal(last.json.ladder.answered, s)
  }
  assert.equal(last.json.ladder.status, 'won'); assert.equal(last.json.ladder.prize, 1_000_000)
  assert.equal((await call('GET', '/api/me', undefined, p.token)).json.player.best_ladder, 1_000_000)
  assert.equal((await call('GET', `/api/ladders/${id}/question`, undefined, p.token)).status, 409, 'beendet')
  const groups = new Set(Array.from({ length: 15 }, (_, i) => get<{ g: string }>('SELECT q.group_id g FROM ladder_steps s JOIN questions q ON q.id=s.question_id WHERE s.ladder_id=? AND s.step=?', id, i + 1)!.g))
  assert.equal(groups.size, 15, 'keine Frage doppelt')
})

test('Falsche Antwort: Fall auf die letzte Sicherheitsstufe', async () => {
  const p = await newPlayer('Verlierer')
  const id = await start(p.token)
  for (let s = 1; s <= 6; s++) assert.equal((await play(p.token, id, s, true)).json.correct, true)
  const r = await play(p.token, id, 7, false)
  assert.equal(r.json.correct, false)
  assert.equal(r.json.ladder.status, 'lost'); assert.equal(r.json.ladder.prize, 1_000)
  const p2 = await newPlayer('Frühfehler'); const id2 = await start(p2.token)
  assert.equal((await play(p2.token, id2, 1, true)).json.ladder.answered, 1)
  assert.equal((await play(p2.token, id2, 2, false)).json.ladder.prize, 0)
})

test('Aussteigen sichert den Betrag der letzten richtigen Antwort', async () => {
  const p = await newPlayer('Vorsichtig')
  const id = await start(p.token)
  for (let s = 1; s <= 4; s++) await play(p.token, id, s, true)
  const v = (await call('GET', `/api/ladders/${id}`, undefined, p.token)).json.ladder
  assert.equal(v.banked, 500); assert.equal(v.guaranteed, 0); assert.equal(v.current, 5)
  const q = await call('POST', `/api/ladders/${id}/quit`, {}, p.token)
  assert.equal(q.json.ladder.status, 'quit'); assert.equal(q.json.ladder.prize, 500)
  assert.equal((await call('POST', `/api/ladders/${id}/quit`, {}, p.token)).status, 409)
  assert.equal((await call('POST', `/api/ladders/${id}/answer`, { step: 5, choice: 0 }, p.token)).status, 409)
})

test('Schutz: falscher Schritt, nicht ausgelieferte Frage, fremde Leiter, Zeitüberschreitung', async () => {
  const p = await newPlayer('Regelhüter'), o = await newPlayer('Fremder')
  const id = await start(p.token)
  assert.equal((await call('POST', `/api/ladders/${id}/answer`, { step: 1, choice: 0 }, p.token)).status, 409, 'noch nicht ausgeliefert')
  await call('GET', `/api/ladders/${id}/question`, undefined, p.token)
  assert.equal((await call('POST', `/api/ladders/${id}/answer`, { step: 2, choice: 0 }, p.token)).status, 409, 'falscher Schritt')
  assert.equal((await call('POST', `/api/ladders/${id}/answer`, { step: 1, choice: 7 }, p.token)).status, 400)
  assert.equal((await call('GET', `/api/ladders/${id}`, undefined, o.token)).status, 404)
  assert.equal((await call('POST', `/api/ladders/${id}/quit`, {}, o.token)).status, 404)
  run('UPDATE ladder_steps SET served_at=served_at-1000000 WHERE ladder_id=?', id)
  assert.equal((await call('GET', `/api/ladders/${id}/question`, undefined, p.token)).status, 409, 'Zeit abgelaufen')
  const v = (await call('GET', `/api/ladders/${id}`, undefined, p.token)).json.ladder
  assert.equal(v.status, 'lost'); assert.equal(v.prize, 0)
})

test('Meldung nur für beantwortete Schritte; Reviewer können Fragen markieren', async () => {
  const p = await newPlayer('Melder')
  const id = await start(p.token)
  await call('GET', `/api/ladders/${id}/question`, undefined, p.token)
  assert.equal((await call('POST', `/api/ladders/${id}/report`, { step: 1 }, p.token)).status, 400, 'noch nicht beantwortet')
  await call('POST', `/api/ladders/${id}/answer`, { step: 1, choice: correctIdx(id, 1) }, p.token)
  assert.equal((await call('POST', `/api/ladders/${id}/report`, { step: 1 }, p.token)).status, 200)
  assert.equal((await call('POST', `/api/ladders/${id}/review`, { step: 1, part: 'question', kind: 'wording' }, p.token)).status, 403)
  run('UPDATE players SET reviewer=1 WHERE public_id=?', p.player.public_id)
  assert.equal((await call('POST', `/api/ladders/${id}/review`, { step: 1, part: 'question', kind: 'wording' }, p.token)).status, 200)
})

test('Die Leiter nutzt nur Kategorien des gewählten Levels', async () => {
  const p = await newPlayer('Basislerner')
  const id = await start(p.token)
  for (let s = 1; s <= 4; s++) {
    const q = await call('GET', `/api/ladders/${id}/question`, undefined, p.token)
    assert.ok(!/^expert_|^(scifi_fantasy|coding|anime|retro_games)$/.test(q.json.category))
    await call('POST', `/api/ladders/${id}/answer`, { step: s, choice: correctIdx(id, s) }, p.token)
  }
})
