import test from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './helpers.ts'
const { config } = await import('../server/config.ts')
const { adminEnabled, adminStatus, tokenOk, parseCookie, MIN_TOKEN } = await import('../server/admin.ts')

const t = await boot()
test.after(() => t.close())
const { call, base } = t
config.trustProxy = true // damit pro Test eine eigene „Client-IP“ per X-Forwarded-For simuliert werden kann
const TOKEN = config.adminToken
let n = 0
const ip = () => ({ 'x-forwarded-for': `198.51.100.${++n}` })
const login = (token: string, h: Record<string, string> = ip()) => call('POST', '/api/admin/login', { token }, undefined, h)
const cookieOf = (r: { headers: Headers }) => (r.headers.get('set-cookie') ?? '').split(';')[0]

test('ohne Anmeldung: Admin-API gesperrt, die HTML-Seite selbst enthält keine Geheimnisse', async () => {
  for (const path of ['/api/admin/queue', '/api/admin/stats', '/api/admin/me', '/api/admin/community-batch'])
    assert.equal((await call('GET', path, undefined, undefined, ip())).status, 401, path)
  assert.equal((await call('POST', '/api/admin/questions/1', { action: 'approve' }, undefined, ip())).status, 401)
  const html = await (await fetch(base + '/admin')).text()
  assert.ok(html.includes('<form id="login"') && !html.includes(TOKEN))
})

test('Login mit dem Token: falsche Eingaben → 401 ohne Cookie; richtiges Token → Session-Cookie (HttpOnly, SameSite=Strict, Pfad, Laufzeit)', async () => {
  const h = ip()
  for (const bad of ['falsch', '', TOKEN + 'x', TOKEN.toUpperCase(), TOKEN.slice(1)]) {
    const r = await login(bad, h)
    assert.equal(r.status, 401)
    assert.equal(r.headers.get('set-cookie'), null)
  }
  const ok = await login(TOKEN, ip())
  assert.equal(ok.status, 200)
  const sc = ok.headers.get('set-cookie')!
  assert.match(sc, /^rp_admin=[\w-]{40,}/)
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Path=\/api\/admin/); assert.match(sc, new RegExp(`Max-Age=${config.adminSessionMs / 1000}`))
  assert.doesNotMatch(sc, /Secure/, 'über http ohne Proxy-Hinweis kein Secure-Flag')
  assert.ok(!sc.includes(TOKEN), 'das Token selbst steckt nicht im Cookie')
})

test('Secure-Flag nur bei HTTPS laut Proxy (X-Forwarded-Proto, nur mit TRUST_PROXY)', async () => {
  const r = await login(TOKEN, { ...ip(), 'x-forwarded-proto': 'https' })
  assert.match(r.headers.get('set-cookie')!, /; Secure/)
  config.trustProxy = false
  const r2 = await login(TOKEN, { 'x-forwarded-proto': 'https' })
  config.trustProxy = true
  assert.doesNotMatch(r2.headers.get('set-cookie')!, /Secure/, 'ohne TRUST_PROXY wird der Header ignoriert')
})

test('Session-Cookie gewährt Zugriff; Änderungen nur bei passendem Origin (CSRF-Schutz)', async () => {
  const cookie = cookieOf(await login(TOKEN, ip()))
  const h = { cookie, ...ip() }
  assert.equal((await call('GET', '/api/admin/me', undefined, undefined, h)).status, 200)
  assert.equal((await call('GET', '/api/admin/queue', undefined, undefined, h)).status, 200)
  const host = new URL(base).host
  const post = (extra: Record<string, string>) => call('POST', '/api/admin/questions/999999', { action: 'reject' }, undefined, { ...h, ...extra })
  assert.equal((await post({ origin: 'https://evil.example' })).status, 403, 'fremder Origin')
  assert.equal((await post({ origin: 'null' })).status, 403, 'Origin: null (z. B. sandboxed iframe)')
  assert.equal((await post({ 'sec-fetch-site': 'cross-site' })).status, 403, 'ohne Origin, cross-site')
  assert.equal((await post({})).status, 403, 'weder Origin noch Fetch-Metadaten')
  assert.equal((await post({ origin: `http://${host}` })).status, 404, 'gleicher Origin erreicht die Route (Frage existiert nicht)')
  assert.equal((await post({ 'sec-fetch-site': 'same-origin' })).status, 404)
  assert.equal((await call('GET', '/api/admin/me', undefined, undefined, { cookie: cookie + 'x', ...ip() })).status, 401)
  assert.equal((await call('GET', '/api/admin/me', undefined, undefined, { cookie: 'rp_admin=erfunden', ...ip() })).status, 401)
})

