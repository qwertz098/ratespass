// Rendert web/icons/*.svg zu PNG (benötigt Playwright + Chromium; einmalig, Ergebnis wird eingecheckt).
// Verwendung: node tools/make-icons.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
const require = createRequire(import.meta.url)
let pw
try { pw = require('playwright') } catch { pw = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node22/lib/node_modules/playwright') }
const { chromium } = pw
const dir = path.resolve('web/icons')
const jobs = [['icon.svg', 'icon-192.png', 192], ['icon.svg', 'icon-512.png', 512], ['icon-maskable.svg', 'icon-maskable-512.png', 512]]
const browser = await chromium.launch()
for (const [src, out, size] of jobs) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  const svg = fs.readFileSync(path.join(dir, src), 'utf8')
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`)
  await page.screenshot({ path: path.join(dir, out), omitBackground: true })
  await page.close()
}
await browser.close()
