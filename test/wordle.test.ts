import test from 'node:test'
import assert from 'node:assert/strict'
import { boot, get, all, run } from './helpers.ts'

const t = await boot()
const { call, newPlayer } = t
const { config } = await import('../server/config.ts')
const wordle = await import('../server/wordle.ts')
config.wordle.minGuessMs = 0
test.after(() => t.close())

const wordOf = (gameId: number) => get<{ word: string }>('SELECT word FROM wordle_games WHERE id=?', gameId)!.word
const others = (lang: string, not: string, n: number) => all<{ word: string }>('SELECT word FROM wordle_words WHERE lang=? AND word<>? AND banned=0 ORDER BY word LIMIT ?', lang, not, n).map((r) => r.word)
const start = (tok: string, kind: string, lang = 'en', group_id?: number) => call('POST', '/api/wordle/games', { kind, lang, group_id }, tok)
const guess = (tok: string, id: number, word: string) => call('POST', `/api/wordle/games/${id}/guess`, { word }, tok)

test('Auswertung: richtig/vorhanden/nicht vorhanden, Doppelbuchstaben zählen nur so oft, wie sie im Wort stehen', () => {
  assert.equal(wordle.evaluate('abide', 'abide'), 'ccccc')
  assert.equal(wordle.evaluate('speed', 'abide'), 'aapap')
  assert.equal(wordle.evaluate('eerie', 'apple'), 'aaaac', 'nur ein e im Ziel, an der letzten Stelle')
  assert.equal(wordle.evaluate('llama', 'hello'), 'ppaaa', 'zwei l im Ziel → beide l gelb')
  assert.equal(wordle.evaluate('mause', 'baume'), 'pccac')
})

test('Tageswort: für alle gleich, je Sprache eigen, gespeichert; Spielverlauf mit Gewinn, Verlust und verdecktem Wort', async () => {
  const [a, b] = [await newPlayer('Wordle Eins'), await newPlayer('Wordle Zwei')]
  const ga = (await start(a.token, 'daily', 'en')).json.game, gb = (await start(b.token, 'daily', 'en')).json.game
  assert.equal(wordOf(ga.id), wordOf(gb.id), 'alle spielen dasselbe Wort')
  assert.equal(get<{ n: number }>("SELECT COUNT(*) n FROM wordle_daily WHERE lang='en' AND scope='global' AND day=?", ga.day)!.n, 1)
  assert.ok(get('SELECT 1 FROM wordle_words WHERE lang=? AND word=? AND solution=1', 'en', wordOf(ga.id)), 'Tageswort stammt aus der Lösungsliste')
  assert.equal((await start(a.token, 'daily', 'en')).json.game.id, ga.id, 'ein Spiel je Tag und Sprache')
  const gd = (await start(a.token, 'daily', 'de')).json.game; assert.notEqual(gd.id, ga.id); assert.ok(/^[a-z]{5}$/.test(wordOf(gd.id)))
  assert.ok(!('answer' in ga) && ga.status === 'playing' && ga.max === 6)
  // Eingaben prüfen
  assert.equal((await guess(a.token, ga.id, 'abc')).status, 400); assert.equal((await guess(a.token, ga.id, 'zzzzz')).status, 422, 'nicht in der Liste')
  assert.equal((await guess(b.token, ga.id, 'apple')).status, 404, 'fremdes Spiel')
  const ans = wordOf(ga.id), wrong = others('en', ans, 6)
  const r1 = await guess(a.token, ga.id, wrong[0]); assert.equal(r1.status, 200); assert.equal(r1.json.game.guesses.length, 1); assert.equal(r1.json.game.guesses[0].marks.length, 5); assert.ok(!('answer' in r1.json.game))
  assert.equal((await call('GET', `/api/wordle/games/${ga.id}`, undefined, a.token)).json.game.answer, undefined, 'Lösung bleibt bis zum Ende geheim')
  const win = await guess(a.token, ga.id, ans); assert.equal(win.json.game.status, 'won'); assert.equal(win.json.game.points, 5, 'Treffer im 2. Versuch = 5 Punkte'); assert.equal(win.json.game.answer, ans)
  assert.equal((await guess(a.token, ga.id, wrong[1])).status, 409, 'Spiel ist beendet')
  // Verlieren nach 6 Fehlversuchen
  const gl = (await start(b.token, 'daily', 'de')).json.game, dans = wordOf(gl.id)
  let last: any
  for (const w of others('de', dans, 6)) last = await guess(b.token, gl.id, w)
  assert.equal(last.json.game.status, 'lost'); assert.equal(last.json.game.points, 0); assert.equal(last.json.game.answer, dans)
})

test('Bonus: ein persönliches Zusatz-Wordle je Tag und Sprache, nicht das Tageswort', async () => {
  const p = await newPlayer('Bonus Spieler')
  const d = (await start(p.token, 'daily', 'en')).json.game, b1 = (await start(p.token, 'bonus', 'en')).json.game
  assert.notEqual(wordOf(d.id), wordOf(b1.id)); assert.equal((await start(p.token, 'bonus', 'en')).json.game.id, b1.id, 'nur ein Bonus je Tag')
  assert.notEqual((await start(p.token, 'bonus', 'de')).json.game.id, b1.id, 'anderes Sprache = eigener Bonus')
  assert.equal((await start(p.token, 'chaos', 'en')).status, 400); assert.equal((await start(p.token, 'daily', 'xx')).status, 400)
})

