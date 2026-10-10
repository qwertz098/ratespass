import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { boot, get, all, run, importBatch } from './helpers.ts'

const t = await boot()
test.after(() => t.close())
const { call, newPlayer } = t
for (const f of ['original-001', 'original-002']) assert.deepEqual(importBatch(JSON.parse(fs.readFileSync(new URL(`../batches/${f}.json`, import.meta.url), 'utf8'))).errors, [])
const adm = { 'x-admin-token': 'test-admin-token' }
const { clearCache } = await import('../server/leaderboard.ts')
const qids = all<{ id: number }>("SELECT id FROM questions WHERE lang='de' AND status='active' LIMIT 40").map((r) => r.id)
const HOUR = 3_600_000, DAY = 24 * HOUR
const pidOf = (pub: string) => get<{ id: number }>('SELECT id FROM players WHERE public_id=?', pub)!.id

let seq = 0
let spread = 0
/** Zeitstempel über die letzten 20 Stunden verteilt, damit das Stundenlimit nicht greift. */
const spreadAt = () => Date.now() - (spread++ % 20) * HOUR - 60_000
function ladderAnswers(pid: number, n: number, okN: number, opts: { ms?: number; at?: () => number } = {}) {
  const ladders: number[] = []
  for (let i = 0; i < n; i++) {
    if (i % 15 === 0) ladders.push(Number(run("INSERT INTO ladders(player_id,lang,level,cats,created_at,updated_at,status) VALUES(?,?,?,?,?,?,'lost')", pid, 'de', 'basic', '[]', 1, 1).lastInsertRowid))
    run('INSERT INTO ladder_steps(ladder_id,step,question_id,perm,served_at,choice,correct,ms) VALUES(?,?,?,?,?,?,?,?)', ladders[Math.floor(i / 15)], (i % 15) + 1, qids[(seq++) % qids.length], '[0,1,2,3]', opts.at ? opts.at() : spreadAt(), 0, i < okN ? 1 : 0, opts.ms ?? 5000)
  }
}
function roomAnswers(pid: number, n: number, okN: number) {
  const room = Number(run("INSERT INTO rooms(code,mode,lang,host,status,total,created_at,updated_at) VALUES(?,?,?,?,'finished',?,1,1)", 'R' + ++seq + 'XXXXX', 'quiz', 'de', pid, n).lastInsertRowid)
  for (let i = 0; i < n; i++) {
    run('INSERT INTO room_questions(room_id,idx,question_id,perm) VALUES(?,?,?,?)', room, i, qids[i % qids.length], '[0,1,2,3]')
    run('INSERT INTO room_answers(room_id,idx,player_id,served_at,choice,correct,ms) VALUES(?,?,?,?,?,?,?)', room, i, pid, spreadAt(), 0, i < okN ? 1 : 0, 6000)
  }
}
function duelAnswers(pid: number, opp: number, n: number, okN: number) {
  const g = Number(run("INSERT INTO games(p1,p2,lang,status,created_at,updated_at) VALUES(?,?,?,'finished',1,1)", pid, opp, 'de').lastInsertRowid)
  for (let i = 0; i < n; i++) {
    run('INSERT INTO round_questions(game_id,round,idx,question_id,perm) VALUES(?,?,?,?,?)', g, Math.floor(i / 3) + 1, i % 3, qids[i % qids.length], '[0,1,2,3]')
    run('INSERT INTO answers(game_id,round,idx,player_id,served_at,choice,correct,ms) VALUES(?,?,?,?,?,?,?,?)', g, Math.floor(i / 3) + 1, i % 3, pid, spreadAt(), 0, i < okN ? 1 : 0, 4000)
  }
}
const old = (pid: number) => run('UPDATE players SET created_at=? WHERE id=?', Date.now() - 3 * DAY, pid)
const board = async (token: string, q: string) => (await call('GET', '/api/leaderboard?' + q, undefined, token)).json

test('Teilnahme ist Opt-in: Name prüfen, eindeutig, Teilnahme beenden', async () => {
  const a = await newPlayer('Teilnehmer'), b = await newPlayer('Zweiter')
  const join = (tok: string, name: unknown) => call('POST', '/api/leaderboard/join', { name }, tok)
  for (const bad of ['ab', 'x'.repeat(21), '<script>', '   ', '123', 'Admin', 'Ratespaß', '_lead']) assert.equal((await join(a.token, bad)).status, 400, String(bad))
  assert.equal((await join(a.token, 'Quizkönig')).status, 200)
  assert.equal((await join(b.token, 'QUIZKÖNIG')).status, 409, 'Groß-/Kleinschreibung zählt nicht')
  assert.equal((await call('GET', '/api/me', undefined, a.token)).json.player.lb_name, 'Quizkönig')
  assert.equal((await board(a.token, 'scope=all')).participating, true)
  assert.equal((await board(b.token, 'scope=all')).participating, false)
  assert.equal((await call('DELETE', '/api/leaderboard/join', undefined, a.token)).status, 200)
  assert.equal((await call('GET', '/api/me', undefined, a.token)).json.player.lb_name, null)
  assert.equal((await join(b.token, 'Quizkönig')).status, 200, 'Name wieder frei')
})

