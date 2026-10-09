// Verwendung: npm run import -- batches/foo.json [weitere.json] [--dry-run] [--lenient]
import fs from 'node:fs'
import { importBatch } from '../server/questions.ts'

const args = process.argv.slice(2)
const files = args.filter((a) => !a.startsWith('--'))
if (!files.length) {
  console.error('Verwendung: import-batch.ts <batch.json>... [--dry-run] [--lenient]')
  process.exit(2)
}
let failed = false
for (const f of files) {
  const r = importBatch(JSON.parse(fs.readFileSync(f, 'utf8')), { dryRun: args.includes('--dry-run'), lenient: args.includes('--lenient') })
  console.log(`${f}: neu ${r.inserted}, Übersetzungen ${r.translated}, Duplikate ${r.duplicates}, Fehler ${r.errors.length}${args.includes('--dry-run') ? ' (dry-run)' : ''}`)
  for (const e of r.errors.slice(0, 20)) console.log('  ✗', e)
  if (r.errors.length) failed = true
}
process.exit(failed ? 1 : 0)
