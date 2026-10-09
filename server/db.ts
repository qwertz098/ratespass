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

const version = (db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }).user_version
if (version < 1) {
  db.exec('BEGIN')
  db.exec(SCHEMA_V1)
  db.exec('PRAGMA user_version = 1')
  db.exec('COMMIT')
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
/** Transaktion; verschachtelte Aufrufe laufen in der äußeren mit. */
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn()
  db.exec('BEGIN IMMEDIATE')
  depth++
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  } finally {
    depth--
  }
}

export const now = () => Date.now()
