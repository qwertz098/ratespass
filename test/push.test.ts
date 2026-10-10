import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { createRequire } from 'node:module'
import { boot, get, all, run } from './helpers.ts'

// Unabhängige Referenzimplementierungen (nur devDependencies) als Orakel für unsere eigene Krypto.
const require = createRequire(import.meta.url)
const ece = require('http_ece')
const webpush = require('web-push')
const { encryptPayload, vapidAuthorization, vapidPublicKey, validEndpoint, flushPush, deliver } = await import('../server/push.ts')

/** Ein „Browser“: Empfängerschlüssel + Authsecret, wie sie PushManager.subscribe() liefern würde. */
function fakeBrowser() {
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = crypto.randomBytes(16)
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }
}
const decrypt = (b: ReturnType<typeof fakeBrowser>, body: Buffer) =>
  JSON.parse(ece.decrypt(body, { version: 'aes128gcm', privateKey: b.ecdh, authSecret: b.auth.toString('base64url') }).toString())

test('Verschlüsselung ist RFC-8291-konform: http_ece entschlüsselt unseren Payload', () => {
  const b = fakeBrowser()
  for (const text of ['kurz', JSON.stringify({ title: 'Du bist dran', body: 'Alice hat gespielt 🎉', url: '/#/game/1', tag: 'game-1' }), 'x'.repeat(3000)]) {
    const enc = encryptPayload(b.keys.p256dh, b.keys.auth, Buffer.from(text))
    assert.equal(ece.decrypt(enc, { version: 'aes128gcm', privateKey: b.ecdh, authSecret: b.keys.auth }).toString(), text)
  }
})

test('VAPID-Header: gültiges ES256-JWT, passende Claims, gleiche Form wie web-push', () => {
  const header = vapidAuthorization('https://fcm.googleapis.com')
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)
  assert.ok(m, header)
  const [, h, p, sig, k] = m
  assert.equal(k, vapidPublicKey())
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' })
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
  assert.equal(claims.aud, 'https://fcm.googleapis.com')
  assert.ok(claims.exp > Date.now() / 1000 + 3600 && claims.exp <= Date.now() / 1000 + 24 * 3600, 'exp max. 24 h')
  assert.match(claims.sub, /^(mailto:|https:\/\/)/)
  const pub = Buffer.from(k, 'base64url')
  assert.equal(pub.length, 65)
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' })
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'Signatur gültig')
  // Referenz: web-push erzeugt dieselbe Header-Form
  const keys = webpush.generateVAPIDKeys()
  const ref = webpush.getVapidHeaders('https://fcm.googleapis.com', 'mailto:a@b.de', keys.publicKey, keys.privateKey, 'aes128gcm').Authorization
  assert.match(ref, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
})

test('Endpoint-Prüfung blockiert SSRF und fremde Hosts', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/Qabc', 'https://wns2-par02p.notify.windows.com/w/?token=abc', 'http://127.0.0.1:9999/p'])
    assert.equal(validEndpoint(ok), true, ok)
  for (const bad of ['https://evil.example/push', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.example/x', 'https://fcm.googleapis.com:8443/x',
    'https://user:pw@fcm.googleapis.com/x', 'http://169.254.169.254/latest/meta-data', 'http://localhost.evil.example/x', 'ftp://fcm.googleapis.com/x', 'not a url', '', 42])
    assert.equal(validEndpoint(bad), false, String(bad))
})

