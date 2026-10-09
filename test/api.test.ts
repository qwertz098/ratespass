import test from 'node:test'
import assert from 'node:assert/strict'
import { boot, correctIndexFor, get, all, run } from './helpers.ts'

const t = await boot()
test.after(() => t.close())
const { call, newPlayer } = t

async function playTurn(token: string, gameId: number, mode: 'correct' | 'wrong') {
  let g = (await call('GET', `/api/games/${gameId}`, undefined, token)).json.game
  if (g.turn !== 'me') return false
  if (g.phase === 'pick') {
    const r = await call('POST', `/api/games/${gameId}/pick`, { category: g.options[0] }, token)
    assert.equal(r.status, 200, JSON.stringify(r.json))
  }
  for (let i = 0; i < 3; i++) {
    const q = await call('GET', `/api/games/${gameId}/question`, undefined, token)
    assert.equal(q.status, 200, JSON.stringify(q.json))
    assert.equal(q.json.options.length, 4)
    assert.equal(JSON.stringify(q.json).includes('correct'), false, 'Frage darf Lösung nicht verraten')
    const right = correctIndexFor(gameId, q.json.round, q.json.idx)
    const choice = mode === 'correct' ? right : (right + 1) % 4
    const a = await call('POST', `/api/games/${gameId}/answer`, { idx: q.json.idx, choice }, token)
    assert.equal(a.status, 200, JSON.stringify(a.json))
    assert.equal(a.json.correct, mode === 'correct')
    assert.equal(a.json.correct_index, right)
  }
  return true
}

test('Anonym spielen ohne Login: Spieler anlegen, Meta, Auth-Pflicht', async () => {
  const meta = await call('GET', '/api/meta')
  assert.deepEqual(meta.json.langs.map((l: any) => l.lang).sort(), ['de', 'en'])
  assert.equal((await call('GET', '/api/me')).status, 401)
  assert.equal((await call('GET', '/api/me', undefined, 'x'.repeat(43))).status, 401)
  const a = await newPlayer('Alice')
  const me = await call('GET', '/api/me', undefined, a.token)
  assert.equal(me.json.player.name, 'Alice')
  assert.equal(me.json.player.has_account, false)
})

test('Vollständiges Spiel zweier Menschen über Kontakt: 6 Runden, Gewinner, Revanche', async () => {
  const a = await newPlayer('Alice'), b = await newPlayer('Bob')
  // Fremde dürfen nicht herausfordern
  assert.equal((await call('POST', '/api/games', { opponent: b.player.public_id }, a.token)).status, 403)
  // Einladungslink-Flow: Bob schaut Alice nach und fügt sie hinzu (gegenseitig)
  assert.equal((await call('GET', `/api/players/${a.player.public_id}`)).json.name, 'Alice')
  assert.equal((await call('POST', '/api/contacts', { public_id: a.player.public_id }, b.token)).status, 200)
  const created = await call('POST', '/api/games', { opponent: b.player.public_id }, a.token)
  assert.equal(created.status, 200, JSON.stringify(created.json))
  const id = created.json.id

  // Reihenfolge: Alice (Runde 1 pick+play), dann Bob; Bob darf vorher nicht
  assert.equal((await call('GET', `/api/games/${id}/question`, undefined, b.token)).status, 409)
  let turns = 0
  while (turns++ < 30) {
    const g = (await call('GET', `/api/games/${id}`, undefined, a.token)).json.game
    if (g.status === 'finished') break
    assert.ok(await playTurn(a.token, id, 'correct') || await playTurn(b.token, id, 'wrong'))
  }
  const ga = (await call('GET', `/api/games/${id}`, undefined, a.token)).json.game
  const gb = (await call('GET', `/api/games/${id}`, undefined, b.token)).json.game
  assert.equal(ga.status, 'finished')
  assert.deepEqual(ga.score, { me: 18, opp: 0 })
  assert.deepEqual(gb.score, { me: 0, opp: 18 })
  assert.equal(ga.winner, 'me')
  assert.equal(gb.winner, 'opp')
  assert.equal(ga.rounds.length, 6)
  assert.equal(new Set(ga.rounds.map((r: any) => r.category)).size >= 1, true)
  // Fragen innerhalb eines Spiels wiederholen sich nicht
  const groups = all<{ g: string }>('SELECT q.group_id g FROM round_questions rq JOIN questions q ON q.id=rq.question_id WHERE rq.game_id=?', id)
  assert.equal(new Set(groups.map((x) => x.g)).size, 18)
  // Nach Spielende keine Züge mehr
  assert.equal((await call('GET', `/api/games/${id}/question`, undefined, a.token)).status, 409)
  // Revanche ohne Kontakt-Eintrag möglich, weil man sich kennt
  assert.equal((await call('POST', '/api/games', { opponent: a.player.public_id }, b.token)).status, 200)
})

