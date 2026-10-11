import test from 'node:test'
import assert from 'node:assert/strict'
import { boot, run, get } from './helpers.ts'

const t = await boot()
const { call, newPlayer } = t
test.after(() => t.close())
const { sweepPool } = await import('../server/pool.ts')
const { messageFor } = await import('../server/push.ts')

const info = async (p: any) => (await call('GET', '/api/pool', undefined, p.token)).json
const join = async (p: any, member = true) => (await call('POST', '/api/pool', { member }, p.token)).json
/** Jeder Test startet mit leerem Pool (Spieler und Spiele der Vorgänger bleiben in der gemeinsamen Test-Datenbank). */
const reset = () => { run('UPDATE players SET pool=0'); run("UPDATE games SET status='abandoned' WHERE pool=1") }
const ask = (p: any) => call('POST', '/api/games', { opponent: 'pool', lang: 'de' }, p.token)

test('Pool: Beitritt/Austritt, Zähler ohne mich, leerer Pool → 409', async () => {
  reset()
  const [a, b, c] = [await newPlayer('Pool Anna'), await newPlayer('Pool Ben'), await newPlayer('Pool Cara')]
  assert.deepEqual(await info(a), { members: 0, member: false, game: null })
  const r = await ask(a); assert.equal(r.status, 409); assert.equal(r.json.error, 'pool_empty')
  assert.equal((await info(a)).member, false, 'ein gescheiterter Versuch macht nicht zum Mitglied')
  await join(b); assert.equal((await info(a)).members, 1, 'Zähler: ein teilnahmefähiges Mitglied')
  await join(c); assert.equal((await info(a)).members, 2)
  assert.equal((await info(b)).members, 1, 'ohne mich selbst')
  await join(c, false); assert.equal((await info(a)).members, 1)
})

test('Pool-Anfrage: Spiel mit zufälligem Mitglied, Anfragende werden Mitglied, nur ein Pool-Spiel je Person', async () => {
  reset()
  const [a, b, c, d] = [await newPlayer('Pool Eins'), await newPlayer('Pool Zwei'), await newPlayer('Pool Drei'), await newPlayer('Pool Vier')]
  await join(b)
  const r = await ask(a); assert.equal(r.status, 200)
  const gid = r.json.id as number
  assert.equal((await info(a)).member, true, 'automatisch Mitglied')
  assert.equal((await info(a)).game, gid); assert.equal((await info(b)).game, gid, 'auch der Angefragte hat ein Pool-Spiel')
  const g = (await call('GET', `/api/games/${gid}`, undefined, a.token)).json.game
  assert.equal(g.opp.public_id, b.player.public_id)
  assert.equal((await ask(a)).json.id, gid, 'zweite Anfrage öffnet das laufende Pool-Spiel')
  assert.equal((await ask(b)).json.id, gid, 'auch der Angefragte bekommt sein Pool-Spiel')
  // Mitglieder in einem Pool-Spiel sind nicht anfragbar
  await join(c); await join(d, true)
  assert.equal((await info(c)).members, 1, 'Cara sieht nur Dana (Anna/Ben sind in einem Pool-Spiel)')
  const rc = await ask(c); assert.equal(rc.status, 200)
  assert.equal((await call('GET', `/api/games/${rc.json.id}`, undefined, c.token)).json.game.opp.public_id, d.player.public_id)
})

test('Pool: Sprache, gelöschte und lange inaktive Mitglieder sind nicht teilnahmefähig', async () => {
  reset()
  const [a, en, gone, idle] = [await newPlayer('Pool Sprache'), await newPlayer('Pool EN'), await newPlayer('Pool Weg'), await newPlayer('Pool Alt')]
  for (const p of [en, gone, idle]) await join(p)
  run("UPDATE players SET lang='en' WHERE public_id=?", en.player.public_id)
  run('UPDATE players SET deleted=1 WHERE public_id=?', gone.player.public_id)
  run('UPDATE players SET last_seen=? WHERE public_id=?', Date.now() - 30 * 86_400_000, idle.player.public_id)
  assert.equal((await info(a)).members, 0)
  assert.equal((await ask(a)).status, 409)
})

test('Pool: ohne ersten Zug des Angefragten verfällt das Spiel nach 30 Minuten, danach ist eine neue Anfrage möglich', async () => {
  reset()
  const [a, b, c] = [await newPlayer('Verfall Anna'), await newPlayer('Verfall Ben'), await newPlayer('Verfall Cara')]
  await join(b)
  const gid = (await ask(a)).json.id as number
  assert.equal(sweepPool(), 0, 'frisch: nichts verfällt')
  // Anfragende hat ihren Zug gemacht → Angefragter ist am Zug; 31 Minuten vergehen
  const row = get<{ p2: number }>('SELECT p2 FROM games WHERE id=?', gid)!
  run('UPDATE games SET turn=?, updated_at=? WHERE id=?', row.p2, Date.now() - 31 * 60_000, gid)
  assert.equal(sweepPool(), 1)
  assert.equal(get<{ status: string }>('SELECT status FROM games WHERE id=?', gid)!.status, 'abandoned')
  assert.equal((await info(a)).game, null)
  await join(c)
  const again = await ask(a); assert.equal(again.status, 200); assert.notEqual(again.json.id, gid)
  // hat der Angefragte schon geantwortet, verfällt nichts mehr
  const g2 = again.json.id as number, p2 = get<{ p2: number }>('SELECT p2 FROM games WHERE id=?', g2)!.p2
  run('INSERT INTO answers(game_id,round,idx,player_id,served_at,choice,correct,ms) VALUES(?,?,?,?,?,?,?,?)', g2, 1, 0, p2, Date.now(), 0, 1, 1000)
  run('UPDATE games SET turn=?, updated_at=? WHERE id=?', p2, Date.now() - 31 * 60_000, g2)
  assert.equal(sweepPool(), 0)
})

test('Pool-Mitteilungen führen zu „Neues Spiel“', () => {
  for (const lang of ['de', 'en']) for (const kind of ['pool_idle', 'pool_expired'] as const) {
    const m = messageFor(lang, kind, 5, 'Ben'); assert.equal(m.url, '/#/new'); assert.match(m.body, /Ben/)
  }
})
