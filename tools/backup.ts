// Konsistente Sicherung der SQLite-Datenbank (+ VAPID-Schlüssel) in ein Verzeichnis – auch im laufenden Betrieb.
// Verwendung: node tools/backup.ts <zielverzeichnis>      (Docker: docker compose exec ratespass node tools/backup.ts /data/backup)
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from '../server/config.ts'

const dir = process.argv[2]
if (!dir) { console.error('Verwendung: backup.ts <zielverzeichnis>'); process.exit(2) }
fs.mkdirSync(dir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const target = path.join(dir, `ratespass-${stamp}.db`)
const db = new DatabaseSync(config.dbPath)
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
db.close()
const vapid = process.env.VAPID_FILE ?? path.join(config.dataDir, 'vapid.json')
if (fs.existsSync(vapid)) fs.copyFileSync(vapid, path.join(dir, `vapid-${stamp}.json`), fs.constants.COPYFILE_EXCL)
for (const f of fs.readdirSync(dir)) if (f.startsWith(`vapid-${stamp}`)) fs.chmodSync(path.join(dir, f), 0o600)
console.log(`Backup: ${target}`)
