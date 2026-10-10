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
  for (const r of [app, sw]) { assert.match(r.headers.get('content-type') ?? '', /javascript/); assert.match(r.headers.get('cache-control') ?? '', /no-store/) }
})
