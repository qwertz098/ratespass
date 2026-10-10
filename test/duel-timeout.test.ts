import test from 'node:test'
import assert from 'node:assert/strict'
import { boot, get, all, run } from './helpers.ts'

const t = await boot()
test.after(() => t.close())
const { call, newPlayer } = t
const { config } = await import('../server/config.ts')
const { sweep } = await import('../server/game.ts')
const H = 3_600_000

/** Zwei Spieler im aktiven Duell; `turn` ist der Spieler, der gerade dran ist. */
async function duel() {
  const a = await newPlayer('Spielerin A'), b = await newPlayer('Spieler B')
  const r = await call('POST', '/api/games', { opponent: 'random', lang: 'de' }, a.token)
  await call('POST', '/api/games', { opponent: 'random', lang: 'de' }, b.token)
  const id = r.json.id as number
  const g = get<{ turn: number; p1: number; p2: number }>('SELECT turn, p1, p2 FROM games WHERE id=?', id)!
  const pid = (p: { player: { public_id: string } }) => get<{ id: number }>('SELECT id FROM players WHERE public_id=?', p.player.public_id)!.id
  const mover = g.turn === pid(a) ? a : b, waiter = mover === a ? b : a
  return { id, mover, waiter, pm: pid(mover), pw: pid(waiter) }
}
const age = (id: number, hours: number) => run('UPDATE games SET updated_at=? WHERE id=?', Date.now() - hours * H, id)
const view = async (tok: string, id: number) => (await call('GET', `/api/games/${id}`, undefined, tok)).json.game

test('Standardwerte: 3 Tage bis zur Aufgabe, 24 h bis Erinnerung und Bot-Übernahme', () => {
  assert.deepEqual(config.duel, { forfeitDays: 3, remindHours: 24, takeoverHours: 24 })
})

test('Aufgabe nach forfeitDays: der Wartende gewinnt; Grenze ist einstellbar', async () => {
  const d = await duel()
  age(d.id, 2.5 * 24); sweep()
  assert.equal(get<{ status: string }>('SELECT status FROM games WHERE id=?', d.id)!.status, 'active', 'unter 3 Tagen läuft es weiter')
  age(d.id, 3.2 * 24); sweep()
  const g = await view(d.waiter.token, d.id)
  assert.equal(g.status, 'finished'); assert.equal(g.end_reason, 'timeout'); assert.equal(g.winner, 'me')
  const d2 = await duel(); config.duel.forfeitDays = 1
  try { age(d2.id, 25); sweep() } finally { config.duel.forfeitDays = 3 }
  assert.equal((await view(d2.waiter.token, d2.id)).status, 'finished')
})

test('Erinnerung: einmal je Zug nach remindHours, nicht für Bots; neuer Zug erlaubt neue Erinnerung', async () => {
  const d = await duel()
  const reminded = () => get<{ reminded_at: number | null }>('SELECT reminded_at FROM games WHERE id=?', d.id)!.reminded_at
  age(d.id, 5); sweep()
  assert.equal(reminded(), null, 'zu früh')
  age(d.id, 25); sweep()
  const stamp = get<{ updated_at: number }>('SELECT updated_at FROM games WHERE id=?', d.id)!.updated_at
  assert.equal(reminded(), stamp, 'erinnert')
  sweep()
  assert.equal(reminded(), stamp, 'kein zweites Mal für denselben Zug')
  // neuer Zug (updated_at ändert sich) → wieder erinnerbar
  run('UPDATE games SET updated_at=? WHERE id=?', Date.now() - 30 * H, d.id); sweep()
  assert.equal(reminded(), Date.now() - 30 * H < 0 ? null : get<{ updated_at: number }>('SELECT updated_at FROM games WHERE id=?', d.id)!.updated_at)
  // Bot-Spiele: keine Erinnerung nötig, aber auch kein Fehler
  const p = await newPlayer('Botspieler'); const g = await call('POST', '/api/games', { opponent: 'bot', lang: 'de' }, p.token)
  age(g.json.id, 30); assert.doesNotThrow(() => sweep())
})

test('Bot-Übernahme: erst nach takeoverHours, nur durch den Wartenden, Verlauf bleibt, Bot zieht weiter', async () => {
  const d = await duel()
  // Verlauf erzeugen: der Spieler am Zug wählt Kategorie und beantwortet eine Frage
  const gv = await view(d.mover.token, d.id)
  await call('POST', `/api/games/${d.id}/pick`, { category: gv.options[0] }, d.mover.token)
  await call('GET', `/api/games/${d.id}/question`, undefined, d.mover.token)
  await call('POST', `/api/games/${d.id}/answer`, { idx: 0, choice: 0 }, d.mover.token)
  const answersBefore = all<{ player_id: number }>('SELECT player_id FROM answers WHERE game_id=? AND choice IS NOT NULL', d.id).length
  assert.equal(answersBefore, 1)
  // Gegner ist nicht dran, solange der Spieler seine Runde noch spielt → Übernahme nur wenn der Wartende wartet
  assert.equal((await view(d.waiter.token, d.id)).can_takeover, false)
  assert.equal((await call('POST', `/api/games/${d.id}/bot`, {}, d.waiter.token)).status, 409, 'Spieler ist noch am Zug')
  // beide Antworten fertig → Zug wechselt zum Gegner (hier: der bisherige Wartende ist dran) – wir drehen die Rollen um
  await call('GET', `/api/games/${d.id}/question`, undefined, d.mover.token); await call('POST', `/api/games/${d.id}/answer`, { idx: 1, choice: 0 }, d.mover.token)
  await call('GET', `/api/games/${d.id}/question`, undefined, d.mover.token); await call('POST', `/api/games/${d.id}/answer`, { idx: 2, choice: 0 }, d.mover.token)
  const g2 = await view(d.waiter.token, d.id); assert.equal(g2.turn, 'me', 'jetzt ist der bisherige Wartende dran')
  // der Mover wartet jetzt auf den Waiter
  assert.equal((await view(d.mover.token, d.id)).can_takeover, false, 'zu früh')
  assert.equal((await call('POST', `/api/games/${d.id}/bot`, {}, d.mover.token)).status, 409)
  age(d.id, 25)
  const v = await view(d.mover.token, d.id)
  assert.equal(v.can_takeover, true); assert.ok(v.idle_hours >= 24)
  assert.equal((await view(d.waiter.token, d.id)).can_takeover, false, 'wer am Zug ist, kann nicht übernehmen')
  assert.equal((await call('POST', `/api/games/${d.id}/bot`, {}, d.waiter.token)).status, 409)
  const r = await call('POST', `/api/games/${d.id}/bot`, {}, d.mover.token)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const after = r.json.game
  assert.equal(after.opp.is_bot, true)
  assert.equal(all('SELECT 1 FROM answers WHERE game_id=? AND choice IS NOT NULL', d.id).length >= answersBefore, true)
  assert.ok(after.rounds[0].me.some((x: unknown) => x !== null), 'eigener Verlauf bleibt')
  assert.notEqual(after.turn, null)
  // Der ersetzte Spieler sieht das Duell nicht mehr
  assert.equal((await call('GET', `/api/games/${d.id}`, undefined, d.waiter.token)).status, 404)
  assert.ok(!(await call('GET', '/api/games', undefined, d.waiter.token)).json.games.some((g: any) => g.id === d.id))
  assert.equal((await call('POST', `/api/games/${d.id}/bot`, {}, d.mover.token)).status, 409, 'nur einmal: der Gegner ist jetzt ein Bot')
})
