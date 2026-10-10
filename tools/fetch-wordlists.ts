// Lädt Wortlisten aus dem Netz und erzeugt die 5-Buchstaben-Listen für Wordle (data/wordle/<lang>.words.txt und <lang>.solutions.txt).
// Verwendung: npm run fetch:wordlists [-- --out data/wordle]
// Quellen (Lizenzen siehe docs/WORDLE.md): Rateliste en: tabatkins/wordle-list (MIT), Wörterliste de: lorenbrichter/Words (CC0),
// Häufigkeiten: hermitdave/FrequencyWords 2018 (MIT), Vornamen: dominictarr/random-name (MIT). Manuelle Sperren: data/wordle/blocklist.<lang>.txt.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORDLE_LANGS, buildWordlist, type WordleLang } from '../server/wordle-words.ts'

const RAW = 'https://raw.githubusercontent.com/'
export const SOURCES = {
  big: { en: RAW + 'tabatkins/wordle-list/main/words', de: RAW + 'lorenbrichter/Words/master/Words/de.txt' },
  freq: { en: RAW + 'hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt', de: RAW + 'hermitdave/FrequencyWords/master/content/2018/de/de_50k.txt' },
  names: RAW + 'dominictarr/random-name/master/first-names.txt',
} as const

const lines = (text: string) => text.split(/\r?\n/).filter(Boolean)
/** Häufigkeitslisten haben „wort anzahl“ je Zeile. */
export const freqWords = (text: string) => lines(text).map((l) => l.split(/\s+/)[0])

async function get(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.text()
}

export async function run(outDir: string, log: (m: string) => void = console.log) {
  fs.mkdirSync(outDir, { recursive: true })
  const names = lines(await get(SOURCES.names))
  const texts: Record<string, { big: string; freq: string }> = {}
  for (const lang of WORDLE_LANGS) texts[lang] = { big: await get(SOURCES.big[lang]), freq: await get(SOURCES.freq[lang]) }
  for (const lang of WORDLE_LANGS) {
    const block = path.join(outDir, `blocklist.${lang}.txt`)
    const en = lang === 'de' ? lines(texts.en.big) : []
    const r = buildWordlist({
      lang: lang as WordleLang, big: lines(texts[lang].big), freq: freqWords(texts[lang].freq), names, foreign: en,
      blocklist: fs.existsSync(block) ? lines(fs.readFileSync(block, 'utf8')) : [],
    })
    fs.writeFileSync(path.join(outDir, `${lang}.words.txt`), r.words.join('\n') + '\n')
    fs.writeFileSync(path.join(outDir, `${lang}.solutions.txt`), r.solutions.join('\n') + '\n')
    log(`${lang}: ${r.words.length} gültige Wörter, ${r.solutions.length} Lösungen`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf('--out')
  run(path.resolve(i >= 0 ? process.argv[i + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'wordle'))).catch((e) => { console.error(e.message); process.exit(1) })
}
