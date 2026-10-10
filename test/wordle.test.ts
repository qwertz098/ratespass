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

test('Kein Bonus-Wordle mehr: nur daily und group; alte Bonus-Spiele sind per Migration gelöscht', async () => {
  const p = await newPlayer('Bonus Spieler')
  assert.equal((await start(p.token, 'bonus', 'en')).status, 400)
  assert.equal((await start(p.token, 'chaos', 'en')).status, 400); assert.equal((await start(p.token, 'daily', 'xx')).status, 400)
  assert.equal((await call('GET', '/api/wordle', undefined, p.token)).json.langs.every((l: any) => !('bonus' in l)), true)
  assert.equal(get<{ n: number }>("SELECT COUNT(*) n FROM wordle_games WHERE kind='bonus'")!.n, 0)
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

test('Gruppen-Dauerwertung: Gesamt/Monat/Woche/Tag, ausgelassene Tage = 0 Punkte und „verpasst“, Beitritt zählt ab Beitrittstag, Austritt/Wiedereintritt startet bei 0, Raster erst nach eigenem Spielende', async () => {
  const [a, b, c] = [await newPlayer('Dauer Eins'), await newPlayer('Dauer Zwei'), await newPlayer('Dauer Drei')]
  const g = (await call('POST', '/api/wordle/groups', { name: 'Dauer', lang: 'en' }, a.token)).json.group
  for (const p of [b, c]) await call('POST', '/api/wordle/groups/join', { code: g.code }, p.token)
  const pid = (p: any) => get<{ id: number }>('SELECT id FROM players WHERE public_id=?', p.player.public_id)!.id
  const today = wordle.dayOf(), ago = (n: number) => wordle.addDays(today, -n)
  // Mitgliedschaften „früher“ beigetreten: a und b vor 10 Tagen, c erst vor 2 Tagen
  run('UPDATE wordle_members SET joined_at=? WHERE group_id=? AND player_id IN (?,?)', Date.now() - 10 * 86_400_000, g.id, pid(a), pid(b))
  run('UPDATE wordle_members SET joined_at=? WHERE group_id=? AND player_id=?', Date.now() - 2 * 86_400_000, g.id, pid(c))
  const put = (p: any, day: string, status: string, n: number, points: number) => run("INSERT INTO wordle_games(player_id,kind,lang,day,group_id,word,guesses,status,points,started_at,last_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", pid(p), 'group', 'en', day, g.id, 'apple', JSON.stringify(Array(n).fill('crane')), status, points, 1, 1, 1)
  for (const d of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) put(a, ago(d), 'won', 3, 4) // a spielt jeden Tag (4 Punkte)
  for (const d of [1, 2, 20]) put(b, ago(d), 'won', 2, 5) // b nur gestern, vorgestern (und vor 20 Tagen – vor Beitritt, zählt trotzdem als Spiel im Fenster „gesamt“)
  put(c, ago(1), 'lost', 6, 0)
  const board = async (tok: string, scope: string) => (await call('GET', `/api/wordle/groups/${g.id}/board?scope=${scope}`, undefined, tok)).json
  const all_ = await board(a.token, 'all')
  assert.equal(all_.scope, 'all'); assert.deepEqual((await call('GET', `/api/wordle/groups/${g.id}/board`, undefined, a.token)).json.scope, 'all', 'Standard ist die Gesamtwertung')
  assert.deepEqual(all_.rows.map((r: any) => [r.name, r.points, r.played, r.missed]), [['Dauer Eins', 40, 10, 0], ['Dauer Zwei', 15, 3, 8], ['Dauer Drei', 0, 1, 1]])
  const week = await board(a.token, 'week'); assert.deepEqual(week.rows.map((r: any) => [r.name, r.points, r.missed]), [['Dauer Eins', 24, 0], ['Dauer Zwei', 10, 4], ['Dauer Drei', 0, 1]], 'Wochenfenster: 6 vergangene Tage + heute')
  assert.equal((await board(a.token, 'month')).rows[1].points, 15)
  const day = await board(a.token, 'day'); assert.deepEqual(day.rows.map((r: any) => r.points), [0, 0, 0]); assert.equal(day.rows.every((r: any) => r.today === null && r.missed === 0), true, 'heute zählt nicht als verpasst')
  assert.equal(all_.rows[0].streak, 10); assert.equal(all_.rows[1].streak, 2)
  // Raster: erst sichtbar, wenn man selbst heute fertig ist
  const wa = (await start(a.token, 'group', 'en', g.id)).json.game; await guess(a.token, wa.id, wordOf(wa.id))
  const wb = (await start(b.token, 'group', 'en', g.id)).json.game
  assert.deepEqual((await call('GET', `/api/wordle/groups/${g.id}`, undefined, b.token)).json.group.members.map((m: any) => m.grid), [undefined, undefined, undefined], 'b hat noch nicht fertig gespielt')
  await guess(b.token, wb.id, wordOf(wb.id))
  const seen = (await call('GET', `/api/wordle/groups/${g.id}`, undefined, b.token)).json.group.members
  assert.deepEqual(seen.map((m: any) => m.grid), [['ccccc'], ['ccccc'], undefined]); assert.equal(JSON.stringify(seen).includes(wordOf(wb.id)), false, 'nie Buchstaben')
  const cv = (await call('GET', `/api/wordle/groups/${g.id}`, undefined, c.token)).json.group.members; assert.deepEqual(cv.map((m: any) => m.grid), [undefined, undefined, undefined], 'c hat nicht gespielt → sieht keine Raster')
  assert.equal((await call('GET', '/api/wordle', undefined, b.token)).json.groups[0].rank, 2)
  // Austritt und Wiedereintritt: Punkte bleiben nicht erhalten
  assert.equal((await call('POST', `/api/wordle/groups/${g.id}/leave`, {}, b.token)).status, 200)
  await call('POST', '/api/wordle/groups/join', { code: g.code }, b.token)
  const again = (await board(b.token, 'all')).rows.find((r: any) => r.name === 'Dauer Zwei'); assert.deepEqual([again.points, again.played, again.missed], [0, 0, 0])
})

test('Ergebnis teilen: nur eigenes beendetes Tages-Wordle, nur an Kontakt oder eigene Gruppe, Raster erst nach eigenem Spielende, Aufräumen', async () => {
  const [a, b, c, x] = [await newPlayer('Teiler'), await newPlayer('Empfänger'), await newPlayer('Gruppenfreund'), await newPlayer('Fremder')]
  const share = (tok: string, body: any) => call('POST', '/api/wordle/share', body, tok)
  const ga = (await start(a.token, 'daily', 'en')).json.game
  assert.equal((await share(a.token, { game_id: ga.id, public_id: b.player.public_id })).status, 409, 'laufendes Spiel nicht teilbar')
  const wr = others('en', wordOf(ga.id), 1); await guess(a.token, ga.id, wr[0]); await guess(a.token, ga.id, wordOf(ga.id))
  assert.equal((await share(a.token, { game_id: ga.id })).status, 400, 'ohne Ziel'); assert.equal((await share(a.token, { game_id: ga.id, public_id: b.player.public_id, group_id: 1 })).status, 400, 'nicht beides')
  assert.equal((await share(a.token, { game_id: ga.id, public_id: b.player.public_id })).status, 404, 'kein Kontakt')
  await call('POST', '/api/contacts', { public_id: b.player.public_id }, a.token); await call('POST', '/api/contacts', { public_id: c.player.public_id }, a.token)
  assert.equal((await share(b.token, { game_id: ga.id, public_id: a.player.public_id })).status, 404, 'fremdes Spiel')
  assert.equal((await share(a.token, { game_id: ga.id, public_id: b.player.public_id })).status, 200)
  assert.equal((await share(a.token, { game_id: ga.id, public_id: b.player.public_id })).status, 200); assert.equal(get<{ n: number }>('SELECT COUNT(*) n FROM wordle_shares WHERE to_pid IS NOT NULL')!.n, 1, 'erneutes Teilen überschreibt')
  // Hub zeigt Ungesehenes; Eingang: Raster gesperrt, solange B das Tages-Wordle nicht beendet hat
  assert.equal((await call('GET', '/api/wordle', undefined, b.token)).json.inbox_unseen, 1)
  const i1 = (await call('GET', '/api/wordle/inbox', undefined, b.token)).json.items
  assert.deepEqual(i1.map((s: any) => [s.name, s.status, s.guesses, s.locked, s.grid]), [['Teiler', 'won', 2, true, undefined]])
  assert.equal((await call('GET', '/api/wordle', undefined, b.token)).json.inbox_unseen, 0, 'Eingang öffnen markiert als gesehen')
  const gb = (await start(b.token, 'daily', 'en')).json.game; await guess(b.token, gb.id, wordOf(gb.id))
  const i2 = (await call('GET', '/api/wordle/inbox', undefined, b.token)).json.items[0]; assert.equal(i2.locked, false); assert.equal(i2.grid.length, 2); assert.match(i2.grid[1], /^c{5}$/); assert.equal(JSON.stringify(i2).includes(wordOf(ga.id)), false, 'nie das Wort')
  // Gruppe: Feed für Mitglieder, Nichtmitglieder gehen leer aus
  const grp = (await call('POST', '/api/wordle/groups', { name: 'Teilen', lang: 'en' }, a.token)).json.group
  await call('POST', '/api/wordle/groups/join', { code: grp.code }, c.token)
  assert.equal((await share(b.token, { game_id: gb.id, group_id: grp.id })).status, 404, 'B ist kein Mitglied')
  assert.equal((await share(a.token, { game_id: ga.id, group_id: grp.id })).status, 200)
  const feed0 = (await call('GET', `/api/wordle/groups/${grp.id}`, undefined, c.token)).json.group.feed
  assert.deepEqual(feed0.map((s: any) => [s.name, s.locked]), [['Teiler', true]], 'C hat das Tages-Wordle noch nicht gespielt')
  const gc = (await start(c.token, 'daily', 'en')).json.game; await guess(c.token, gc.id, wordOf(gc.id))
  assert.equal((await call('GET', `/api/wordle/groups/${grp.id}`, undefined, c.token)).json.group.feed[0].locked, false)
  assert.equal((await call('GET', `/api/wordle/groups/${grp.id}`, undefined, a.token)).json.group.feed[0].grid.length, 2, 'der Absender sieht sein eigenes Raster')
  // Gruppenspiele sind kein Tages-Wordle
  const gg = (await start(a.token, 'group', 'en', grp.id)).json.game; await guess(a.token, gg.id, wordOf(gg.id))
  assert.equal((await share(a.token, { game_id: gg.id, public_id: b.player.public_id })).status, 404)
  // Verlassen entfernt die eigenen Shares an die Gruppe; Alter und Profil-Löschen räumen auf
  await call('POST', `/api/wordle/groups/${grp.id}/leave`, {}, a.token)
  assert.equal(get<{ n: number }>('SELECT COUNT(*) n FROM wordle_shares WHERE group_id IS NOT NULL')!.n, 0)
  run('UPDATE wordle_shares SET created_at=?', Date.now() - 15 * 86_400_000); wordle.sweepShares()
  assert.equal(get<{ n: number }>('SELECT COUNT(*) n FROM wordle_shares')!.n, 0)
  await share(a.token, { game_id: ga.id, public_id: c.player.public_id }); wordle.erasePlayerWordle(get<{ id: number }>('SELECT id FROM players WHERE public_id=?', a.player.public_id)!.id)
  assert.equal(get<{ n: number }>('SELECT COUNT(*) n FROM wordle_shares')!.n, 0)
  void x
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

test('Erinnerung um 9 Uhr lokale Zeit: nur mit Opt-in, einmal je Tag, nicht wenn schon gespielt, Zeitzonen und Gruppen', async () => {
  const [a, b] = [await newPlayer('Push Frühaufsteher'), await newPlayer('Push New York')]
  const push = (tok: string, key: string, on: boolean, tz?: string) => call('POST', '/api/wordle/push', { key, on, tz }, tok)
  assert.equal((await push(a.token, 'daily:fr', true, 'Europe/Berlin')).status, 400); assert.equal((await push(a.token, 'daily:de', true, 'Mars/Olympus')).status, 400, 'ohne bekannte Zeitzone')
  assert.equal((await push(a.token, 'g:99999', true, 'Europe/Berlin')).status, 404, 'nur eigene Gruppen')
  assert.equal((await push(a.token, 'daily:de', true, 'Europe/Berlin')).status, 200); assert.equal((await push(b.token, 'daily:en', true, 'America/New_York')).status, 200)
  const grp = (await call('POST', '/api/wordle/groups', { name: 'Morgenrunde', lang: 'en' }, a.token)).json.group
  assert.equal((await push(a.token, `g:${grp.id}`, true)).status, 200)
  assert.equal((await call('GET', '/api/wordle', undefined, a.token)).json.langs.find((l: any) => l.lang === 'de').push, true)
  const pidA = get<{ id: number }>('SELECT id FROM players WHERE public_id=?', a.player.public_id)!.id
  const sent: { pid: number; title: string; body: string; url: string }[] = []
  const send = (pid: number, m: any) => sent.push({ pid, ...m })
  const at = (iso: string) => Date.parse(iso)
  assert.equal(wordle.wordlePushTick(at('2026-10-12T06:30:00Z'), send), 0, 'Berlin 8:30, New York 2:30 – noch nicht')
  assert.equal(wordle.wordlePushTick(at('2026-10-12T07:30:00Z'), send), 2, 'Berlin 9:30: Daily DE + Gruppe')
  assert.deepEqual(sent.map((s) => s.url).sort(), ['/#/wordle', `/#/wordle/group/${grp.id}`].sort()); assert.ok(sent.some((s) => /Wordle/.test(s.title)) && sent.find((s) => s.url === '/#/wordle')!.body.includes('Deutsch'))
  assert.equal(wordle.wordlePushTick(at('2026-10-12T07:50:00Z'), send), 0, 'nur einmal je Tag')
  assert.equal(wordle.wordlePushTick(at('2026-10-12T13:30:00Z'), send), 1, 'New York 9:30 EDT'); assert.equal(sent.at(-1)!.pid, get<{ id: number }>('SELECT id FROM players WHERE public_id=?', b.player.public_id)!.id)
  assert.equal(wordle.wordlePushTick(at('2026-10-13T07:30:00Z'), send), 2, 'am nächsten Tag wieder')
  // schon gespielt (beendet) → keine Erinnerung für dieses Wordle
  const day = wordle.dayOf(at('2026-10-14T07:30:00Z'))
  run("INSERT INTO wordle_games(player_id,kind,lang,day,group_id,word,guesses,status,points,started_at,last_at,finished_at) VALUES(?,'daily','de',?,0,'apple','[\"apple\"]','won',6,1,1,1)", pidA, day)
  assert.equal(wordle.wordlePushTick(at('2026-10-14T07:30:00Z'), send), 1, 'Daily DE entfällt, Gruppe bleibt')
  // ausschalten
  await push(a.token, `g:${grp.id}`, false); await push(a.token, 'daily:de', false)
  assert.equal(wordle.wordlePushTick(at('2026-10-15T07:30:00Z'), send), 0)
})

test('Admin: Statistik je Sprache und Tag, Wortlisten sperren/freigeben, Wort für einen künftigen Tag festlegen', async () => {
  const hdr = { 'x-forwarded-for': '203.0.113.77' }
  assert.equal((await call('GET', '/api/admin/wordle', undefined, undefined, hdr)).status, 401, 'ohne Anmeldung gesperrt')
  config.trustProxy = true
  const cookie = ((await call('POST', '/api/admin/login', { token: config.adminToken }, undefined, hdr)).headers.get('set-cookie') ?? '').split(';')[0]
  const admin = (method: string, path: string, body?: unknown) => call(method, path, body, undefined, { ...hdr, cookie, 'sec-fetch-site': 'same-origin' })
  const [p1, p2] = [await newPlayer('Statistik Eins'), await newPlayer('Statistik Zwei')]
  for (const [p, tries] of [[p1, 2], [p2, 7]] as const) {
    const g = (await start(p.token, 'daily', 'en')).json.game, ans = wordOf(g.id)
    if (tries === 2) { await guess(p.token, g.id, others('en', ans, 1)[0]); await guess(p.token, g.id, ans) } else for (const w of others('en', ans, 6)) await guess(p.token, g.id, w)
  }
  const o = (await admin('GET', '/api/admin/wordle')).json
  const en = o.langs.find((l: any) => l.lang === 'en'), today = en.daily[0]
  assert.equal(today.day, o.today); assert.ok(today.plays >= today.finished && today.finished >= 2 && today.won >= 1 && today.lost >= 1)
  assert.ok(today.dist[1] >= 1, 'mindestens ein Spieler im 2. Versuch gelöst'); assert.ok(today.word && today.win_rate !== null)
  assert.ok(en.words.solutions >= 1000 && en.words.valid > en.words.solutions); assert.ok(o.players.active_7 >= 2 && o.groups.total >= 0); assert.equal(en.upcoming.length, 7)
  // Wörter: suchen, sperren, freigeben
  const w = others('en', '', 1)[0]
  assert.equal((await admin('POST', '/api/admin/wordle/ban', { lang: 'en', word: 'zzzzz' })).status, 404)
  assert.equal((await admin('POST', '/api/admin/wordle/ban', { lang: 'en', word: w, banned: true })).status, 200)
  const fresh = await newPlayer('Bann Spieler')
  assert.equal((await guess(fresh.token, (await start(fresh.token, 'daily', 'en')).json.game.id, w)).status, 422, 'gesperrtes Wort ist keine gültige Eingabe')
  assert.equal((await admin('GET', '/api/admin/wordle/words?lang=en')).json.words.some((x: any) => x.word === w && x.banned === 1), true)
  assert.equal((await admin('GET', `/api/admin/wordle/words?lang=en&q=${w.slice(0, 3)}`)).json.words.some((x: any) => x.word === w), true)
  await admin('POST', '/api/admin/wordle/ban', { lang: 'en', word: w, banned: false })
  // Wort festlegen: nur für Tage ohne Spiel, nur gültige Wörter
  const tomorrow = wordle.addDays(wordle.dayOf(), 1), pick = others('en', '', 3)[2]
  assert.equal((await admin('POST', '/api/admin/wordle/force', { lang: 'en', day: wordle.dayOf(), word: pick })).status, 409, 'heute läuft schon')
  assert.equal((await admin('POST', '/api/admin/wordle/force', { lang: 'en', day: wordle.addDays(wordle.dayOf(), -1), word: pick })).status, 400, 'nicht rückwirkend')
  assert.equal((await admin('POST', '/api/admin/wordle/force', { lang: 'en', day: tomorrow, word: 'zzzzz' })).status, 404)
  assert.equal((await admin('POST', '/api/admin/wordle/force', { lang: 'en', day: tomorrow, word: pick })).status, 200)
  assert.equal(wordle.wordFor('en', tomorrow, 'global'), pick)
  assert.deepEqual((await admin('GET', '/api/admin/wordle')).json.langs.find((l: any) => l.lang === 'en').upcoming[1], { day: tomorrow, word: pick, forced: true })
  assert.equal((await admin('POST', '/api/admin/wordle/reload', {})).status, 200)
})
