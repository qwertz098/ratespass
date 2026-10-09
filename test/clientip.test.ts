import test from 'node:test'
import assert from 'node:assert/strict'
process.env.DB_PATH = ':memory:'
const { clientIp } = await import('../server/app.ts')

const req = (xff: string | undefined, socket = '172.18.0.5') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: socket } }) as any
const trust = (hops: number) => ({ trust: true, hops })

test('ohne TRUST_PROXY zählt nur die Socket-Adresse (X-Forwarded-For wird ignoriert)', () => {
  assert.equal(clientIp(req('6.6.6.6'), { trust: false, hops: 1 }), '172.18.0.5')
})

test('ein Proxy (NPM/nginx/Caddy): letzter Eintrag zählt – vom Client mitgeschickte Fälschungen davor werden ignoriert', () => {
  assert.equal(clientIp(req('203.0.113.7'), trust(1)), '203.0.113.7')
  assert.equal(clientIp(req('1.2.3.4, 203.0.113.7'), trust(1)), '203.0.113.7', 'gefälschter erster Eintrag')
  assert.equal(clientIp(req('1.2.3.4, 5.6.7.8, 203.0.113.7'), trust(1)), '203.0.113.7')
})

test('zwei Proxys (Cloudflare → NPM): zweiter Eintrag von rechts ist der Client', () => {
  assert.equal(clientIp(req('203.0.113.7, 172.71.0.1'), trust(2)), '203.0.113.7')
  assert.equal(clientIp(req('evil, 203.0.113.7, 172.71.0.1'), trust(2)), '203.0.113.7')
})

test('Fallbacks: Kette kürzer als erwartet, Header fehlt, IPv4-mapped IPv6, überlange Werte', () => {
  assert.equal(clientIp(req('203.0.113.7'), trust(2)), '172.18.0.5', 'zu kurze Kette -> Socket, nicht raten')
  assert.equal(clientIp(req(undefined), trust(1)), '172.18.0.5')
  assert.equal(clientIp(req('::ffff:203.0.113.9'), trust(1)), '203.0.113.9')
  assert.equal(clientIp(req('x'.repeat(100)), trust(1)), '172.18.0.5')
})