/** Fake-Push-Dienst: sammelt Anfragen, antwortet mit konfigurierbarem Status. */
async function fakePushService() {
  const received: { path: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = []
  let status = 201
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { received.push({ path: req.url!, headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(status).end() })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { received, setStatus: (s: number) => (status = s), url: (n: string) => `http://127.0.0.1:${(server.address() as any).port}/push/${n}`, close: () => { server.close(); server.closeAllConnections() } }
}

const t = await boot()
test.after(() => t.close())
const { call, newPlayer } = t

async function subscribe(token: string, svc: Awaited<ReturnType<typeof fakePushService>>, name: string) {
  const b = fakeBrowser()
  const r = await call('POST', '/api/push/subscribe', { endpoint: svc.url(name), keys: b.keys }, token)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  return b
}

test('API: Schlüssel öffentlich, Abo-Validierung, Obergrenze, Wechsel der Identität', async () => {
  const key = (await call('GET', '/api/push/key')).json.key
  assert.equal(key, vapidPublicKey())
  const a = await newPlayer('PA'), b = await newPlayer('PB')
  const svc = await fakePushService()
  const br = fakeBrowser()
  assert.equal((await call('POST', '/api/push/subscribe', { endpoint: svc.url('x'), keys: br.keys })).status, 401)
  assert.equal((await call('POST', '/api/push/subscribe', { endpoint: 'https://evil.example/x', keys: br.keys }, a.token)).json.error, 'bad_subscription')
  assert.equal((await call('POST', '/api/push/subscribe', { endpoint: svc.url('x'), keys: { p256dh: 'AAAA', auth: br.keys.auth } }, a.token)).json.error, 'bad_subscription')
  assert.equal((await call('POST', '/api/push/subscribe', { endpoint: svc.url('x'), keys: br.keys }, a.token)).status, 200)
  // gleicher Endpoint (gleiches Gerät) mit anderer Identität -> wechselt den Besitzer, kein Doppeleintrag
  assert.equal((await call('POST', '/api/push/subscribe', { endpoint: svc.url('x'), keys: br.keys }, b.token)).status, 200)
  assert.equal(all('SELECT 1 FROM push_subs WHERE endpoint=?', svc.url('x')).length, 1)
  assert.equal(get<{ n: number }>('SELECT COUNT(*) n FROM push_subs ps JOIN players p ON p.id=ps.player_id WHERE p.public_id=?', b.player.public_id)!.n, 1)
  // max. 10 Geräte je Spieler
  for (let i = 0; i < 12; i++) await call('POST', '/api/push/subscribe', { endpoint: svc.url('d' + i), keys: fakeBrowser().keys }, a.token)
  assert.equal(get<{ n: number }>('SELECT COUNT(*) n FROM push_subs ps JOIN players p ON p.id=ps.player_id WHERE p.public_id=?', a.player.public_id)!.n, 10)
  // Abmelden entfernt nur das eigene Abo
  assert.equal((await call('POST', '/api/push/unsubscribe', { endpoint: svc.url('x') }, a.token)).status, 200)
  assert.equal(all('SELECT 1 FROM push_subs WHERE endpoint=?', svc.url('x')).length, 1, 'fremdes Abo bleibt')
  svc.close()
})

test('Spielereignisse lösen verschlüsselte Pushes aus (Challenge, Zug, Ende) – in der Sprache des Empfängers', async () => {
  const svc = await fakePushService()
  const a = await newPlayer('Alice'), b = await newPlayer('Bob')
  const brA = await subscribe(a.token, svc, 'alice'), brB = await subscribe(b.token, svc, 'bob')
  await call('PATCH', '/api/me', { lang: 'en' }, b.token)
  await call('POST', '/api/contacts', { public_id: a.player.public_id }, b.token)

  // 1) Alice fordert Bob heraus -> Bob bekommt „challenge“ (englisch)
  const gid = (await call('POST', '/api/games', { opponent: b.player.public_id }, a.token)).json.id
  await flushPush()
  assert.equal(svc.received.length, 1)
  const req = svc.received[0]
  assert.equal(req.path, '/push/bob')
  assert.equal(req.headers['content-encoding'], 'aes128gcm')
  assert.match(String(req.headers.authorization), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/)
  assert.ok(Number(req.headers.ttl) > 0)
  const m1 = decrypt(brB, req.body)
  assert.deepEqual(m1, { title: 'New challenge', body: 'Alice challenges you to a quiz duel.', url: `/#/game/${gid}`, tag: `game-${gid}` })

  // 2) Alice spielt ihre Runde zu Ende -> Bob: „Your turn“
  svc.received.length = 0
  const g = (await call('GET', `/api/games/${gid}`, undefined, a.token)).json.game
  await call('POST', `/api/games/${gid}/pick`, { category: g.options[0] }, a.token)
  for (let i = 0; i < 3; i++) {
    await call('GET', `/api/games/${gid}/question`, undefined, a.token)
    await call('POST', `/api/games/${gid}/answer`, { idx: i, choice: 0 }, a.token)
  }
  await flushPush()
  assert.equal(svc.received.length, 1, 'genau eine Zug-Nachricht, nicht eine pro Frage')
  assert.equal(decrypt(brB, svc.received[0].body).title, 'Your turn')

  // 3) Bob gibt auf -> Alice bekommt „resigned“ (deutsch), Bob (Akteur) nichts
  svc.received.length = 0
  await call('POST', `/api/games/${gid}/resign`, {}, b.token)
  await flushPush()
  assert.equal(svc.received.length, 1)
  assert.equal(svc.received[0].path, '/push/alice')
  assert.deepEqual(decrypt(brA, svc.received[0].body), { title: 'Gegner hat aufgegeben', body: 'Bob hat aufgegeben – du gewinnst!', url: `/#/game/${gid}`, tag: `game-${gid}` })
  svc.close()
})

test('Kein Push bei Bot-Spielen; Zufalls-Match benachrichtigt den Wartenden; Abo-Bereinigung bei 410', async () => {
  const svc = await fakePushService()
  const a = await newPlayer('Wartend'), b = await newPlayer('Neu')
  await subscribe(a.token, svc, 'wait')
  const bot = (await call('POST', '/api/games', { opponent: 'bot' }, a.token)).json.id
  await call('POST', `/api/games/${bot}/resign`, {}, a.token)
  await flushPush()
  assert.equal(svc.received.length, 0, 'Bots/Selbstaktionen erzeugen keine Pushes')

  await call('POST', '/api/games', { opponent: 'random' }, a.token)
  await call('POST', '/api/games', { opponent: 'random' }, b.token)
  await flushPush()
  assert.equal(svc.received.length, 1)

  // Push-Dienst meldet „Gone“ -> Abo wird gelöscht; weitere Ereignisse stellen nichts mehr zu
  svc.setStatus(410)
  const c = await newPlayer('Dritter')
  await call('POST', '/api/contacts', { public_id: a.player.public_id }, c.token)
  await call('POST', '/api/games', { opponent: a.player.public_id }, c.token)
  await flushPush()
  assert.equal(get('SELECT 1 FROM push_subs WHERE endpoint=?', svc.url('wait')), undefined, 'Abo nach 410 entfernt')
  svc.close()
})

test('Test-Route stellt zu; Fehlschläge zählen und entfernen defekte Abos; Löschen des Profils entfernt Abos', async () => {
  const svc = await fakePushService()
  const a = await newPlayer('Tester')
  const br = await subscribe(a.token, svc, 'self')
  const r = await call('POST', '/api/push/test', {}, a.token)
  assert.equal(r.json.sent, 1)
  assert.equal(decrypt(br, svc.received.at(-1)!.body).title, 'Quissel')

  // 5 aufeinanderfolgende Fehlschläge entfernen ein defektes Abo (direkt über deliver, am Rate-Limit der Route vorbei)
  svc.setStatus(500)
  const pid = get<{ id: number }>('SELECT id FROM players WHERE public_id=?', a.player.public_id)!.id
  for (let i = 0; i < 4; i++) await deliver(pid, { title: 't', body: 'b', url: '/', tag: 'x' })
  assert.ok(get('SELECT 1 FROM push_subs WHERE endpoint=?', svc.url('self')), 'nach 4 Fehlschlägen noch vorhanden')
  await deliver(pid, { title: 't', body: 'b', url: '/', tag: 'x' })
  assert.equal(get('SELECT 1 FROM push_subs WHERE endpoint=?', svc.url('self')), undefined, 'nach 5 Fehlschlägen entfernt')
  for (let i = 0; i < 4; i++) await call('POST', '/api/push/test', {}, a.token)
  assert.equal((await call('POST', '/api/push/test', {}, a.token)).status, 429, 'Rate-Limit (5/h)')

  const d = await newPlayer('Weg')
  await subscribe(d.token, svc, 'weg')
  await call('DELETE', '/api/me', undefined, d.token)
  assert.equal(get('SELECT 1 FROM push_subs WHERE endpoint=?', svc.url('weg')), undefined)
  void run
  svc.close()
})
