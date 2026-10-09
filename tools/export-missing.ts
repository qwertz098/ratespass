// Listet Fragen, die in einer Zielsprache noch fehlen, als Übersetzungs-Auftrag (JSON).
// Verwendung: npm run todo:translate -- --from en --to de --limit 200 [--out tmp/todo-de.json]
// Das Ergebnis wird übersetzt und als normales Batch (entries mit "group" + i18n.<to>) wieder importiert;
// Kategorie, Schwierigkeit und Lizenz erbt der Import von der bestehenden Gruppe.
import fs from 'node:fs'
import { all } from '../server/db.ts'
import type { QRow } from '../server/questions.ts'

const arg = (k: string, d: string) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const from = arg('from', 'en'), to = arg('to', 'de'), limit = Number(arg('limit', '200'))
const rows = all<QRow>(
  `SELECT * FROM questions q WHERE lang=? AND status='active'
   AND NOT EXISTS (SELECT 1 FROM questions t WHERE t.group_id=q.group_id AND t.lang=?)
   ORDER BY id LIMIT ?`, from, to, limit)
const todo = {
  format: 'ratespass-translation-todo', from, to,
  entries: rows.map((q) => ({
    group: q.group_id, category: q.category, difficulty: q.difficulty,
    [from]: { text: q.text, correct: q.correct, wrong: JSON.parse(q.wrong), explanation: q.explanation ?? undefined },
  })),
}
const out = arg('out', '')
if (out) { fs.writeFileSync(out, JSON.stringify(todo, null, 1)); console.log(`${rows.length} offen -> ${out}`) }
else console.log(JSON.stringify(todo, null, 1))