test('Teilnahme mit dem Anzeigenamen nur auf ausdrücklichen Wunsch (Momentaufnahme)', async () => {
  const a = await newPlayer('Anzeigename Eins'), b = await newPlayer('Anzeigename Eins'), c = await newPlayer('Zu')
  assert.equal((await call('POST', '/api/leaderboard/join', { use_display_name: true }, a.token)).status, 200)
  assert.equal((await call('GET', '/api/me', undefined, a.token)).json.player.lb_name, 'Anzeigename Eins')
  assert.equal((await call('POST', '/api/leaderboard/join', { use_display_name: true }, b.token)).status, 409, 'gleicher Name ist belegt')
  assert.equal((await call('POST', '/api/leaderboard/join', { use_display_name: true }, c.token)).status, 400, 'zu kurz für die Bestenliste')
  assert.equal((await call('PATCH', '/api/me', { name: 'Neu Benannt' }, a.token)).status, 200)
  assert.equal((await call('GET', '/api/me', undefined, a.token)).json.player.lb_name, 'Anzeigename Eins', 'Momentaufnahme')
  assert.equal((await call('POST', '/api/leaderboard/join', { name: 'Anderer Name' }, b.token)).status, 200, 'ohne Flag zählt weiter der eigene Name')
})

test('Zählweise: mit Bots vs. nur Menschen, absolut vs. relativ, nur Teilnehmer', async () => {
  const a = await newPlayer('Zähler Eins'), b = await newPlayer('Zähler Zwei'), c = await newPlayer('Heimlich'), human = await newPlayer('Gegner')
  const [pa, pb, pc, ph] = [a, b, c, human].map((p) => pidOf(p.player.public_id)); [pa, pb, pc].forEach(old)
  const botId = Number(run("INSERT INTO players(public_id,name,created_at,is_bot) VALUES('BOTBOT01','Robo',1,1)").lastInsertRowid)
  await call('POST', '/api/leaderboard/join', { name: 'Eins' }, a.token); await call('POST', '/api/leaderboard/join', { name: 'Zwei' }, b.token)
  // a: 60 Leiter-Antworten (45 richtig, solo) + 60 Raum (30 richtig) → 120 / 75; mit Bot-Duell +30 (30 richtig) nur "mit Bots"
  ladderAnswers(pa, 60, 45); roomAnswers(pa, 60, 30); duelAnswers(pa, botId, 30, 30)
  // b: 120 Duell gegen Mensch, 110 richtig → hohe Quote
  duelAnswers(pb, ph, 120, 110)
  // c nimmt nicht teil, hat aber viele Antworten
  roomAnswers(pc, 80, 80)
  clearCache()
  const incl = await board(a.token, 'scope=all&bots=incl&kind=abs')
  assert.deepEqual(incl.top.map((r: any) => [r.name, r.ok, r.n]), [['Zwei', 110, 120], ['Eins', 105, 150]].sort((x, y) => (y[1] as number) - (x[1] as number)))
  assert.ok(!incl.top.some((r: any) => r.name === 'Heimlich'), 'ohne Opt-in nicht in der Liste')
  const excl = await board(a.token, 'scope=all&bots=excl&kind=abs')
  assert.deepEqual(excl.top.map((r: any) => [r.name, r.ok, r.n]), [['Zwei', 110, 120], ['Eins', 30, 60]], 'Solo-Leiter und Bot-Duelle zählen nicht')
  assert.equal(excl.me.rank, 2); assert.equal(excl.me.ok, 30)
  const rel = await board(a.token, 'scope=all&bots=incl&kind=rel')
  assert.equal(rel.top[0].name, 'Zwei'); assert.equal(rel.top[0].rate, 91.7)
  const relExcl = await board(a.token, 'scope=all&bots=excl&kind=rel')
  assert.deepEqual(relExcl.top.map((r: any) => r.name), ['Zwei'], 'relativ erst ab 100 Antworten: Eins hat nur 60')
  assert.equal(relExcl.me.rank, null); assert.equal(relExcl.me.needs, 40)
})

