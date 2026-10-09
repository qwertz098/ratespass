import test from 'node:test'
import assert from 'node:assert/strict'
import { boot, get, all, run } from './helpers.ts'

const t = await boot()
test.after(() => t.close())
const { call, newPlayer } = t
const adm = { 'x-admin-token': 'test-admin-token' }
const thisYear = new Date().getFullYear()

test('Geburtsjahr ist freiwillig, wird geprüft und lässt sich löschen', async () => {
  const p = await newPlayer('Jahrgang')
  assert.equal((await call('GET', '/api/me', undefined, p.token)).json.player.birth_year, null)
  const set = (v: unknown) => call('PATCH', '/api/me', { birth_year: v }, p.token)
  assert.equal((await set(1850)).status, 400)
  assert.equal((await set(thisYear)).status, 400, 'mind. 5 Jahre')
  assert.equal((await set('abc')).status, 400)
  assert.equal((await set(1990)).json.player.birth_year, 1990)
  assert.equal((await set(null)).json.player.birth_year, null)
  assert.equal((await set('')).json.player.birth_year, null)
})

/** Legt n Antworten (ok von n richtig) für eine Frage über Leiter-Schritte an – von Spielern der angegebenen Jahrgänge. */
function seedAnswers(qid: number, years: (number | null)[], okCount: number) {
  years.forEach((y, i) => {
    const pid = Number(run('INSERT INTO players(public_id,name,created_at,birth_year) VALUES(?,?,?,?)', `S${qid}X${i}`.padEnd(8, 'Z').slice(0, 8), 'Statist', Date.now(), y).lastInsertRowid)
    const lid = Number(run("INSERT INTO ladders(player_id,lang,level,cats,created_at,updated_at,status) VALUES(?,?,?,?,?,?,'lost')", pid, 'de', 'basic', '[]', 1, 1).lastInsertRowid)
    run('INSERT INTO ladder_steps(ladder_id,step,question_id,perm,served_at,choice,correct,ms) VALUES(?,?,?,?,?,?,?,?)', lid, 1, qid, '[0,1,2,3]', 1, 0, i < okCount ? 1 : 0, 3000)
  })
}

test('Statistik: Lösungsquote nach Altersgruppe, Anonymitätsgrenze, Bots ausgeschlossen', async () => {
  const hard = get<{ id: number; group_id: string }>("SELECT id, group_id FROM questions WHERE lang='de' AND status='active' AND difficulty=3 LIMIT 1")!
  run('UPDATE questions SET difficulty=3 WHERE group_id=?', hard.group_id)
  // 40 Antworten, 36 richtig (90 %): 10 Jugendliche, 25 Erwachsene 30–44, 3 Senioren (zu klein), 2 ohne Angabe
  seedAnswers(hard.id, [...Array(10).fill(thisYear - 15), ...Array(25).fill(thisYear - 35), ...Array(3).fill(thisYear - 70), null, null], 36)
  // Bot-Antworten zählen nicht
  const bot = Number(run("INSERT INTO players(public_id,name,created_at,is_bot) VALUES('BOTBOTBO','Robo',1,1)").lastInsertRowid)
  const lid = Number(run("INSERT INTO ladders(player_id,lang,level,cats,created_at,updated_at) VALUES(?,?,?,?,?,?)", bot, 'de', 'basic', '[]', 1, 1).lastInsertRowid)
  run('INSERT INTO ladder_steps(ladder_id,step,question_id,perm,served_at,choice,correct,ms) VALUES(?,?,?,?,?,?,?,?)', lid, 1, hard.id, '[0,1,2,3]', 1, 1, 0, 1)

  assert.equal((await call('GET', '/api/admin/stats/overview')).status, 401)
  const ov = (await call('GET', '/api/admin/stats/overview', undefined, undefined, adm)).json
  const d3 = ov.by_difficulty.find((d: any) => d.difficulty === 3)
  assert.equal(d3.n, 40); assert.equal(d3.rate, 0.9)
  const cell = (band: string) => ov.by_difficulty_age.find((r: any) => r.difficulty === 3 && r.band === band)
  assert.equal(cell('<18').n, 10); assert.equal(cell('30-44').n, 25)
  assert.equal(cell('60+').n, null, 'unter 5 Antworten wird nicht ausgewiesen')
  assert.ok(ov.players.with_year >= 38)

  const qs = (await call('GET', '/api/admin/stats/questions?min_n=30', undefined, undefined, adm)).json
  const row = qs.questions.find((x: any) => x.group_id === hard.group_id)
  assert.equal(row.n, 40); assert.equal(row.difficulty, 3); assert.equal(row.suggested, 1, '90 % richtig = leicht'); assert.equal(row.gap, 2)
  assert.equal(row.by_age['<18'].rate, 1)
  assert.equal(row.by_age['60+'].n, null)
  assert.equal((await call('GET', '/api/admin/stats/questions?min_n=100', undefined, undefined, adm)).json.questions.length, 0)
})

test('Schwierigkeit angleichen: ändert die ganze Gruppe und protokolliert in edits', async () => {
  const row = (await call('GET', '/api/admin/stats/questions?min_n=30', undefined, undefined, adm)).json.questions[0]
  assert.equal((await call('POST', '/api/admin/stats/apply-difficulty', { group_id: row.group_id }, undefined)).status, 401)
  const before = all("SELECT 1 FROM edits").length
  const r = await call('POST', '/api/admin/stats/apply-difficulty', { group_id: row.group_id, min_n: 30 }, undefined, adm)
  assert.equal(r.json.changed, 1)
  assert.deepEqual(all<{ d: number }>('SELECT DISTINCT difficulty d FROM questions WHERE group_id=?', row.group_id).map((x) => x.d), [1])
  assert.ok(all('SELECT 1 FROM edits').length > before)
  assert.equal((await call('POST', '/api/admin/stats/apply-difficulty', { group_id: row.group_id, min_n: 30 }, undefined, adm)).json.changed, 0, 'idempotent')
})
