import test from 'node:test'
import assert from 'node:assert/strict'
import { boot, get, run, db } from './helpers.ts'

const t = await boot()
test.after(() => t.close())
const { call, newPlayer } = t
const { CATEGORY_TIERS, tierOf } = await import('../server/categories.ts')
const { effectiveFor } = await import('../server/settings.ts')

const idOf = (publicId: string) => get<{ id: number }>('SELECT id FROM players WHERE public_id=?', publicId)!.id

test('Meta nennt Stufen und Level; neue Spieler starten auf Basis', async () => {
  const meta = (await call('GET', '/api/meta')).json
  assert.equal(meta.tiers.anime, 'nerd'); assert.equal(meta.tiers.expert_it, 'expert'); assert.equal(meta.tiers.general, 'basic')
  assert.deepEqual(meta.levels, ['basic', 'nerd', 'expert'])
  const p = await newPlayer('Neuling')
  const me = (await call('GET', '/api/me', undefined, p.token)).json.player
  assert.equal(me.level, 'basic'); assert.deepEqual(me.disabled_cats, [])
})

test('Level und Opt-out werden gespeichert und validiert', async () => {
  const p = await newPlayer('Wähler')
  const set = (body: unknown) => call('PATCH', '/api/me', body, p.token)
  assert.equal((await set({ level: 'meister' })).status, 400)
  assert.equal((await set({ level: 'expert', disabled_cats: ['general'] })).status, 400, 'Basis-Kategorien sind immer an')
  assert.equal((await set({ disabled_cats: ['nope'] })).status, 400)
  const r = await set({ level: 'expert', disabled_cats: ['anime', 'anime'] })
  assert.equal(r.status, 200)
  assert.equal(r.json.player.level, 'expert'); assert.deepEqual(r.json.player.disabled_cats, ['anime'])
  assert.equal((await set({ level: 'nerd' })).json.player.disabled_cats[0], 'anime', 'Level ändern lässt Opt-outs unberührt')
})

test('Im Duell zählt die niedrigste Einstellung: Level = Minimum, Kategorien = Schnitt', async () => {
  const a = await newPlayer('Anna'), b = await newPlayer('Bernd'), c = await newPlayer('Clara')
  await call('PATCH', '/api/me', { level: 'expert', disabled_cats: ['coding'] }, a.token)
  await call('PATCH', '/api/me', { level: 'nerd', disabled_cats: ['anime'] }, b.token)
  const ia = idOf(a.player.public_id), ib = idOf(b.player.public_id), ic = idOf(c.player.public_id)
  const ab = effectiveFor([ia, ib])
  assert.equal(ab.level, 'nerd')
  assert.ok(ab.cats.includes('scifi_fantasy') && ab.cats.includes('retro_games') && ab.cats.includes('general'))
  assert.ok(!ab.cats.includes('coding') && !ab.cats.includes('anime'), 'abgewählte Extras entfallen für beide')
  assert.ok(!ab.cats.some((x) => tierOf(x) === 'expert'), 'Experten-Kategorien nur, wenn beide Experte')
  const ac = effectiveFor([ia, ic])
  assert.equal(ac.level, 'basic')
  assert.ok(ac.cats.every((x) => tierOf(x) === 'basic'))
  assert.deepEqual(effectiveFor([ia, null]).level, 'expert', 'wartendes Spiel: nur der Ersteller')
})

test('Spiele merken die wirksame Auswahl; Bot übernimmt die Einstellung des Menschen', async () => {
  const p = await newPlayer('Nerdy')
  await call('PATCH', '/api/me', { level: 'nerd' }, p.token)
  const gid = (await call('POST', '/api/games', { opponent: 'bot', lang: 'de' }, p.token)).json.id
  const row = get<{ level: string; cats: string }>('SELECT level, cats FROM games WHERE id=?', gid)!
  assert.equal(row.level, 'nerd')
  assert.ok((JSON.parse(row.cats) as string[]).includes('anime'))
  await call('PATCH', '/api/me', { level: 'basic' }, p.token) // spätere Änderung wirkt nicht auf laufende Spiele
  assert.equal(get<{ level: string }>('SELECT level FROM games WHERE id=?', gid)!.level, 'nerd')
  assert.equal((await call('GET', `/api/games/${gid}`, undefined, p.token)).json.game.level, 'nerd')
})

test('Zufallsgegner: beim Beitritt gilt das Minimum beider', async () => {
  const a = await newPlayer('Hoch'), b = await newPlayer('Niedrig')
  await call('PATCH', '/api/me', { level: 'expert' }, a.token)
  const gid = (await call('POST', '/api/games', { opponent: 'random', lang: 'de' }, a.token)).json.id
  assert.equal(get<{ level: string }>('SELECT level FROM games WHERE id=?', gid)!.level, 'expert')
  await call('POST', '/api/games', { opponent: 'random', lang: 'de' }, b.token)
  const g = get<{ level: string; cats: string; status: string }>('SELECT level, cats, status FROM games WHERE id=?', gid)!
  assert.equal(g.status, 'active'); assert.equal(g.level, 'basic')
  assert.ok((JSON.parse(g.cats) as string[]).every((x) => tierOf(x) === 'basic'))
})

test('Angebotene Kategorien stammen immer aus der wirksamen Auswahl', async () => {
  const p = await newPlayer('Prüfling')
  const ids: number[] = []
  for (let i = 0; i < 4; i++) {
    const r = await call('POST', '/api/games', { opponent: 'bot', lang: 'de' }, p.token)
    if (r.status !== 200) break
    const g = (await call('GET', `/api/games/${r.json.id}`, undefined, p.token)).json.game
    for (const c of g.options ?? []) assert.equal(CATEGORY_TIERS[c as keyof typeof CATEGORY_TIERS], 'basic')
    ids.push(r.json.id)
  }
  assert.ok(ids.length > 0)
})

test('Migration v4 → v5 übernimmt freigeschaltete Stufen als Level', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const m = new DatabaseSync(':memory:')
  m.exec('CREATE TABLE players(id INTEGER PRIMARY KEY); CREATE TABLE games(id INTEGER PRIMARY KEY); CREATE TABLE unlock_codes(code TEXT); CREATE TABLE unlocks(player_id INTEGER, tier TEXT);')
  m.exec("INSERT INTO players VALUES(1),(2),(3); INSERT INTO unlocks VALUES(1,'nerd'),(2,'expert');")
  const src = (await import('node:fs')).readFileSync(new URL('../server/db.ts', import.meta.url), 'utf8')
  const sql = /const SCHEMA_V5 = `([\s\S]*?)`/.exec(src)![1]
  m.exec(sql)
  assert.deepEqual(m.prepare('SELECT id, level FROM players ORDER BY id').all().map((r: any) => [r.id, r.level]), [[1, 'nerd'], [2, 'expert'], [3, 'basic']])
  assert.equal(m.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('unlocks','unlock_codes')").get()!.n, 0)
})