test('Gruppen: eigenes Tageswort je Gruppe, Beitritt per Code, beliebig viele, Eigentümerwechsel, Auflösen', async () => {
  const [o, m1, m2, x] = [await newPlayer('Gruppen Chef'), await newPlayer('Mitglied Eins'), await newPlayer('Mitglied Zwei'), await newPlayer('Draußen')]
  const g1 = (await call('POST', '/api/wordle/groups', { name: 'Büro', lang: 'en' }, o.token)).json.group
  assert.equal(g1.is_owner, true); assert.match(g1.code, /^[A-Z2-9]{8}$/)
  assert.equal((await call('POST', '/api/wordle/groups', { name: '<b>', lang: 'en' }, o.token)).status, 400); assert.equal((await call('POST', '/api/wordle/groups', { name: 'Ok', lang: 'fr' }, o.token)).status, 400)
  assert.equal((await call('GET', `/api/wordle/groups/${g1.id}`, undefined, x.token)).status, 404, 'Nichtmitglieder sehen nichts')
  assert.equal((await call('POST', '/api/wordle/groups/join', { code: 'NOPE1234' }, m1.token)).status, 404)
  for (const p of [m1, m2]) assert.equal((await call('POST', '/api/wordle/groups/join', { code: g1.code.toLowerCase() }, p.token)).status, 200)
  assert.equal((await call('POST', '/api/wordle/groups/join', { code: g1.code }, m1.token)).json.group.members.length, 3, 'zweimal beitreten ändert nichts')
  const g2 = (await call('POST', '/api/wordle/groups', { name: 'Familie', lang: 'en' }, o.token)).json.group
  const w1 = (await start(o.token, 'group', 'en', g1.id)).json.game, w2 = (await start(o.token, 'group', 'en', g2.id)).json.game
  assert.equal(get<{ n: number }>("SELECT COUNT(*) n FROM wordle_daily WHERE scope IN (?,?)", `g:${g1.id}`, `g:${g2.id}`)!.n, 2, 'jede Gruppe hat ihr eigenes Tageswort')
  const gw = (await start(m1.token, 'group', 'en', g1.id)).json.game
  assert.equal(wordOf(gw.id), wordOf(w1.id), 'innerhalb der Gruppe dasselbe Wort'); assert.equal(wordle.dayOf(), w2.day)
  assert.equal((await start(x.token, 'group', 'en', g1.id)).status, 404)
  // Punkte und Bestenliste der Gruppe
  await guess(o.token, w1.id, wordOf(w1.id)) // Chef: 6 Punkte im 1. Versuch
  const wr = others('en', wordOf(gw.id), 2); await guess(m1.token, gw.id, wr[0]); await guess(m1.token, gw.id, wordOf(gw.id)) // 5 Punkte
  const board = (await call('GET', `/api/wordle/groups/${g1.id}/board?scope=day`, undefined, m2.token)).json
  assert.deepEqual(board.rows.map((r: any) => [r.rank, r.name, r.points]), [[1, 'Gruppen Chef', 6], [2, 'Mitglied Eins', 5], [3, 'Mitglied Zwei', 0]])
  const gv = (await call('GET', `/api/wordle/groups/${g1.id}`, undefined, m2.token)).json.group
  assert.deepEqual(gv.members.map((m: any) => [m.name, m.today?.status ?? null]), [['Gruppen Chef', 'won'], ['Mitglied Eins', 'won'], ['Mitglied Zwei', null]])
  const hub = (await call('GET', '/api/wordle', undefined, o.token)).json; assert.equal(hub.groups.length, 2); assert.equal(hub.langs.find((l: any) => l.lang === 'en').streak, 0)
  // Eigentümer geht: nächstes Mitglied übernimmt, seine Spiele entfallen; zuletzt Gruppe weg
  assert.equal((await call('DELETE', `/api/wordle/groups/${g1.id}`, undefined, m1.token)).status, 404, 'nur der Eigentümer löst auf')
  assert.equal((await call('POST', `/api/wordle/groups/${g1.id}/leave`, {}, o.token)).status, 200)
  assert.equal((await call('GET', `/api/wordle/groups/${g1.id}`, undefined, m1.token)).json.group.is_owner, true)
  assert.equal(all('SELECT 1 FROM wordle_games WHERE group_id=? AND player_id=?', g1.id, (get<{ id: number }>('SELECT id FROM players WHERE public_id=?', o.player.public_id))!.id).length, 0)
  assert.equal((await call('DELETE', `/api/wordle/groups/${g1.id}`, undefined, m1.token)).status, 200)
  assert.equal(all('SELECT 1 FROM wordle_groups WHERE id=?', g1.id).length + all('SELECT 1 FROM wordle_games WHERE group_id=?', g1.id).length + all('SELECT 1 FROM wordle_daily WHERE scope=?', `g:${g1.id}`).length, 0)
})

