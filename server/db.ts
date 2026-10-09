import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'

if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
export const db = new DatabaseSync(config.dbPath)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

const SCHEMA_V1 = `
CREATE TABLE players(
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'de',
  is_bot INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  username TEXT UNIQUE,
  pw_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE TABLE sessions(
  token_hash TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  label TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_player ON sessions(player_id);
CREATE TABLE transfer_codes(
  code TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE contacts(
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(player_id, contact_id)
);
CREATE TABLE questions(
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  group_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  category TEXT NOT NULL,
  difficulty INTEGER NOT NULL,
  text TEXT NOT NULL,
  correct TEXT NOT NULL,
  wrong TEXT NOT NULL,
  explanation TEXT,
  source TEXT NOT NULL,
  license TEXT NOT NULL,
  attribution TEXT,
  source_ref TEXT,
  batch TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  submitted_by INTEGER REFERENCES players(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX questions_group_lang ON questions(group_id, lang);
CREATE INDEX questions_pick ON questions(lang, category, status);
CREATE TABLE batches(
  name TEXT PRIMARY KEY,
  source TEXT,
  license TEXT,
  inserted INTEGER NOT NULL,
  imported_at INTEGER NOT NULL
);
CREATE TABLE games(
  id INTEGER PRIMARY KEY,
  p1 INTEGER NOT NULL REFERENCES players(id),
  p2 INTEGER REFERENCES players(id),
  lang TEXT NOT NULL,
  status TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  turn INTEGER,
  phase TEXT,
  winner INTEGER,
  end_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX games_p1 ON games(p1);
CREATE INDEX games_p2 ON games(p2);
CREATE INDEX games_wait ON games(status, lang);
CREATE TABLE rounds(
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  picker INTEGER NOT NULL,
  options TEXT NOT NULL,
  category TEXT,
  PRIMARY KEY(game_id, n)
);
CREATE TABLE round_questions(
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  perm TEXT NOT NULL,
  PRIMARY KEY(game_id, round, idx)
);
CREATE TABLE answers(
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  served_at INTEGER NOT NULL,
  choice INTEGER,
  correct INTEGER,
  ms INTEGER,
  PRIMARY KEY(game_id, round, idx, player_id)
);
CREATE TABLE seen(
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  PRIMARY KEY(player_id, group_id)
);
CREATE TABLE reports(
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(question_id, player_id)
);
`

const SCHEMA_V2 = `
CREATE TABLE push_subs(
  endpoint TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_ok INTEGER,
  fails INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subs_player ON push_subs(player_id);
`

// v3: Reviewer-Rolle, Region je Frage, Überarbeitungs-Meldungen und Protokoll der Admin-Korrekturen
const SCHEMA_V3 = `
ALTER TABLE players ADD COLUMN reviewer INTEGER NOT NULL DEFAULT 0;
ALTER TABLE questions ADD COLUMN region TEXT NOT NULL DEFAULT 'global';
CREATE TABLE reviews(
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  part TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX reviews_status ON reviews(status, question_id);
CREATE TABLE edits(
  id INTEGER PRIMARY KEY,
  question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
  group_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  batch TEXT,
  old TEXT NOT NULL,
  new TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`

// v4: freischaltbare Kategorie-Stufen (Nerd/Experte): Codes und pro Spieler freigeschaltete Stufen
const SCHEMA_V4 = `
CREATE TABLE unlock_codes(
  code TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE TABLE unlocks(
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  tier TEXT NOT NULL,
  via TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(player_id, tier)
);
`

// v5: Spieler wählen Level und Extra-Kategorien selbst (ersetzt die Freischaltung aus v4); Spiele merken sich die wirksame Auswahl
const SCHEMA_V5 = `
ALTER TABLE players ADD COLUMN level TEXT NOT NULL DEFAULT 'basic';
ALTER TABLE players ADD COLUMN disabled_cats TEXT NOT NULL DEFAULT '[]';
ALTER TABLE games ADD COLUMN level TEXT;
ALTER TABLE games ADD COLUMN cats TEXT;
UPDATE players SET level='nerd' WHERE id IN (SELECT player_id FROM unlocks WHERE tier='nerd');
UPDATE players SET level='expert' WHERE id IN (SELECT player_id FROM unlocks WHERE tier='expert');
DROP TABLE unlock_codes;
DROP TABLE unlocks;
`

