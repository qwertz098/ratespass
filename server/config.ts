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
  /** Neue anonyme Profile pro IP und Stunde (großzügig, weil sich hinter Mobilfunk-/Schul-/WLAN-Gateways viele Nutzer eine IP teilen). */
  playerCreateLimit: ((n) => (n >= 1 ? Math.floor(n) : 60))(Number(env.PLAYER_CREATE_LIMIT_PER_HOUR ?? 60)),
  maxActiveGames: 25,
  /** VAPID-Kontakt (mailto: oder https-URL), von Push-Diensten verlangt. */
  vapidSubject: env.VAPID_SUBJECT ?? 'https://github.com/qwertz098/ratespass',
  /** Nur für Tests/lokale Fake-Push-Server: erlaubt http://127.0.0.1 als Endpoint. */
  pushAllowInsecure: env.PUSH_ALLOW_INSECURE === '1',
  /** Zusätzlich erlaubte Push-Dienst-Hosts (kommagetrennt), z. B. für selbst gehostetes UnifiedPush. */
  pushExtraHosts: (env.PUSH_EXTRA_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  /** Melde-Knopf (⚑) für alle Spieler; mit PLAYER_REPORTS=0 abschaltbar (Reviewer und Admin bleiben unberührt). */
  playerReports: env.PLAYER_REPORTS !== '0',
  /** Duelle: Aufgabe bei Inaktivität, Erinnerung (Push) an den Spieler am Zug, Bot-Übernahme durch den Wartenden (Stunden bzw. Tage). */
  duel: {
    forfeitDays: Math.max(1, Number(env.DUEL_FORFEIT_DAYS ?? 3) || 3),
    remindHours: Math.max(1, Number(env.DUEL_REMIND_HOURS ?? 24) || 24),
    takeoverHours: Math.max(1, Number(env.DUEL_TAKEOVER_HOURS ?? 24) || 24),
  },
  /** Wordle: Tageswechsel in dieser Zeitzone, Wortlisten-Verzeichnis, Gruppengröße, Mindestabstand zwischen Versuchen (ms). */
  wordle: { tz: env.WORDLE_TZ ?? 'Europe/Berlin', dir: env.WORDLE_DIR ?? path.join(root, 'wordlists'), groupMax: Math.max(2, Number(env.WORDLE_GROUP_MAX ?? 200) || 200), minGuessMs: 300 },
  /** Live-Gesellschaftsspiel (Zeiten in ms; in Tests verkürzt). */
  live: {
    maxPlayers: Math.max(2, Number(env.LIVE_MAX_PLAYERS ?? 30) || 30),
    questionMs: Math.max(3000, Number(env.LIVE_QUESTION_MS ?? 20_000) || 20_000), revealMs: Math.max(500, Number(env.LIVE_REVEAL_MS ?? 5_000) || 5_000),
    tempoQuestions: Math.min(12, Math.max(1, Number(env.LIVE_TEMPO_QUESTIONS ?? 10) || 10)), joinTokenMs: 2 * 3_600_000,
    raceQuestions: 14, betQuestions: 8, estimateQuestions: Math.max(1, Number(env.LIVE_ESTIMATE_QUESTIONS ?? 8) || 8), blitzLockMs: 2_000, blitzMinMs: 500, betMs: Math.max(500, Number(env.LIVE_BET_MS ?? 8_000) || 8_000),
  },
  /** Verzeichnis mit den Textvorlagen der Datenschutzerklärung (datenschutz.de.md / datenschutz.en.md); mit LEGAL_DIR durch eine eigene Fassung ersetzbar. */
  legalDir: env.LEGAL_DIR ?? path.join(root, 'legal'),
  /** Zustimmung zur Datenschutzerklärung serverseitig erzwingen (nur für lokale Entwicklung/Tests mit CONSENT_REQUIRED=0 abschaltbar). */
  requireConsent: env.CONSENT_REQUIRED !== '0',
  /** Verantwortlicher (Impressum und Datenschutzerklärung). Pflichtangaben: Name, Anschrift, E-Mail. */
  privacy: {
    controllerName: (env.CONTROLLER_NAME ?? '').trim(),
    controllerAddress: (env.CONTROLLER_ADDRESS ?? '').trim(),
    controllerEmail: (env.CONTROLLER_EMAIL ?? '').trim(),
    controllerPhone: (env.CONTROLLER_PHONE ?? '').trim(),
    representative: (env.CONTROLLER_REPRESENTATIVE ?? '').trim(),
    register: (env.CONTROLLER_REGISTER ?? '').trim(),
    vatId: (env.CONTROLLER_VAT_ID ?? '').trim(),
    supervisoryAuthority: (env.SUPERVISORY_AUTHORITY ?? '').trim(),
    dpoContact: (env.DPO_CONTACT ?? '').trim(),
    hosting: (env.HOSTING_PROVIDER ?? '').trim(),
    /** Anonyme Profile ohne Anmeldung werden nach so vielen Tagen ohne Aktivität gelöscht (Speicherbegrenzung). */
    retentionDays: Math.max(30, Number(env.PRIVACY_RETENTION_DAYS ?? 730) || 730),
  },
  /** KI-Schnittstelle (Anthropic Messages API): Fragen erzeugen, Schwierigkeit schätzen. Ohne ANTHROPIC_API_KEY deaktiviert. */
  ai: {
    key: env.ANTHROPIC_API_KEY ?? '',
    model: env.AI_MODEL ?? 'claude-sonnet-5-5',
    baseUrl: (env.AI_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, ''),
    /** Obergrenze neu erzeugter Fragen pro Tag (Kostenbremse, gilt auch für den Auto-Lauf). */
    dailyLimit: Math.max(1, Number(env.AI_DAILY_LIMIT ?? 100) || 100),
    /** Auto-Lauf: erzeugt regelmäßig Fragen für die größten Lücken (landen immer in der Moderation). */
    auto: env.AI_AUTO === '1',
    autoIntervalHours: Math.max(1, Number(env.AI_AUTO_INTERVAL_HOURS ?? 24) || 24),
    autoBatch: Math.max(1, Number(env.AI_AUTO_BATCH ?? 20) || 20),
  },
}