test('Abmelden macht das Cookie serverseitig ungültig (auch wenn jemand es kopiert hat)', async () => {
  const cookie = cookieOf(await login(TOKEN, ip()))
  const out = await call('POST', '/api/admin/logout', {}, undefined, { cookie, ...ip() })
  assert.equal(out.status, 200)
  assert.match(out.headers.get('set-cookie')!, /Max-Age=0/)
  assert.equal((await call('GET', '/api/admin/me', undefined, undefined, { cookie, ...ip() })).status, 401)
})

test('Sitzung läuft ab', async () => {
  const keep = config.adminSessionMs
  config.adminSessionMs = 60
  const cookie = cookieOf(await login(TOKEN, ip()))
  assert.equal((await call('GET', '/api/admin/me', undefined, undefined, { cookie, ...ip() })).status, 200)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal((await call('GET', '/api/admin/me', undefined, undefined, { cookie, ...ip() })).status, 401)
  config.adminSessionMs = keep
})

test('Brute-Force: nach 5 Fehlversuchen je IP ist der Login gesperrt – auch mit richtigem Token; andere IPs bleiben nutzbar', async () => {
  const attacker = ip()
  for (let i = 0; i < 5; i++) assert.equal((await login('raten-' + i + '-xxxxxxxxxxxx', attacker)).status, 401)
  const blocked = await login(TOKEN, attacker)
  assert.equal(blocked.status, 429)
  assert.equal(blocked.headers.get('set-cookie'), null)
  assert.equal((await login(TOKEN, ip())).status, 200, 'anderer Client ist nicht betroffen')
})

test('Skript-Zugang per X-Admin-Token: nur mit richtigem Token – und falsche Versuche zählen in dieselbe Sperre', async () => {
  const h = ip()
  assert.equal((await call('GET', '/api/admin/stats', undefined, undefined, { 'x-admin-token': TOKEN, ...ip() })).status, 200)
  for (let i = 0; i < 5; i++) assert.equal((await call('GET', '/api/admin/stats', undefined, undefined, { 'x-admin-token': 'falsch-' + i, ...h })).status, 401)
  assert.equal((await call('GET', '/api/admin/stats', undefined, undefined, { 'x-admin-token': TOKEN, ...h })).status, 429, 'Raten per Header wird genauso gesperrt')
  assert.equal((await login(TOKEN, h)).status, 429, 'und blockiert auch den Login dieser IP')
})

test('Zu kurzes Token schaltet den Admin-Bereich ab (fail-closed), das Startlog sagt es', async () => {
  assert.equal(adminEnabled(), true); assert.equal(adminStatus(), 'an (Token)')
  config.adminToken = 'zu-kurz-1234'
  assert.ok(config.adminToken.length < MIN_TOKEN)
  assert.equal(adminEnabled(), false); assert.match(adminStatus(), /kürzer als 16/)
  assert.equal(tokenOk('zu-kurz-1234'), false, 'auch das (zu kurze) richtige Token wird nicht akzeptiert')
  assert.equal((await login('zu-kurz-1234')).status, 404)
  assert.equal((await call('GET', '/api/admin/stats', undefined, undefined, { 'x-admin-token': 'zu-kurz-1234', ...ip() })).status, 404)
  config.adminToken = ''
  assert.equal(adminStatus(), 'aus')
  config.adminToken = TOKEN
  assert.equal(adminEnabled(), true)
})

test('Cookie-Parser', () => {
  assert.equal(parseCookie('a=1; rp_admin=abc; b=2', 'rp_admin'), 'abc')
  assert.equal(parseCookie('xrp_admin=abc', 'rp_admin'), undefined)
  assert.equal(parseCookie(undefined, 'rp_admin'), undefined)
})
