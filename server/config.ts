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
  adminSessionMs: (Number(env.ADMIN_SESSION_HOURS ?? 8) || 8) * 3_600_000,
  /** Hinter einem Reverse-Proxy: X-Forwarded-For für Rate-Limits auswerten. */
  trustProxy: env.TRUST_PROXY === '1',
  /** Anzahl vertrauenswürdiger Proxys vor der App (z. B. Cloudflare → NPM = 2). Es zählt der n-te Eintrag von rechts in X-Forwarded-For. */
  proxyHops: Math.max(1, Number(env.PROXY_HOPS ?? 1) || 1),
  /** Sprachen mit weniger aktiven Fragen werden nicht zum Spielen angeboten. */
  minLangQuestions: Number(env.MIN_LANG_QUESTIONS ?? 30),
  maxActiveGames: 25,
  /** VAPID-Kontakt (mailto: oder https-URL), von Push-Diensten verlangt. */
  vapidSubject: env.VAPID_SUBJECT ?? 'https://github.com/qwertz098/ratespass',
  /** Nur für Tests/lokale Fake-Push-Server: erlaubt http://127.0.0.1 als Endpoint. */
  pushAllowInsecure: env.PUSH_ALLOW_INSECURE === '1',
  /** Zusätzlich erlaubte Push-Dienst-Hosts (kommagetrennt), z. B. für selbst gehostetes UnifiedPush. */
  pushExtraHosts: (env.PUSH_EXTRA_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  inactiveDaysForfeit: 7,
}