test('Spielstand des Gegners bleibt verdeckt, bis man selbst geantwortet hat', async () => {
  const a = await newPlayer('Alice2'), b = await newPlayer('Bob2')
  await call('POST', '/api/contacts', { public_id: a.player.public_id }, b.token)
  const id = (await call('POST', '/api/games', { opponent: b.player.public_id }, a.token)).json.id
  await playTurn(a.token, id, 'correct')
  const gb = (await call('GET', `/api/games/${id}`, undefined, b.token)).json.game
  assert.deepEqual(gb.rounds[0].opp, [null, null, null])
  const q = await call('GET', `/api/games/${id}/question`, undefined, b.token)
  await call('POST', `/api/games/${id}/answer`, { idx: 0, choice: (correctIndexFor(id, 1, 0) + 1) % 4 }, b.token)
  const gb2 = (await call('GET', `/api/games/${id}`, undefined, b.token)).json.game
  assert.deepEqual(gb2.rounds[0].opp, [true, null, null])
  assert.equal(q.status, 200)
  // Doppelt antworten / falscher Index / ungültige Wahl
  assert.equal((await call('POST', `/api/games/${id}/answer`, { idx: 0, choice: 1 }, b.token)).status, 409)
  assert.equal((await call('POST', `/api/games/${id}/answer`, { idx: 1, choice: 9 }, b.token)).status, 400)
})

test('Zeitüberschreitung zählt als falsch', async () => {
  const a = await newPlayer('Slow')
  const id = (await call('POST', '/api/games', { opponent: 'bot' }, a.token)).json.id
  const g = (await call('GET', `/api/games/${id}`, undefined, a.token)).json.game
  await call('POST', `/api/games/${id}/pick`, { category: g.options[0] }, a.token)
  await call('GET', `/api/games/${id}/question`, undefined, a.token)
  run('UPDATE answers SET served_at=served_at-60000 WHERE game_id=?', id)
  const a1 = await call('POST', `/api/games/${id}/answer`, { idx: 0, choice: correctIndexFor(id, 1, 0) }, a.token)
  assert.equal(a1.json.correct, false)
})

test('Bot-Spiel läuft bis zum Ende und der Bot zieht automatisch', async () => {
  const a = await newPlayer('Solo')
  const id = (await call('POST', '/api/games', { opponent: 'bot' }, a.token)).json.id
  for (let i = 0; i < 30; i++) {
    const g = (await call('GET', `/api/games/${id}`, undefined, a.token)).json.game
    if (g.status === 'finished') break
    assert.equal(g.turn, 'me')
    await playTurn(a.token, id, 'correct')
  }
  const g = (await call('GET', `/api/games/${id}`, undefined, a.token)).json.game
  assert.equal(g.status, 'finished')
  assert.equal(g.score.me, 18)
  assert.ok(g.score.opp >= 0 && g.score.opp < 18)
  assert.equal(g.opp.is_bot, true)
})

