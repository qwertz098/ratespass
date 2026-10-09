import test from 'node:test'
import assert from 'node:assert/strict'
import { boot, get, all, run, importBatch } from './helpers.ts'

const t = await boot()
test.after(() => t.close())
const { call, newPlayer } = t
const adm = { 'x-admin-token': 'test-admin-token' }

/** Spielt eine Frage an und beantwortet sie; gibt Spiel-ID und die Frage-ID (de) zurück. */
async function answeredGame(token: string, questionId?: number) {
  const gid = (await call('POST', '/api/games', { opponent: 'bot', lang: 'de' }, token)).json.id
  const g = (await call('GET', `/api/games/${gid}`, undefined, token)).json.game
  await call('POST', `/api/games/${gid}/pick`, { category: g.options[0] }, token)
  await call('GET', `/api/games/${gid}/question`, undefined, token)
  if (questionId) run('UPDATE round_questions SET question_id=? WHERE game_id=? AND round=1 AND idx=0', questionId, gid)
  await call('POST', `/api/games/${gid}/answer`, { idx: 0, choice: 0 }, token)
  return gid
}

test('Nur vom Admin bestimmte Reviewer dürfen Überarbeitungen melden', async () => {
  const p = await newPlayer('Prüfer')
  const target = get<{ id: number }>("SELECT id FROM questions WHERE lang='de' AND status='active' LIMIT 1")!.id
  const gid = await answeredGame(p.token, target)
  const body = { round: 1, idx: 0, part: 'answers', kind: 'wrong', note: 'Antwort B stimmt auch' }
  assert.equal((await call('POST', `/api/games/${gid}/review`, body, p.token)).status, 403, 'normaler Spieler')
  assert.equal((await call('GET', '/api/me', undefined, p.token)).json.player.reviewer, false)

  assert.equal((await call('POST', '/api/admin/reviewers', { public_id: p.player.public_id }, undefined)).status, 401, 'ohne Admin')
  assert.equal((await call('POST', '/api/admin/reviewers', { public_id: 'NOPE1234' }, undefined, adm)).status, 404)
  assert.equal((await call('POST', '/api/admin/reviewers', { public_id: p.player.public_id.toLowerCase() }, undefined, adm)).status, 200)
  assert.equal((await call('GET', '/api/me', undefined, p.token)).json.player.reviewer, true)
  assert.deepEqual((await call('GET', '/api/admin/reviewers', undefined, undefined, adm)).json.reviewers.map((r: any) => r.public_id), [p.player.public_id])

  for (const bad of [{ part: 'x', kind: 'wrong' }, { part: 'answers', kind: 'x' }, {}]) {
    assert.equal((await call('POST', `/api/games/${gid}/review`, { round: 1, idx: 0, ...bad }, p.token)).status, 400)
  }
  assert.equal((await call('POST', `/api/games/${gid}/review`, { ...body, idx: 2 }, p.token)).status, 400, 'nicht beantwortete Frage')
  assert.equal((await call('POST', `/api/games/${gid}/review`, body, p.token)).status, 200)
  assert.equal((await call('POST', `/api/games/${gid}/review`, { ...body, note: 'neu formuliert' }, p.token)).status, 200)
  assert.equal(all("SELECT 1 FROM reviews WHERE status='open'").length, 1, 'gleiche Meldung wird nicht doppelt angelegt')
  assert.equal(get<{ status: string }>('SELECT status FROM questions WHERE id=?', target)!.status, 'active', 'Frage bleibt im Spiel')

  const list = (await call('GET', '/api/admin/reviews', undefined, undefined, adm)).json.reviews
  assert.equal(list.length, 1)
  assert.equal(list[0].note, 'neu formuliert')
  assert.equal(list[0].by.public_id, p.player.public_id)
  assert.deepEqual(list[0].group.map((q: any) => q.lang), ['de', 'en'], 'beide Sprachfassungen zum Mitkorrigieren')
  assert.equal((await call('GET', '/api/admin/reviews', undefined, undefined)).status, 401)

  // Reviewer-Rolle entziehen
  assert.equal((await call('DELETE', `/api/admin/reviewers/${p.player.public_id}`, undefined, undefined, adm)).status, 200)
  assert.equal((await call('POST', `/api/games/${gid}/review`, body, p.token)).status, 403)
})

