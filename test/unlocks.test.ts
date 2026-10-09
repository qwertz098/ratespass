import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { boot, get, importBatch } from './helpers.ts'

const t = await boot()
test.after(() => t.close())
const { call, newPlayer } = t
const adm = { 'x-admin-token': 'test-admin-token' }
for (const f of ['original-014']) {
  const r = importBatch(JSON.parse(fs.readFileSync(new URL(`../batches/${f}.json`, import.meta.url), 'utf8')))
  assert.deepEqual(r.errors, [])
}
const { CATEGORY_TIERS } = await import('../server/categories.ts')

/** Wie oft ein neues Spiel gegen den Bot Nerd-Kategorien zur Auswahl stellt (viele Versuche, aber begrenzte aktive Spiele). */
async function offered(token: string, tries = 6) {
  const seen = new Set<string>()
  for (let i = 0; i < tries; i++) {
    const r = await call('POST', '/api/games', { opponent: 'bot', lang: 'de' }, token)
    if (r.status !== 200) break
    const g = (await call('GET', `/api/games/${r.json.id}`, undefined, token)).json.game
    for (const c of g.options ?? []) seen.add(c)
    await call('POST', `/api/games/${r.json.id}/resign`, {}, token)
  }
  return seen
}

test('Meta nennt die Stufen; Nerd-Kategorien sind erst nach Freischaltung wählbar', async () => {
  const meta = (await call('GET', '/api/meta')).json
  assert.equal(meta.tiers.anime, 'nerd')
  assert.equal(meta.tiers.general, 'basic')
  const p = await newPlayer('Neuling')
  assert.deepEqual((await call('GET', '/api/me', undefined, p.token)).json.player.tiers, ['basic'])
  const before = await offered(p.token)
  assert.ok(before.size > 0)
  for (const c of before) assert.equal(CATEGORY_TIERS[c as keyof typeof CATEGORY_TIERS], 'basic', `${c} ohne Freischaltung angeboten`)
})

test('Codes: Admin erzeugt, Spieler löst ein, Verbrauch und Gültigkeit werden geprüft', async () => {
  assert.equal((await call('POST', '/api/admin/unlock-codes', { tier: 'nerd' })).status, 401, 'ohne Admin')
  assert.equal((await call('POST', '/api/admin/unlock-codes', { tier: 'basic' }, undefined, adm)).status, 400)
  const { code } = (await call('POST', '/api/admin/unlock-codes', { tier: 'nerd', max_uses: 1, note: 'Test' }, undefined, adm)).json
  assert.match(code, /^[A-Z0-9]{8}$/)

  const a = await newPlayer('Nerd-A'), b = await newPlayer('Nerd-B')
  assert.equal((await call('POST', '/api/unlock', { code: 'FALSCH12' }, a.token)).status, 404)
  const ok = await call('POST', '/api/unlock', { code: code.toLowerCase() }, a.token)
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json.tiers, ['basic', 'nerd'])
  assert.equal((await call('POST', '/api/unlock', { code }, a.token)).status, 200, 'schon offen: Code wird nicht erneut verbraucht')
  assert.equal(get<{ uses: number }>('SELECT uses FROM unlock_codes WHERE code=?', code)!.uses, 1)
  assert.equal((await call('POST', '/api/unlock', { code }, b.token)).status, 404, 'aufgebraucht')
  assert.deepEqual((await call('GET', '/api/me', undefined, a.token)).json.player.tiers, ['basic', 'nerd'])

  const exp = (await call('POST', '/api/admin/unlock-codes', { tier: 'nerd', max_uses: 5 }, undefined, adm)).json.code
  const { run } = await import('./helpers.ts')
  run('UPDATE unlock_codes SET expires_at=1 WHERE code=?', exp)
  assert.equal((await call('POST', '/api/unlock', { code: exp }, b.token)).status, 404, 'abgelaufen')

  const list = (await call('GET', '/api/admin/unlock-codes', undefined, undefined, adm)).json.codes
  assert.ok(list.some((c: any) => c.code === code && c.note === 'Test'))
  assert.equal((await call('DELETE', `/api/admin/unlock-codes/${code}`, undefined, undefined, adm)).status, 200)
})

test('Freigeschaltete Spieler bekommen Nerd-Kategorien angeboten (Admin kann direkt freischalten)', async () => {
  const p = await newPlayer('Direkt')
  assert.equal((await call('POST', '/api/admin/unlocks', { public_id: 'NOPE1234', tier: 'nerd' }, undefined, adm)).status, 404)
  assert.equal((await call('POST', '/api/admin/unlocks', { public_id: p.player.public_id, tier: 'x' }, undefined, adm)).status, 400)
  assert.equal((await call('POST', '/api/admin/unlocks', { public_id: p.player.public_id.toLowerCase(), tier: 'nerd' }, undefined, adm)).status, 200)
  const seen = await offered(p.token)
  assert.ok([...seen].some((c) => CATEGORY_TIERS[c as keyof typeof CATEGORY_TIERS] === 'nerd'), 'Nerd-Kategorie wird garantiert mit angeboten: ' + [...seen])
})
