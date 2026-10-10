import test from 'node:test'
import assert from 'node:assert/strict'
import { boot } from './helpers.ts'

const t = await boot()
const { base, call } = t
test.after(() => t.close())

test('Version: eine Quelle (Server), automatisch – /api/meta, /version.js und /sw-version.js nennen dieselbe Nummer, nie zwischengespeichert', async () => {
  const { VERSION } = await import('../server/version.ts')
  assert.match(VERSION, /^\d+\.\d+\.\d+$/)
  assert.equal((await call('GET', '/api/meta')).json.version, VERSION)
  const app = await fetch(`${base}/version.js`), sw = await fetch(`${base}/sw-version.js`)
  assert.equal(await app.text(), `export const VERSION = '${VERSION}'\n`)
  assert.equal(await sw.text(), `self.APP_VERSION = '${VERSION}'\n`)
  assert.equal((await fetch(`${base}/healthz`)).headers.get('x-app-version'), VERSION, 'Header auf jeder Antwort')
  for (const r of [app, sw]) { assert.match(r.headers.get('content-type') ?? '', /javascript/); assert.match(r.headers.get('cache-control') ?? '', /no-store/) }
})

test('Versionsstempel: index.html und JS-Module verweisen auf ?v=<Version>; sw.js und vendor/ bleiben unverändert; /reset liefert die Notausgang-Seite', async () => {
  const { VERSION } = await import('../server/version.ts')
  const index = await (await fetch(`${base}/`)).text()
  assert.match(index, new RegExp(`src="/app\\.js\\?v=${VERSION.replaceAll('.', '\\.')}"`)); assert.match(index, new RegExp(`href="/style\\.css\\?v=${VERSION.replaceAll('.', '\\.')}"`))
  const app = await (await fetch(`${base}/app.js?v=${VERSION}`)).text()
  assert.match(app, new RegExp(`from './i18n\\.js\\?v=${VERSION.replaceAll('.', '\\.')}'`)); assert.match(app, /from '\.\/install\.js\?v=/)
  assert.doesNotMatch(await (await fetch(`${base}/sw.js`)).text(), /\?v=\$\{|from '\.\/[a-z]+\.js\?v=/)
  const lib = await fetch(`${base}/vendor/qrcode.js`); assert.equal(lib.status, 200); assert.doesNotMatch((await lib.text()).slice(0, 4000), /\?v=\d/)
  const etag = (await fetch(`${base}/app.js`)).headers.get('etag'); assert.ok(etag)
  assert.equal((await fetch(`${base}/app.js`, { headers: { 'if-none-match': etag! } })).status, 304)
  const reset = await fetch(`${base}/reset`); assert.equal(reset.status, 200); assert.match(await reset.text(), /reset\.js\?v=/)
})
