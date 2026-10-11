import test from 'node:test'
import assert from 'node:assert/strict'
import { boot, run, get } from './helpers.ts'

const t = await boot()
const { call, newPlayer } = t
test.after(() => t.close())
const { sweepChat } = await import('../server/chat.ts')
const { erasePlayer } = await import('../server/erase.ts')

const say = (from: any, to: any, text: string) => call('POST', `/api/chat/${to.player.public_id}`, { text }, from.token)
const thread = async (me: any, other: any, after = 0) => (await call('GET', `/api/chat/${other.player.public_id}?after=${after}`, undefined, me.token))
const befriend = async (a: any, b: any) => call('POST', '/api/contacts', { public_id: b.player.public_id }, a.token) // legt beide Richtungen an

test('Chat nur zwischen gegenseitigen Freunden; Nachricht, Verlauf, Ungelesen', async () => {
  const [a, b, c] = [await newPlayer('Chat Anna'), await newPlayer('Chat Ben'), await newPlayer('Chat Cara')]
  assert.equal((await say(a, b, 'hallo')).status, 403, 'Fremde dürfen nicht schreiben')
  assert.equal((await say(a, { player: { public_id: 'ZZZZZZZZ' } }, 'x')).status, 404)
  await befriend(a, b)
  assert.equal((await say(a, b, '  Hallo Ben!  ')).status, 200)
  assert.equal((await say(b, a, 'Hi Anna')).status, 200)
  assert.equal((await say(a, b, '')).json.error, 'empty_message'); assert.equal((await say(a, b, 'x'.repeat(501))).json.error, 'message_too_long')
  assert.equal((await call('GET', '/api/chat/unread', undefined, b.token)).json.unread, 1)
  const sum = (await call('GET', '/api/chat', undefined, b.token)).json
  assert.equal(sum.unread, 1); assert.equal(sum.conversations.length, 1); assert.equal(sum.conversations[0].friend.name, 'Chat Anna'); assert.equal(sum.conversations[0].unread, 1); assert.equal(sum.conversations[0].last.text, 'Hi Anna'); assert.equal(sum.conversations[0].last.mine, true)
  const th = (await thread(b, a)).json
  assert.deepEqual(th.messages.map((m: any) => [m.mine, m.text]), [[false, 'Hallo Ben!'], [true, 'Hi Anna']])
  assert.equal((await call('GET', '/api/chat/unread', undefined, b.token)).json.unread, 0, 'Lesen markiert Eingehendes')
  const last = th.messages.at(-1).id
  await say(a, b, 'noch eins')
  assert.deepEqual((await thread(b, a, last)).json.messages.map((m: any) => m.text), ['noch eins'], 'after liefert nur Neueres')
  assert.equal((await thread(c, a)).status, 403, 'Dritte lesen nichts')
})

test('Entfernen löscht den Verlauf und sperrt: Entfernte können die Gegenrichtung nicht neu anlegen, Wieder-Hinzufügen hebt die Sperre auf', async () => {
  const [a, b] = [await newPlayer('Block Anna'), await newPlayer('Block Ben')]
  await befriend(a, b); await say(a, b, 'hi'); await say(b, a, 'hey')
  assert.equal((await call('DELETE', `/api/contacts/${b.player.public_id}`, undefined, a.token)).status, 200)
  assert.equal(get<{ n: number }>('SELECT COUNT(*) n FROM chat_messages WHERE (from_id IN (SELECT id FROM players WHERE name IN (?, ?)))', 'Block Anna', 'Block Ben')!.n, 0, 'Verlauf gelöscht')
  assert.equal((await say(b, a, 'noch da?')).status, 403)
  await befriend(b, a) // Ben fügt Anna wieder hinzu: Gegenrichtung bleibt gesperrt
  assert.equal((await say(b, a, 'bitte')).status, 403); assert.equal((await say(a, b, 'x')).status, 403)
  await befriend(a, b) // Anna entscheidet sich neu: Sperre weg, beide Richtungen
  assert.equal((await say(b, a, 'danke')).status, 200)
})

test('Rate-Limit, Aufbewahrung, Löschen des Profils, Export', async () => {
  const [a, b] = [await newPlayer('Frist Anna'), await newPlayer('Frist Ben')]
  await befriend(a, b)
  await say(a, b, 'alt'); await say(a, b, 'neu')
  run('UPDATE chat_messages SET created_at=? WHERE body=?', Date.now() - 31 * 86_400_000, 'alt')
  assert.equal(sweepChat(), 1)
  const th = (await thread(b, a)).json; assert.deepEqual(th.messages.map((m: any) => m.text), ['neu']); assert.equal(th.retention_days, 30)
  const exp = (await call('GET', '/api/export', undefined, a.token)).json; assert.deepEqual(exp.chat.map((m: any) => [m.with, m.mine, m.text]), [['Frist Ben', true, 'neu']])
  let limited = 0
  for (let i = 0; i < 35; i++) if ((await say(b, a, 'spam ' + i)).status === 429) limited++
  assert.ok(limited >= 5, 'mehr als 30 Nachrichten pro Minute werden gebremst')
  erasePlayer(get<any>('SELECT * FROM players WHERE public_id=?', a.player.public_id))
  assert.equal(get<{ n: number }>('SELECT COUNT(*) n FROM chat_messages WHERE body LIKE ? OR body=?', 'spam %', 'neu')!.n, 0, 'Löschen entfernt den Verlauf')
})