test('Duell: Einladung als Gruppe, Beitritt per Code', async () => {
  const [a, b] = [await newPlayer('Duell Eins'), await newPlayer('Duell Zwei')]
  assert.equal((await call('POST', '/api/wordle/duel', { public_id: 'ZZZZZZZZ', lang: 'en' }, a.token)).status, 404)
  assert.equal((await call('POST', '/api/wordle/duel', { public_id: a.player.public_id, lang: 'en' }, a.token)).status, 404, 'nicht gegen sich selbst')
  const d = (await call('POST', '/api/wordle/duel', { public_id: b.player.public_id, lang: 'de' }, a.token)).json.group
  assert.match(d.name, /Duell Eins/); assert.equal(d.members.length, 1, 'Eingeladene treten selbst bei')
  assert.equal((await call('POST', '/api/wordle/groups/join', { code: d.code }, b.token)).json.group.members.length, 2)
})

test('Bestenliste global: nur Teilnehmer mit Bestenlisten-Namen; Zeiträume; Streak', async () => {
  const [a, b, c] = [await newPlayer('Rangliste Eins'), await newPlayer('Rangliste Zwei'), await newPlayer('Heimlich')]
  for (const [p, name] of [[a, 'Wordle König'], [b, 'Wordle Prinz']] as const) await call('POST', '/api/leaderboard/join', { name }, p.token)
  const play = async (p: { token: string }, tries: number) => {
    const g = (await start(p.token, 'daily', 'en')).json.game, ans = wordOf(g.id)
    for (const w of others('en', ans, tries - 1)) await guess(p.token, g.id, w)
    await guess(p.token, g.id, ans)
  }
  await play(a, 1); await play(b, 3); await play(c, 1)
  const bd = (await call('GET', '/api/wordle/board?lang=en&scope=week', undefined, b.token)).json
  assert.deepEqual(bd.top.map((r: any) => [r.rank, r.name, r.points]), [[1, 'Wordle König', 6], [2, 'Wordle Prinz', 4]], 'Heimlich (kein Opt-in) fehlt')
  assert.equal(bd.me.rank, 2); assert.equal(bd.me.participating, true); assert.equal(bd.top[0].streak, 1)
  assert.equal((await call('GET', '/api/wordle/board?lang=en', undefined, c.token)).json.me.participating, false)
  assert.equal((await call('GET', '/api/wordle/board?lang=de&scope=all', undefined, a.token)).json.top.length, 0, 'andere Sprache = eigene Liste')
  assert.equal((await call('GET', '/api/wordle/board?lang=xx', undefined, a.token)).status, 400)
  // Zeiträume: ein Spiel von vor 10 Tagen zählt nicht zur Woche, wohl zum Monat
  const pid = get<{ id: number }>('SELECT id FROM players WHERE public_id=?', b.player.public_id)!.id
  run("INSERT INTO wordle_games(player_id,kind,lang,day,group_id,word,guesses,status,points,started_at,last_at,finished_at) VALUES(?,?,?,?,0,'apple','[\"apple\"]','won',6,1,1,1)", pid, 'daily', 'en', wordle.addDays(wordle.dayOf(), -10))
  const week = (await call('GET', '/api/wordle/board?lang=en&scope=week', undefined, b.token)).json.top.find((r: any) => r.name === 'Wordle Prinz').points
  const month = (await call('GET', '/api/wordle/board?lang=en&scope=month', undefined, b.token)).json.top.find((r: any) => r.name === 'Wordle Prinz').points
  assert.deepEqual([week, month], [4, 10])
  // Streak: 3 gelöste Tage in Folge bis gestern + heute gelöst
  const sid = get<{ id: number }>('SELECT id FROM players WHERE public_id=?', a.player.public_id)!.id
  for (const d of [1, 2, 3]) run("INSERT INTO wordle_games(player_id,kind,lang,day,group_id,word,guesses,status,points,started_at,last_at,finished_at) VALUES(?,?,?,?,0,'apple','[\"apple\"]','won',6,1,1,1)", sid, 'daily', 'en', wordle.addDays(wordle.dayOf(), -d))
  assert.equal(wordle.streakOf(sid, 'en'), 4)
})

test('Profil löschen entfernt Wordle-Spiele, Mitgliedschaften und leere Gruppen', async () => {
  const p = await newPlayer('Wird gelöscht')
  await start(p.token, 'daily', 'en'); const g = (await call('POST', '/api/wordle/groups', { name: 'Weg damit', lang: 'de' }, p.token)).json.group
  assert.equal((await call('DELETE', '/api/me', undefined, p.token)).status, 200)
  const pid = get<{ id: number }>('SELECT id FROM players WHERE public_id=?', p.player.public_id)!.id
  assert.equal(all('SELECT 1 FROM wordle_games WHERE player_id=?', pid).length + all('SELECT 1 FROM wordle_members WHERE player_id=?', pid).length + all('SELECT 1 FROM wordle_groups WHERE id=?', g.id).length, 0)
})
