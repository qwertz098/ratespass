import test from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './helpers.ts'
const { config } = await import('../server/config.ts')
const { loginEnabled, adminStatus, credentialsOk, parseCookie } = await import('../server/admin.ts')

const t = await boot()
test.after(() => t.close())
const { call, base } = t
config.trustProxy = true // damit pro Test eine eigene „Client-IP“ per X-Forwarded-For simuliert werden kann
let n = 0
const ip = () => ({ 'x-forwarded-for': `198.51.100.${++n}` })
const login = (u: string, p: string, h: Record<string, string> = ip()) => call('POST', '/api/admin/login', { username: u, password: p }, undefined, h)
const cookieOf = (r: { headers: Headers }) => (r.headers.get('set-cookie') ?? '').split(';')[0]
const GOOD = ['moderator', 'correct horse battery'] as const

test('ohne Anmeldung: Admin-API und Login-Seite sind gesperrt, die HTML-Seite selbst enthält keine Geheimnisse', async () => {
  for (const path of ['/api/admin/queue', '/api/admin/stats', '/api/admin/me', '/api/admin/community-batch'])
    assert.equal((await call('GET', path, undefined, undefined, ip())).status, 401, path)
  assert.equal((await call('POST', '/api/admin/questions/1', { action: 'approve' }, undefined, ip())).status, 401)
  const html = await (await fetch(base + '/admin')).text()
  assert.ok(html.includes('<form id="login"') && !html.includes(config.adminPassword) && !html.includes(config.adminToken))
})

test('Login: falsche Daten → 401 ohne Cookie; richtige → Session-Cookie mit HttpOnly, SameSite=Strict, Pfad, Laufzeit', async () => {
  const h = ip()
  for (const [u, p] of [['moderator', 'falsch-falsch-1234'], ['andere', GOOD[1]], ['', ''], ['moderator', GOOD[1].toUpperCase()]]) {
    const r = await login(u, p, h)
    assert.equal(r.status, 401)
    assert.equal(r.headers.get('set-cookie'), null)
  }
  const ok = await login(...GOOD, ip())
  assert.equal(ok.status, 200)
  const sc = ok.headers.get('set-cookie')!
  assert.match(sc, /^rp_admin=[\w-]{40,}/)
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Path=\/api\/admin/); assert.match(sc, new RegExp(`Max-Age=${config.adminSessionMs / 1000}`))
  assert.doesNotMatch(sc, /Secure/, 'über http ohne Proxy-Hinweis kein Secure-Flag')
  assert.ok(!sc.includes(config.adminPassword), 'Passwort steckt nicht im Cookie')
})

test('Secure-Flag nur bei HTTPS laut Proxy (X-Forwarded-Proto, nur mit TRUST_PROXY)', async () => {
  const r = await login(...GOOD, { ...ip(), 'x-forwarded-proto': 'https' })
  assert.match(r.headers.get('set-cookie')!, /; Secure/)
  config.trustProxy = false
  const r2 = await login(...GOOD, { 'x-forwarded-proto': 'https' })
  config.trustProxy = true
  assert.doesNotMatch(r2.headers.get('set-cookie')!, /Secure/, 'ohne TRUST_PROXY wird der Header ignoriert')
})

test('Session-Cookie gewährt Zugriff; Änderungen nur bei passendem Origin (CSRF-Schutz)', async () => {
  const cookie = cookieOf(await login(...GOOD, ip()))
  const h = { cookie, ...ip() }
  assert.equal((await call('GET', '/api/admin/me', undefined, undefined, h)).json.user, 'moderator')
  assert.equal((await call('GET', '/api/admin/queue', undefined, undefined, h)).status, 200)
  const host = new URL(base).host
  const post = (extra: Record<string, string>) => call('POST', '/api/admin/questions/999999', { action: 'reject' }, undefined, { ...h, ...extra })
  assert.equal((await post({ origin: 'https://evil.example' })).status, 403, 'fremder Origin')
  assert.equal((await post({ origin: 'null' })).status, 403, 'Origin: null (z. B. sandboxed iframe)')
  assert.equal((await post({ 'sec-fetch-site': 'cross-site' })).status, 403, 'ohne Origin, cross-site')
  assert.equal((await post({})).status, 403, 'weder Origin noch Fetch-Metadaten')
  assert.equal((await post({ origin: `http://${host}` })).status, 404, 'gleicher Origin erreicht die Route (Frage existiert nicht)')
  assert.equal((await post({ 'sec-fetch-site': 'same-origin' })).status, 404)
  // Ein beliebiges anderes Cookie / manipuliertes Cookie hilft nicht
  assert.equal((await call('GET', '/api/admin/me', undefined, undefined, { cookie: cookie + 'x', ...ip() })).status, 401)
  assert.equal((await call('GET', '/api/admin/me', undefined, undefined, { cookie: 'rp_admin=erfunden', ...ip() })).status, 401)
})

