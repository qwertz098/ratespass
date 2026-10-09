// Erzeugt Geografie-Fragen (de+en) aus Wikidata (CC0 1.0): Hauptstädte und Kontinente von Staaten.
// Verwendung: npm run gen:wikidata -- [--name wikidata-geo-001] [--out pfad.json]
// Die Logik (buildGeoQuestions) ist eine reine Funktion; die SPARQL-Abfrage ist nur ein dünner Abruf.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Batch, BatchEntry } from '../server/questions.ts'
import { config } from '../server/config.ts'

export const SPARQL = `
SELECT ?country ?cde ?cen ?cap ?capde ?capen ?cont ?contde ?conten ?pop WHERE {
  ?country wdt:P31 wd:Q3624078 .
  FILTER NOT EXISTS { ?country wdt:P576 [] }
  ?country wdt:P36 ?cap . ?country wdt:P30 ?cont .
  VALUES ?cont { wd:Q15 wd:Q48 wd:Q46 wd:Q49 wd:Q18 wd:Q538 }
  OPTIONAL { ?country wdt:P1082 ?pop }
  ?country rdfs:label ?cde . FILTER(LANG(?cde)="de")
  ?country rdfs:label ?cen . FILTER(LANG(?cen)="en")
  ?cap rdfs:label ?capde . FILTER(LANG(?capde)="de")
  ?cap rdfs:label ?capen . FILTER(LANG(?capen)="en")
  ?cont rdfs:label ?contde . FILTER(LANG(?contde)="de")
  ?cont rdfs:label ?conten . FILTER(LANG(?conten)="en")
}`

type Binding = Record<string, { value: string }>
interface Country { id: string; de: string; en: string; capId: string; capDe: string; capEn: string; contDe: string; contEn: string; pop: number }

const qid = (uri: string) => uri.split('/').pop()!

/** Deterministischer Zufall, damit gleiche Eingabe gleiche Batches ergibt. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function buildGeoQuestions(bindings: Binding[]): BatchEntry[] {
  // Nur Staaten mit genau einer Hauptstadt und genau einem Kontinent (keine Mehrdeutigkeit).
  const byCountry = new Map<string, Binding[]>()
  for (const b of bindings) byCountry.set(b.country.value, [...(byCountry.get(b.country.value) ?? []), b])
  const countries: Country[] = []
  for (const rows of byCountry.values()) {
    if (new Set(rows.map((r) => r.cap.value)).size !== 1 || new Set(rows.map((r) => r.cont.value)).size !== 1) continue
    const r = rows[0]
    countries.push({
      id: qid(r.country.value), de: r.cde.value, en: r.cen.value, capId: qid(r.cap.value), capDe: r.capde.value, capEn: r.capen.value,
      contDe: r.contde.value, contEn: r.conten.value, pop: Number(r.pop?.value ?? 0),
    })
  }
  countries.sort((a, b) => b.pop - a.pop || a.id.localeCompare(b.id))
  const rand = rng(42)
  const pick = <T>(arr: T[], n: number) => {
    const a = [...arr]
    const out: T[] = []
    while (out.length < n && a.length) out.push(a.splice(Math.floor(rand() * a.length), 1)[0])
    return out
  }
  const diffOf = (i: number) => (i < 40 ? 1 : i < 100 ? 2 : 3)
  const continents = new Map<string, { de: string; en: string }>()
  for (const c of countries) continents.set(c.contEn, { de: c.contDe, en: c.contEn })

  const out: BatchEntry[] = []
  countries.forEach((c, i) => {
    const caps = countries.filter((o) => o.id !== c.id && o.capEn !== c.capEn && o.capDe !== c.capDe)
    const near = caps.filter((o) => o.contEn === c.contEn)
    const wrong = [...pick(near, 2), ...pick(caps.filter((o) => !near.includes(o)), 3)]
    const uniq = wrong.filter((w, k) => wrong.findIndex((x) => x.capEn === w.capEn) === k).slice(0, 3)
    if (uniq.length === 3) {
      out.push({
        group: `wd:${c.id}:capital`, category: 'geography', difficulty: diffOf(i), source_ref: `https://www.wikidata.org/wiki/${c.id}`,
        i18n: {
          de: { text: `Was ist die Hauptstadt von ${c.de}?`, correct: c.capDe, wrong: uniq.map((w) => w.capDe) },
          en: { text: `What is the capital of ${c.en}?`, correct: c.capEn, wrong: uniq.map((w) => w.capEn) },
        },
      })
    }
    const others = [...continents.values()].filter((k) => k.en !== c.contEn)
    if (others.length >= 3) {
      const w = pick(others, 3)
      out.push({
        group: `wd:${c.id}:continent`, category: 'geography', difficulty: Math.min(diffOf(i), 2), source_ref: `https://www.wikidata.org/wiki/${c.id}`,
        i18n: {
          de: { text: `Auf welchem Kontinent liegt ${c.de}?`, correct: c.contDe, wrong: w.map((x) => x.de) },
          en: { text: `On which continent is ${c.en} located?`, correct: c.contEn, wrong: w.map((x) => x.en) },
        },
      })
    }
  })
  return out
}

async function main() {
  const arg = (k: string, d: string) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
  const name = arg('name', 'wikidata-geo-001')
  const out = arg('out', path.join(config.batchDir, `${name}.json`))
  const res = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(SPARQL), {
    headers: { accept: 'application/sparql-results+json', 'user-agent': 'ratespass/0.1 (https://github.com/qwertz098/ratespass)' },
  })
  if (!res.ok) throw new Error(`Wikidata: HTTP ${res.status}`)
  const json: any = await res.json()
  const batch: Batch = {
    format: 'ratespass-batch', version: 1, batch: name, source: 'wikidata', license: 'CC0-1.0',
    attribution: 'Wikidata (https://www.wikidata.org), CC0 1.0', questions: buildGeoQuestions(json.results.bindings),
  }
  fs.writeFileSync(out, JSON.stringify(batch, null, 1))
  console.log(`${batch.questions.length} Fragen -> ${out}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