test('Zufälliger Gegner: Warteliste, Match, Umwandlung in Bot, Aufgeben', async () => {
  const a = await newPlayer('R1'), b = await newPlayer('R2'), c = await newPlayer('R3')
  const w = (await call('POST', '/api/games', { opponent: 'random' }, a.token)).json.id
  assert.equal((await call('GET', `/api/games/${w}`, undefined, a.token)).json.game.status, 'waiting')
  const m = (await call('POST', '/api/games', { opponent: 'random' }, b.token)).json.id
  assert.equal(m, w)
  const g = (await call('GET', `/api/games/${w}`, undefined, a.token)).json.game
  assert.deepEqual([g.status, g.turn, g.phase], ['active', 'me', 'pick'])
  // Dritter wartet allein -> Bot
  const w2 = (await call('POST', '/api/games', { opponent: 'random' }, c.token)).json.id
  assert.equal((await call('POST', `/api/games/${w2}/bot`, {}, c.token)).status, 200)
  assert.equal((await call('GET', `/api/games/${w2}`, undefined, c.token)).json.game.status, 'active')
  // Aufgeben -> Gegner gewinnt; Fremde sehen das Spiel nicht
  assert.equal((await call('GET', `/api/games/${w}`, undefined, c.token)).status, 404)
  await call('POST', `/api/games/${w}/resign`, {}, a.token)
  const fin = (await call('GET', `/api/games/${w}`, undefined, b.token)).json.game
  assert.deepEqual([fin.status, fin.winner, fin.end_reason], ['finished', 'me', 'resigned'])
  const list = (await call('GET', '/api/games', undefined, b.token)).json.games
  assert.ok(list.some((x: any) => x.id === w && x.status === 'finished'))
})

test('Gerätewechsel: Export, Transfer-Code (einmalig), optionaler Account + Login', async () => {
  const a = await newPlayer('Mover')
  const exp = (await call('GET', '/api/export', undefined, a.token)).json
  assert.equal(exp.format, 'ratespass-profile')
  assert.equal((await call('GET', '/api/me', undefined, exp.token)).json.player.public_id, a.player.public_id)

  const code = (await call('POST', '/api/transfer', {}, a.token)).json.code
  const red = await call('POST', '/api/transfer/redeem', { code: code.toLowerCase().replace(/(.{4})/, '$1-') })
  assert.equal(red.status, 200)
  assert.equal((await call('GET', '/api/me', undefined, red.json.token)).json.player.name, 'Mover')
  assert.equal((await call('POST', '/api/transfer/redeem', { code })).status, 404, 'Code nur einmal nutzbar')

  assert.equal((await call('POST', '/api/account', { username: 'Mover_1', password: 'kurz' }, a.token)).status, 400)
  assert.equal((await call('POST', '/api/account', { username: 'Mover_1', password: 'langes-passwort' }, a.token)).status, 200)
  const other = await newPlayer('Other')
  assert.equal((await call('POST', '/api/account', { username: 'mover_1', password: 'langes-passwort' }, other.token)).json.error, 'username_taken')
  assert.equal((await call('POST', '/api/login', { username: 'mover_1', password: 'falsch-falsch' })).status, 401)
  const login = await call('POST', '/api/login', { username: 'MOVER_1', password: 'langes-passwort' })
  assert.equal(login.status, 200)
  assert.equal(login.json.player.public_id, a.player.public_id)
  // Logout beendet nur diese Sitzung
  await call('POST', '/api/logout', {}, login.json.token)
  assert.equal((await call('GET', '/api/me', undefined, login.json.token)).status, 401)
  assert.equal((await call('GET', '/api/me', undefined, a.token)).status, 200)
})

test('Konto löschen entfernt Zugang, Kontakte und gibt laufende Spiele auf', async () => {
  const a = await newPlayer('Gone'), b = await newPlayer('Stay')
  await call('POST', '/api/contacts', { public_id: a.player.public_id }, b.token)
  const id = (await call('POST', '/api/games', { opponent: b.player.public_id }, a.token)).json.id
  assert.equal((await call('DELETE', '/api/me', undefined, a.token)).status, 200)
  assert.equal((await call('GET', '/api/me', undefined, a.token)).status, 401)
  assert.equal((await call('GET', `/api/players/${a.player.public_id}`)).status, 404)
  assert.equal((await call('GET', `/api/games/${id}`, undefined, b.token)).json.game.winner, 'me')
  assert.equal((await call('GET', '/api/me', undefined, b.token)).json.contacts.length, 0)
})