test('Abmelden macht das Cookie serverseitig ungültig (auch wenn jemand es kopiert hat)', async () => {
  const cookie = cookieOf(await login(...GOOD, ip()))
  const out = await call('POST', '/api/admin/logout', {}, undefined, { cookie, ...ip() })
  assert.equal(out.status, 200)
  assert.match(out.headers.get('set-cookie')!, /Max-Age=0/)
  assert.equal((await call('GET', '/api/admin/me', undefined, undefined, { cookie, ...ip() })).status, 401)
})

test('Sitzung läuft ab', async () => {
  const keep = config.adminSessionMs
  config.adminSessionMs = 60
  const cookie = cookieOf(await login(...GOOD, ip()))
  assert.equal((await call('GET', '/api/admin/me', undefined, undefined, { cookie, ...ip() })).status, 200)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal((await call('GET', '/api/admin/me', undefined, undefined, { cookie, ...ip() })).status, 401)
  config.adminSessionMs = keep
})

test('Brute-Force: nach 5 Fehlversuchen je IP ist der Login gesperrt – auch mit richtigem Passwort; andere IPs bleiben nutzbar', async () => {
  const attacker = ip()
  for (let i = 0; i < 5; i++) assert.equal((await login('moderator', 'raten-' + i + '-xxxxxx', attacker)).status, 401)
  const blocked = await login(...GOOD, attacker)
  assert.equal(blocked.status, 429)
  assert.equal(blocked.headers.get('set-cookie'), null)
  assert.equal((await login(...GOOD, ip())).status, 200, 'anderer Client ist nicht betroffen')
})

test('Skript-Zugang per X-Admin-Token bleibt möglich (und nur mit dem richtigen Token)', async () => {
  assert.equal((await call('GET', '/api/admin/stats', undefined, undefined, { 'x-admin-token': 'test-admin-token', ...ip() })).status, 200)
  assert.equal((await call('GET', '/api/admin/stats', undefined, undefined, { 'x-admin-token': 'falsch', ...ip() })).status, 401)
  const tok = config.adminToken
  config.adminToken = ''
  assert.equal((await call('GET', '/api/admin/stats', undefined, undefined, { 'x-admin-token': 'test-admin-token', ...ip() })).status, 401, 'ohne konfiguriertes Token kein Token-Zugang')
  config.adminToken = tok
})

test('Schwaches oder unvollständiges Passwort schaltet den Login ab (Fail-closed) und das Startlog sagt es', async () => {
  const pw = config.adminPassword, user = config.adminUser
  assert.equal(loginEnabled(), true); assert.match(adminStatus(), /Login an/)
  config.adminPassword = 'kurz1234'
  assert.equal(loginEnabled(), false); assert.match(adminStatus(), /kürzer als 12/)
  assert.equal(credentialsOk(user, 'kurz1234'), false, 'auch das (zu kurze) richtige Passwort wird nicht akzeptiert')
  assert.equal((await login(user, 'kurz1234')).status, 404)
  config.adminPassword = pw; config.adminUser = ''
  assert.equal(loginEnabled(), false); assert.match(adminStatus(), /ADMIN_USER fehlt/)
  config.adminUser = user
  assert.equal(loginEnabled(), true)
})

test('Cookie-Parser', () => {
  assert.equal(parseCookie('a=1; rp_admin=abc; b=2', 'rp_admin'), 'abc')
  assert.equal(parseCookie('xrp_admin=abc', 'rp_admin'), undefined)
  assert.equal(parseCookie(undefined, 'rp_admin'), undefined)
})
