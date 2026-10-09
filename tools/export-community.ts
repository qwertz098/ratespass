// Schreibt freigegebene Community-Fragen als Batch-Datei ins Repo (batches/community-NNN.json), damit sie nicht nur in der DB leben.
// Verwendung: npm run export:community [-- --dry-run] [--out pfad.json]
// Danach: Datei committen. Die exportierten Fragen sind in der DB dem Batch zugeordnet (kein erneuter Export, kein Doppelimport).
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../server/config.ts'
import { exportCommunityBatch } from '../server/questions.ts'

const dry = process.argv.includes('--dry-run')
const outArg = process.argv.indexOf('--out')
const batch = exportCommunityBatch({ mark: !dry, dir: config.batchDir })
if (!batch) { console.log('Keine neuen freigegebenen Community-Fragen.'); process.exit(0) }
const out = outArg > 0 ? process.argv[outArg + 1] : path.join(config.batchDir, `${batch.batch}.json`)
if (dry) console.log(`${batch.questions.length} Fragen würden als ${batch.batch} exportiert (dry-run, nichts geschrieben).`)
else {
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(batch, null, 1), { flag: 'wx' })
  console.log(`${batch.questions.length} Fragen -> ${out}  (jetzt committen)`)
}