// v6: Millionen-Leiter (Solo): 15 Stufen, Sicherheitsstufen, Aussteigen; Bestleistung je Spieler
const SCHEMA_V6 = `
ALTER TABLE players ADD COLUMN best_ladder INTEGER NOT NULL DEFAULT 0;
CREATE TABLE ladders(
  id INTEGER PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  level TEXT NOT NULL,
  cats TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  prize INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ladders_player ON ladders(player_id, status);
CREATE TABLE ladder_steps(
  ladder_id INTEGER NOT NULL REFERENCES ladders(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  perm TEXT NOT NULL,
  served_at INTEGER NOT NULL,
  choice INTEGER,
  correct INTEGER,
  ms INTEGER,
  PRIMARY KEY(ladder_id, step)
);
`

// v7: Mehrspieler-Räume (asynchron): alle Teilnehmer spielen dieselben Fragen, jeder in eigenem Tempo
const SCHEMA_V7 = `
CREATE TABLE rooms(
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,
  lang TEXT NOT NULL,
  host INTEGER NOT NULL REFERENCES players(id),
  status TEXT NOT NULL DEFAULT 'lobby',
  level TEXT,
  cats TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deadline INTEGER
);
CREATE TABLE room_players(
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id),
  joined_at INTEGER NOT NULL,
  pos INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(room_id, player_id)
);
CREATE INDEX room_players_player ON room_players(player_id);
CREATE TABLE room_questions(
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  perm TEXT NOT NULL,
  PRIMARY KEY(room_id, idx)
);
CREATE TABLE room_answers(
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  served_at INTEGER NOT NULL,
  choice INTEGER,
  correct INTEGER,
  ms INTEGER,
  PRIMARY KEY(room_id, idx, player_id)
);
`

// v8: freiwilliges Geburtsjahr (nur das Jahr) für die anonyme Auswertung der Fragenschwierigkeit
const SCHEMA_V8 = `
ALTER TABLE players ADD COLUMN birth_year INTEGER;
`

// v9: KI-Schnittstelle: Schwierigkeits-Schätzung je Frage, Einstellungen (kv) und Protokoll der KI-Aufrufe
const SCHEMA_V9 = `
ALTER TABLE questions ADD COLUMN ai_difficulty INTEGER;
ALTER TABLE questions ADD COLUMN ai_confidence REAL;
ALTER TABLE questions ADD COLUMN ai_note TEXT;
CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE ai_log(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  created_at INTEGER NOT NULL
);
`

// v10: dokumentierte Zustimmung zur Datenschutzerklärung (Nachweis: Version = Prüfsumme des Textes + Textstand)
const SCHEMA_V10 = `
CREATE TABLE privacy_versions(
  version TEXT PRIMARY KEY,
  text_json TEXT NOT NULL,
  first_seen INTEGER NOT NULL
);
CREATE TABLE consents(
  id INTEGER PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  version TEXT NOT NULL REFERENCES privacy_versions(version),
  accepted_at INTEGER NOT NULL,
  age_ok INTEGER NOT NULL,
  lang TEXT
);
CREATE INDEX consents_player ON consents(player_id, id);
`

const version = (db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }).user_version
for (const [v, sql] of [[1, SCHEMA_V1], [2, SCHEMA_V2], [3, SCHEMA_V3], [4, SCHEMA_V4], [5, SCHEMA_V5], [6, SCHEMA_V6], [7, SCHEMA_V7], [8, SCHEMA_V8], [9, SCHEMA_V9], [10, SCHEMA_V10]] as const) {
  if (version < v) {
    db.exec('BEGIN')
    db.exec(sql)
    db.exec(`PRAGMA user_version = ${v}`)
    db.exec('COMMIT')
  }
}

type P = null | number | bigint | string
const cache = new Map<string, ReturnType<typeof db.prepare>>()
const stmt = (sql: string) => {
  let s = cache.get(sql)
  if (!s) cache.set(sql, (s = db.prepare(sql)))
  return s
}
export const get = <T>(sql: string, ...p: P[]) => stmt(sql).get(...p) as unknown as T | undefined
export const all = <T>(sql: string, ...p: P[]) => stmt(sql).all(...p) as unknown as T[]
export const run = (sql: string, ...p: P[]) => stmt(sql).run(...p)

let depth = 0
const hooks: Array<() => void> = []
/** Führt fn nach erfolgreichem Commit der äußersten Transaktion aus (außerhalb einer Transaktion sofort). */
export function afterCommit(fn: () => void) {
  if (depth > 0) hooks.push(fn)
  else fn()
}

/** Transaktion; verschachtelte Aufrufe laufen in der äußeren mit. */
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn()
  let result: T
  db.exec('BEGIN IMMEDIATE')
  depth++
  try {
    result = fn()
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    hooks.length = 0
    throw e
  } finally {
    depth--
  }
  for (const h of hooks.splice(0)) {
    try { h() } catch (e) { console.error('afterCommit', e) }
  }
  return result
}

export const now = () => Date.now()