test('Admin: Meldung mit Korrektur abschließen (Frage ändert sich, Korrektur wird protokolliert), Fehleingaben ändern nichts', async () => {
  const r = all<{ id: number }>('SELECT id FROM reviews WHERE status=\'open\'')[0]
  const qid = get<{ question_id: number }>('SELECT question_id FROM reviews WHERE id=?', r.id)!.question_id
  const q = get<any>('SELECT * FROM questions WHERE id=?', qid)
  const bad = await call('POST', `/api/admin/reviews/${r.id}`, { action: 'resolve', patch: { wrong: ['a', 'a', 'b'] } }, undefined, adm)
  assert.equal(bad.status, 400)
  assert.equal(get<{ status: string }>('SELECT status FROM reviews WHERE id=?', r.id)!.status, 'open', 'bei ungültiger Korrektur bleibt die Meldung offen')
  assert.equal((await call('POST', `/api/admin/reviews/${r.id}`, { action: 'x' }, undefined, adm)).status, 400)

  const newText = q.text.replace(/\?$/, '') + ' genau?'
  const ok = await call('POST', `/api/admin/reviews/${r.id}`, { action: 'resolve', patch: { text: newText, difficulty: q.difficulty === 3 ? 2 : q.difficulty + 1 } }, undefined, adm)
  assert.equal(ok.status, 200)
  const after = get<any>('SELECT * FROM questions WHERE id=?', qid)
  assert.equal(after.text, newText)
  assert.equal(after.status, q.status, 'Status bleibt')
  assert.notEqual(after.difficulty, q.difficulty)
  assert.equal(get<any>('SELECT difficulty FROM questions WHERE group_id=? AND lang=?', q.group_id, 'en').difficulty, after.difficulty, 'Schwierigkeit gilt für die ganze Gruppe')
  assert.equal(get<{ status: string }>('SELECT status FROM reviews WHERE id=?', r.id)!.status, 'resolved')
  assert.equal((await call('POST', `/api/admin/reviews/${r.id}`, { action: 'dismiss' }, undefined, adm)).status, 404, 'schon erledigt')

  const edits = (await call('GET', '/api/admin/edits', undefined, undefined, adm)).json.edits
  assert.equal(edits.length, 1)
  assert.equal(edits[0].old.text, q.text); assert.equal(edits[0].new.text, newText); assert.equal(edits[0].lang, 'de')
  assert.equal((await call('GET', `/api/admin/edits?after=${edits[0].id}`, undefined, undefined, adm)).json.edits.length, 0)
})

test('Admin markiert selbst eine Frage, sucht Fragen und speichert Korrekturen ohne Statuswechsel', async () => {
  const hit = (await call('GET', '/api/admin/search?q=' + encodeURIComponent('genau?') + '&lang=de', undefined, undefined, adm)).json.questions
  assert.equal(hit.length, 1)
  const id = hit[0].id
  assert.equal((await call('GET', `/api/admin/search?q=${encodeURIComponent('#' + id)}`, undefined, undefined, adm)).json.questions[0].id, id)
  assert.equal((await call('GET', '/api/admin/search?q=%25', undefined, undefined, adm)).json.questions.length, 0, 'Wildcards werden maskiert')

  const flag = await call('POST', '/api/admin/reviews', { question_id: id, part: 'question', kind: 'wording', note: 'holprig' }, undefined, adm)
  assert.equal(flag.status, 200)
  const open = (await call('GET', '/api/admin/reviews', undefined, undefined, adm)).json.reviews
  assert.equal(open.length, 1); assert.equal(open[0].by, null, 'vom Admin')
  assert.equal((await call('POST', '/api/admin/reviews', { question_id: 999999, part: 'question', kind: 'wording' }, undefined, adm)).status, 404)
  assert.equal((await call('POST', '/api/admin/reviews', { question_id: id, part: 'q', kind: 'wording' }, undefined, adm)).status, 400)

  // 'save' ändert Inhalt, lässt Status und offene Meldungen unberührt
  const s = await call('POST', `/api/admin/questions/${id}`, { action: 'save', patch: { text: 'Ist diese umformulierte Frage jetzt besser?' } }, undefined, adm)
  assert.equal(s.status, 200)
  assert.equal(get<any>('SELECT status, text FROM questions WHERE id=?', id).status, 'active')
  assert.equal(all("SELECT 1 FROM reviews WHERE status='open'").length, 1)
  assert.equal((await call('POST', `/api/admin/reviews/${open[0].id}`, { action: 'dismiss' }, undefined, adm)).status, 200)
  assert.equal((await call('GET', '/api/admin/reviews?status=dismissed', undefined, undefined, adm)).json.reviews.length, 1)
  // Duplikat-Text wird abgelehnt
  const other = get<{ text: string }>("SELECT text FROM questions WHERE lang='de' AND id<>? LIMIT 1", id)!.text
  assert.equal((await call('POST', `/api/admin/questions/${id}`, { action: 'save', patch: { text: other } }, undefined, adm)).status, 409)
})

