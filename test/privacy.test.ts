import test from 'node:test'
import assert from 'node:assert/strict'
import { boot, get, all, run } from './helpers.ts'

const t = await boot()
test.after(() => { config.requireConsent = false; t.close() })
const { call } = t
const { config } = await import('../server/config.ts')
const { buildPrivacy } = await import('../server/privacy.ts')
const { sweepProfiles } = await import('../server/erase.ts')
const adm = { 'x-admin-token': 'test-admin-token' }
config.requireConsent = true

const privacy = async () => (await call('GET', '/api/privacy')).json
async function signUp(name: string, consent?: unknown) {
  const r = await call('POST', '/api/players', { name, lang: 'de', consent })
  return r
}

test('Verantwortlicher kommt aus der Konfiguration; Version ändert sich mit dem Text', async () => {
  const before = await privacy()
  assert.deepEqual(before.missing, ['CONTROLLER_NAME', 'CONTROLLER_ADDRESS', 'CONTROLLER_EMAIL'])
  assert.match(JSON.stringify(before.de), /nicht konfiguriert: CONTROLLER_NAME/)
  Object.assign(config.privacy, { controllerName: 'Muster GmbH', controllerAddress: 'Musterstr. 1, 12345 Musterstadt', controllerEmail: 'datenschutz@example.org' })
  const after = await privacy()
  assert.deepEqual(after.missing, [])
  assert.match(JSON.stringify(after.de), /Muster GmbH/); assert.match(JSON.stringify(after.en), /datenschutz@example.org/)
  assert.notEqual(after.version, before.version, 'neuer Text = neue Version')
  assert.equal(buildPrivacy().version, after.version, 'deterministisch')
  assert.match(after.version, /^[0-9a-f]{64}$/)
  assert.equal(after.de.summary.length, 3)
  // KI-Hinweis hängt an der Funktion
  const noAi = JSON.stringify(after.de)
  config.ai.key = 'x'
  assert.notEqual((await privacy()).version, after.version); assert.match(JSON.stringify((await privacy()).de), /keine Daten von Spielerinnen/)
  config.ai.key = ''
  assert.equal((await privacy()).version, after.version); assert.ok(noAi.includes('Es werden keine Daten an KI-Dienste'))
})

test('Profil nur mit Zustimmung zur aktuellen Version und Altersbestätigung; Nachweis wird gespeichert', async () => {
  const v = (await privacy()).version
  assert.equal((await signUp('Ohne Zustimmung')).status, 409, 'ohne Angabe')
  assert.equal((await signUp('Alte Version', { version: 'abc', age_ok: true })).status, 409)
  assert.equal((await signUp('Zu jung', { version: v, age_ok: false })).status, 400)
  const ok = await signUp('Zustimmer', { version: v, age_ok: true })
  assert.equal(ok.status, 200)
  const row = get<{ version: string; age_ok: number; accepted_at: number; lang: string }>('SELECT * FROM consents ORDER BY id DESC LIMIT 1')!
  assert.equal(row.version, v); assert.equal(row.age_ok, 1); assert.ok(Math.abs(row.accepted_at - Date.now()) < 5000); assert.equal(row.lang, 'de')
  const snap = JSON.parse(get<{ text_json: string }>('SELECT text_json FROM privacy_versions WHERE version=?', v)!.text_json)
  assert.equal(snap.de.title, 'Impressum & Datenschutz', 'Wortlaut der zugestimmten Fassung archiviert')
  const me = (await call('GET', '/api/me', undefined, ok.json.token)).json
  assert.equal(me.consent.accepted, v); assert.equal(me.consent.current, v)
  assert.equal((await call('GET', '/api/games', undefined, ok.json.token)).status, 200, 'danach nie wieder gefragt')
})

test('Geänderte Erklärung: einmal erneut zustimmen, bis dahin gesperrt (außer Whitelist)', async () => {
  const v1 = (await privacy()).version
  const p = (await signUp('Dauergast', { version: v1, age_ok: true })).json
  config.privacy.hosting = 'Neuer Hoster AG' // Textänderung
  const v2 = (await privacy()).version
  assert.notEqual(v1, v2)
  const blocked = await call('GET', '/api/games', undefined, p.token)
  assert.equal(blocked.status, 403); assert.equal(blocked.json.error, 'consent_required')
  assert.equal((await call('POST', '/api/games', { opponent: 'bot', lang: 'de' }, p.token)).status, 403)
  const me = (await call('GET', '/api/me', undefined, p.token)).json
  assert.equal(me.consent.accepted, v1); assert.equal(me.consent.current, v2)
  assert.equal((await call('POST', '/api/consent', { version: v1, age_ok: true }, p.token)).status, 409, 'alte Version zählt nicht')
  assert.equal((await call('POST', '/api/consent', { version: v2, age_ok: false }, p.token)).status, 400)
  assert.equal((await call('POST', '/api/consent', { version: v2, age_ok: true }, p.token)).status, 200)
  assert.equal((await call('GET', '/api/games', undefined, p.token)).status, 200)
  assert.equal(all('SELECT 1 FROM consents WHERE player_id=(SELECT id FROM players WHERE public_id=?)', p.player.public_id).length, 2, 'beide Zustimmungen dokumentiert')
  const stats = (await call('GET', '/api/admin/stats', undefined, undefined, adm)).json
  assert.ok(stats.consents.length >= 2); assert.deepEqual(stats.privacy_missing, [])
})

test('Widerruf = Profil löschen: Zugang und Zustimmungsdokumentation verschwinden', async () => {
  const v = (await privacy()).version
  const p = (await signUp('Widerrufer', { version: v, age_ok: true })).json
  assert.equal((await call('DELETE', '/api/me', undefined, p.token)).status, 200, 'Löschen ist auch ohne gültige Zustimmung erlaubt')
  assert.equal((await call('GET', '/api/me', undefined, p.token)).status, 401)
  assert.equal(all("SELECT 1 FROM consents c JOIN players p ON p.id=c.player_id WHERE p.public_id=?", p.player.public_id).length, 0)
})

test('Speicherbegrenzung: lange inaktive anonyme Profile werden gelöscht, Konten nicht', async () => {
  const v = (await privacy()).version
  const a = (await signUp('Verschollen', { version: v, age_ok: true })).json
  const b = (await signUp('Aktiv', { version: v, age_ok: true })).json
  const old = Date.now() - (config.privacy.retentionDays + 1) * 86_400_000
  run('UPDATE players SET last_seen=?, created_at=? WHERE public_id=?', old, old, a.player.public_id)
  assert.equal(sweepProfiles(), 1)
  assert.equal(get<{ deleted: number }>('SELECT deleted FROM players WHERE public_id=?', a.player.public_id)!.deleted, 1)
  assert.equal(get<{ deleted: number }>('SELECT deleted FROM players WHERE public_id=?', b.player.public_id)!.deleted, 0)
})