test('Community: Einreichung → Moderation → im Spiel; Lizenz-Zustimmung Pflicht; Meldungen deaktivieren Fragen', async () => {
  const a = await newPlayer('Contributor')
  const sub = { lang: 'de', category: 'general', difficulty: 2, text: 'Welcher Planet ist der Sonne am nächsten?', correct: 'Merkur', wrong: ['Venus', 'Mars', 'Erde'] }
  assert.equal((await call('POST', '/api/submissions', sub, a.token)).json.error, 'license_ack_required')
  assert.equal((await call('POST', '/api/submissions', { ...sub, license_ack: true, wrong: ['Venus', 'Mars', 'merkur'] }, a.token)).status, 400)
  assert.equal((await call('POST', '/api/submissions', { ...sub, license_ack: true }, a.token)).status, 200)
  assert.equal((await call('POST', '/api/submissions', { ...sub, license_ack: true }, a.token)).json.error, 'duplicate')
  const row = get<{ id: number; status: string; license: string }>("SELECT * FROM questions WHERE text LIKE 'Welcher Planet ist der Sonne%'")!
  assert.deepEqual([row.status, row.license], ['pending', 'CC-BY-SA-4.0'])
  assert.equal(get('SELECT 1 FROM questions WHERE id=? AND status=?', row.id, 'active'), undefined, 'pending nie im Spiel')

  assert.equal((await call('GET', '/api/admin/queue')).status, 401)
  const adm = { 'x-admin-token': 'test-admin-token' }
  const queue = await call('GET', '/api/admin/queue', undefined, undefined, adm)
  assert.ok(queue.json.questions.some((q: any) => q.id === row.id))
  assert.equal((await call('POST', `/api/admin/questions/${row.id}`, { action: 'approve', patch: { difficulty: 1 } }, undefined, adm)).status, 200)
  assert.equal(get<{ status: string }>('SELECT status FROM questions WHERE id=?', row.id)!.status, 'active')
  assert.equal((await call('GET', '/api/submissions', undefined, a.token)).json.submissions[0].status, 'active')

  // 3 Meldungen verschiedener Spieler deaktivieren eine aktive Frage automatisch (echter Codepfad über /report)
  const target = get<{ id: number }>("SELECT id FROM questions WHERE lang='en' AND status='active' LIMIT 1")!.id
  for (let i = 0; i < 3; i++) {
    const p = await newPlayer('Reporter' + i)
    const gid = (await call('POST', '/api/games', { opponent: 'bot', lang: 'en' }, p.token)).json.game ?? (await call('POST', '/api/games', { opponent: 'bot', lang: 'en' }, p.token)).json.id
    const g = (await call('GET', `/api/games/${gid}`, undefined, p.token)).json.game
    await call('POST', `/api/games/${gid}/pick`, { category: g.options[0] }, p.token)
    await call('GET', `/api/games/${gid}/question`, undefined, p.token)
    run('UPDATE round_questions SET question_id=? WHERE game_id=? AND round=1 AND idx=0', target, gid)
    await call('POST', `/api/games/${gid}/answer`, { idx: 0, choice: 0 }, p.token)
    const rep = await call('POST', `/api/games/${gid}/report`, { round: 1, idx: 0, reason: 'falsch' }, p.token)
    assert.equal(rep.status, 200)
    assert.equal(get<{ status: string }>('SELECT status FROM questions WHERE id=?', target)!.status, i < 2 ? 'active' : 'disabled')
  }
  // Nicht beantwortete Fragen lassen sich nicht melden
  const q = await newPlayer('Nosy')
  const gid2 = (await call('POST', '/api/games', { opponent: 'bot' }, q.token)).json.id
  assert.equal((await call('POST', `/api/games/${gid2}/report`, { round: 1, idx: 0 }, q.token)).status, 400)
})

test('Dataset-Export und Lizenzübersicht enthalten Quelle + Lizenz je Frage', async () => {
  const lic = (await call('GET', '/api/licenses')).json
  assert.ok(lic.sources.every((s: any) => s.license_url?.startsWith('https://creativecommons.org')))
  const ds = await call('GET', '/api/dataset.jsonl')
  const lines = String(ds.json).trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.length > 100)
  assert.ok(lines.every((l) => l.license && l.source && l.group))
  assert.ok(lines.every((l) => !('submitted_by' in l)), 'keine personenbezogenen Felder im Dataset')
})

test('Statische Auslieferung: Path-Traversal blockiert, SPA-Route für Einladungslinks, Security-Header', async () => {
  const r = await fetch(t.base + '/%2e%2e/package.json')
  assert.equal(r.status, 404)
  const inv = await fetch(t.base + '/i/ABCD2345')
  assert.ok([200, 404].includes(inv.status))
  assert.match(inv.headers.get('content-security-policy') ?? '', /default-src 'self'/)
  assert.equal((await fetch(t.base + '/healthz')).status, 200)
})