test('Region: regionale (dach) Fragen werden nur auf Deutsch ausgespielt; ungültige Regionen werden abgelehnt', async () => {
  const groups = all<{ group_id: string }>("SELECT DISTINCT group_id FROM questions WHERE category='geography'")
  assert.ok(groups.length >= 3)
  run("UPDATE questions SET region='dach' WHERE category='geography'")
  const st = (await call('GET', '/api/admin/stats', undefined, undefined, adm)).json
  assert.ok(st.questions.some((r: any) => r.region === 'dach'))
  const served = (lang: string) => all<{ category: string }>(
    "SELECT DISTINCT category FROM questions WHERE lang=? AND status='active' AND (region='global' OR (region='dach' AND lang='de'))", lang).map((r) => r.category)
  assert.ok(served('de').includes('geography'))
  assert.ok(!served('en').includes('geography'))
  const p = await newPlayer('Region')
  for (let i = 0; i < 5; i++) {
    const gid = (await call('POST', '/api/games', { opponent: 'bot', lang: 'en' }, p.token)).json.id
    const g = (await call('GET', `/api/games/${gid}`, undefined, p.token)).json.game
    assert.ok(!g.options.includes('geography'), 'EN-Spiel bietet keine rein regionale Kategorie an')
    await call('POST', `/api/games/${gid}/resign`, {}, p.token)
  }
  const bad = importBatch({ format: 'ratespass-batch', version: 1, batch: 'x-region', source: 'original', license: 'CC-BY-SA-4.0',
    questions: [{ category: 'general', difficulty: 1, region: 'mars', i18n: { de: { text: 'Welche Region ist ungültig hier?', correct: 'Mars', wrong: ['A', 'B', 'C'] } } }] })
  assert.match(bad.errors[0], /Region ungültig/)
  const ok = importBatch({ format: 'ratespass-batch', version: 1, batch: 'x-region2', source: 'original', license: 'CC-BY-SA-4.0',
    questions: [{ category: 'general', difficulty: 1, region: 'dach', i18n: { de: { text: 'Welche Region gilt hier richtig?', correct: 'DACH', wrong: ['A', 'B', 'C'] } } }] })
  assert.deepEqual(ok.errors, [])
  assert.equal(get<any>("SELECT region FROM questions WHERE text='Welche Region gilt hier richtig?'").region, 'dach')
  assert.equal((await call('POST', `/api/admin/questions/${get<any>('SELECT id FROM questions LIMIT 1').id}`, { action: 'save', patch: { region: 'mars' } }, undefined, adm)).status, 400)
})

test('tools/apply-edits.ts überträgt Admin-Korrekturen in Batch-Dateien (idempotent)', async () => {
  const { execFileSync } = await import('node:child_process')
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-edits-'))
  const batch = { format: 'ratespass-batch', version: 1, batch: 'x', source: 'original', license: 'CC-BY-SA-4.0', questions: [
    { category: 'general', difficulty: 1, i18n: { de: { text: 'Alte Frage hier?', correct: 'A', wrong: ['B', 'C', 'D'] }, en: { text: 'Old question here?', correct: 'A', wrong: ['B', 'C', 'D'] } } }] }
  fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify(batch, null, 1))
  const snap = (text: string, region: string) => ({ text, correct: 'A', wrong: ['B', 'C', 'D'], category: 'history', difficulty: 2, region })
  fs.writeFileSync(path.join(dir, 'edits.json'), JSON.stringify({ edits: [{ id: 1, lang: 'de', old: snap('Alte Frage hier?', 'global'), new: snap('Neue Frage hier?', 'dach') }] }))
  const run1 = () => execFileSync('node', ['--disable-warning=ExperimentalWarning', 'tools/apply-edits.ts', path.join(dir, 'edits.json'), '--dir', dir], { encoding: 'utf8' })
  assert.match(run1(), /1 übernommen/)
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'x.json'), 'utf8')).questions[0]
  assert.equal(out.i18n.de.text, 'Neue Frage hier?'); assert.equal(out.i18n.en.text, 'Old question here?')
  assert.equal(out.category, 'history'); assert.equal(out.difficulty, 2); assert.equal(out.region, 'dach')
  assert.match(run1(), /0 übernommen, 1 bereits enthalten/)
})

test('PLAYER_REPORTS=0 schaltet den Melde-Knopf für alle Spieler ab (Reviewer-Meldungen bleiben)', async () => {
  const { config } = await import('../server/config.ts')
  assert.equal((await call('GET', '/api/meta')).json.reports, true)
  config.playerReports = false
  try {
    assert.equal((await call('GET', '/api/meta')).json.reports, false)
    const p = await newPlayer('Neugierig')
    const gid = await answeredGame(p.token)
    assert.equal((await call('POST', `/api/games/${gid}/report`, { round: 1, idx: 0 }, p.token)).status, 403)
    run('UPDATE players SET reviewer=1 WHERE public_id=?', p.player.public_id)
    assert.equal((await call('POST', `/api/games/${gid}/review`, { round: 1, idx: 0, part: 'question', kind: 'wording' }, p.token)).status, 200)
  } finally { config.playerReports = true }
})
