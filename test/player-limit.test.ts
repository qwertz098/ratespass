import test from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './helpers.ts'
const { config } = await import('../server/config.ts')

const t = await boot(false)
test.after(() => t.close())
const create = (xff?: string) => t.call('POST', '/api/players', { name: 'Limit' }, undefined, xff ? { 'x-forwarded-for': xff } : {})

test('Standard: 60 neue Profile pro IP und Stunde, danach 429 – andere IPs sind nicht betroffen', async () => {
  assert.equal(config.playerCreateLimit, 60)
  config.trustProxy = true // je Testclient eine eigene IP über X-Forwarded-For
  for (let i = 0; i < 60; i++) assert.equal((await create('203.0.113.10')).status, 200, `Profil ${i + 1}`)
  const blocked = await create('203.0.113.10')
  assert.equal(blocked.status, 429)
  assert.equal(blocked.json.error, 'rate_limited')
  assert.equal((await create('203.0.113.11')).status, 200, 'andere IP wird nicht mitgesperrt')
})

test('Limit ist über die Konfiguration änderbar (PLAYER_CREATE_LIMIT_PER_HOUR)', async () => {
  const keep = config.playerCreateLimit
  config.playerCreateLimit = 2
  assert.equal((await create('203.0.113.20')).status, 200)
  assert.equal((await create('203.0.113.20')).status, 200)
  assert.equal((await create('203.0.113.20')).status, 429)
  config.playerCreateLimit = keep
})
