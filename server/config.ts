import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = process.env
const dataDir = env.DATA_DIR ?? path.join(root, 'data')

export const config = {
  root,
  port: Number(env.PORT ?? 3000),
  dataDir,
  dbPath: env.DB_PATH ?? path.join(dataDir, 'ratespass.db'),
  batchDir: env.BATCH_DIR ?? path.join(root, 'batches'),
  webDir: env.WEB_DIR ?? path.join(root, 'web'),
  /** Ohne ADMIN_TOKEN ist die Moderations-API deaktiviert. */
  adminToken: env.ADMIN_TOKEN ?? '',
  /** Hinter einem Reverse-Proxy: X-Forwarded-For für Rate-Limits auswerten. */
  trustProxy: env.TRUST_PROXY === '1',
  /** Sprachen mit weniger aktiven Fragen werden nicht zum Spielen angeboten. */
  minLangQuestions: Number(env.MIN_LANG_QUESTIONS ?? 30),
  maxActiveGames: 25,
  inactiveDaysForfeit: 7,
}