test('Bot-Schutz Basis: zu schnelle Antworten, Tageslimit, Mindestalter und Mindestmenge', async () => {
  const fast = await newPlayer('Zu Schnell'), many = await newPlayer('Vielspieler'), young = await newPlayer('Frischling'), few = await newPlayer('Wenig')
  const [pf, pm, py, pw] = [fast, many, young, few].map((p) => pidOf(p.player.public_id)); [pf, pm, pw].forEach(old)
  for (const p of [fast, many, young, few]) await call('POST', '/api/leaderboard/join', { name: p.player.name.replace(/ /g, '·') }, p.token)
  ladderAnswers(pf, 200, 200, { ms: 150 }) // schneller als jede Lesezeit
  // 450 Antworten an einem Tag, verteilt auf 10 Stunden (je 45): Tageslimit 400 greift
  const day0 = Math.floor(Date.now() / DAY) * DAY // heutiger UTC-Tag, unabhängig von der Uhrzeit des Testlaufs
  let k = 0; ladderAnswers(pm, 450, 450, { at: () => day0 + (k++ % 10) * HOUR + 60_000 })
  ladderAnswers(py, 80, 80)
  ladderAnswers(pw, 20, 20)
  clearCache()
  const r = await board(many.token, 'scope=all&bots=incl&kind=abs&limit=100')
  const by = Object.fromEntries(r.top.map((x: any) => [x.name, x]))
  assert.ok(!by['Zu·Schnell'], 'zu schnelle Antworten zählen nicht (und damit keine Mindestmenge)')
  assert.equal(by['Vielspieler'].n, 400, 'Tageslimit 400')
  assert.ok(!by['Frischling'], 'Profil jünger als 24 h')
  assert.ok(!by['Wenig'], 'unter 50 gewerteten Antworten')
  const mine = (await board(young.token, 'scope=all')).me
  assert.equal(mine.young, true); assert.equal(mine.n, 80)
  assert.equal((await board(few.token, 'scope=all')).me.needs, 30)
})

test('Zeiträume: Woche und Monat zählen nur aktuelle Antworten', async () => {
  const p = await newPlayer('Zeitreisender'); const pid = pidOf(p.player.public_id); old(pid)
  await call('POST', '/api/leaderboard/join', { name: 'Zeitreisender' }, p.token)
  ladderAnswers(pid, 60, 60, { at: () => Date.now() - 40 * DAY })
  clearCache()
  assert.equal((await board(p.token, 'scope=all')).me.n, 60)
  assert.equal((await board(p.token, 'scope=month')).me.n, 0)
  assert.equal((await board(p.token, 'scope=week')).me.n, 0)
})

test('Auffälligkeiten: fast fehlerfreie Spieler werden dem Admin gemeldet und lassen sich sperren', async () => {
  // Vergleichsgruppe: 12 Spieler beantworten dieselben 20 Fragen mit ~60 % richtig, damit Fragequoten bekannt sind
  for (let i = 0; i < 12; i++) { const q = await newPlayer('Vergleich ' + i); const pid = pidOf(q.player.public_id); for (let j = 0; j < 20; j++) { const l = Number(run("INSERT INTO ladders(player_id,lang,level,cats,created_at,updated_at,status) VALUES(?,?,?,?,?,?,'lost')", pid, 'de', 'basic', '[]', 1, 1).lastInsertRowid); run('INSERT INTO ladder_steps(ladder_id,step,question_id,perm,served_at,choice,correct,ms) VALUES(?,?,?,?,?,?,?,?)', l, 1, qids[j], '[0,1,2,3]', Date.now(), 0, (i + j) % 5 < 3 ? 1 : 0, 3000 + ((i * 131 + j * 977) % 9000)) } }
  const sus = await newPlayer('Verdächtig'); const sp = pidOf(sus.player.public_id); old(sp)
  await call('POST', '/api/leaderboard/join', { name: 'Superhirn' }, sus.token)
  for (let j = 0; j < 240; j++) { const l = Number(run("INSERT INTO ladders(player_id,lang,level,cats,created_at,updated_at,status) VALUES(?,?,?,?,?,?,'lost')", sp, 'de', 'basic', '[]', 1, 1).lastInsertRowid); run('INSERT INTO ladder_steps(ladder_id,step,question_id,perm,served_at,choice,correct,ms) VALUES(?,?,?,?,?,?,?,?)', l, 1, qids[j % 20], '[0,1,2,3]', Date.now() - (j % 24) * HOUR, 0, 1, 2000) }
  assert.equal((await call('GET', '/api/admin/lb/flags')).status, 401)
  const res = (await call('GET', '/api/admin/lb/flags', undefined, undefined, adm)).json
  const f = res.flags.find((x: any) => x.public_id === sus.player.public_id)
  assert.ok(f, 'wird markiert')
  assert.ok(f.flags.length >= 3 && f.flags.some((x: string) => /97/.test(x)) && f.flags.some((x: string) => /gleichförmig/.test(x)) && f.flags.some((x: string) => /rund um die Uhr/.test(x)), f.flags.join('|'))
  assert.ok(!res.flags.some((x: any) => /^Vergleich/.test(x.name)), 'normale Spieler nicht')
  assert.equal((await call('POST', '/api/admin/lb/ban', { public_id: sus.player.public_id }, undefined, adm)).status, 200)
  assert.equal(get<{ lb_name: string | null }>('SELECT lb_name FROM players WHERE id=?', sp)!.lb_name, null, 'Sperre entfernt den Namen')
  assert.equal((await call('POST', '/api/leaderboard/join', { name: 'Wieder da' }, sus.token)).status, 403)
  assert.equal((await call('POST', '/api/admin/lb/ban', { public_id: sus.player.public_id, banned: false }, undefined, adm)).status, 200)
  assert.equal((await call('POST', '/api/leaderboard/join', { name: 'Wieder da' }, sus.token)).status, 200)
})
