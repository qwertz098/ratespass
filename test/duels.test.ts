import test from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './helpers.ts'

const t = await boot()
const { call, newPlayer } = t
test.after(() => t.close())

test('Ein laufendes Duell je Gegner; Liste zeigt je Gegner nur das letzte beendete Spiel, ältere im Verlauf', async () => {
  const [a, b, c] = [await newPlayer('Duell Anna'), await newPlayer('Duell Ben'), await newPlayer('Duell Cara')]
  for (const o of [b, c]) await call('POST', '/api/contacts', { public_id: o.player.public_id }, a.token)
  const challenge = async (from: any, to: any) => (await call('POST', '/api/games', { opponent: to.player.public_id, lang: 'de' }, from.token)).json.id as number
  const g1 = await challenge(a, b)
  assert.equal(await challenge(a, b), g1, 'zweite Herausforderung öffnet das laufende Duell')
  assert.equal(await challenge(b, a), g1, 'auch in Gegenrichtung (Ben hat Anna als Kontakt über die Gegenseitigkeit)')
  const gc = await challenge(a, c)
  assert.notEqual(gc, g1, 'anderer Gegner = eigenes Duell')
  const live = (await call('GET', '/api/games', undefined, a.token)).json
  assert.equal(live.games.filter((g: any) => g.status !== 'finished').length, 2); assert.equal(live.history, 0)
  // Duell beenden → Revanche legt ein neues an; Liste zeigt nur das letzte beendete Spiel je Gegner
  const finish = async (id: number, who: any) => assert.equal((await call('POST', `/api/games/${id}/resign`, {}, who.token)).status, 200)
  await finish(g1, b)
  const g2 = await challenge(a, b); assert.notEqual(g2, g1, 'nach dem Ende ist ein neues Duell möglich')
  await finish(g2, b)
  const g3 = await challenge(a, b); await finish(g3, b)
  const r = (await call('GET', '/api/games', undefined, a.token)).json
  const done = r.games.filter((g: any) => g.status === 'finished')
  assert.deepEqual(done.map((g: any) => g.id), [g3], 'nur das letzte beendete Spiel gegen Ben'); assert.equal(r.history, 2, 'zwei ältere im Verlauf')
  const h = (await call('GET', '/api/games/history', undefined, a.token)).json.games
  assert.deepEqual(h.map((g: any) => g.id), [g3, g2, g1])
  assert.deepEqual((await call('GET', '/api/games/history', undefined, c.token)).json.games, [], 'fremde Spiele erscheinen nicht')
})
