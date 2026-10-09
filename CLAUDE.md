# Projektkonventionen (Ratespaß)

- **Fragen: Sprache ≠ Region.** Englisch bildet *internationales/globales* Wissen ab. Neue Fragen bekommen `region: "global"` (Standard, in de+en) oder `"dach"` (nur deutschsprachig relevant, reicht mit deutscher Fassung). Zweifelsfall-Test: Würde man es in London/New York/Delhi erkennen? Details: `docs/QUESTIONS.md` → „Regionen“.
- **Neue Batches** (`batches/original-NNN.json`, je 200 Fragen): Format und Prüfregeln in `docs/QUESTIONS.md`; nach dem Schreiben `npm test` (prüft Format, Lizenz, Dubletten, Region-Konsistenz, ausreichend globale Fragen je Kategorie), README-Zähler anpassen, committen und auf den Entwicklungsbranch pushen.
- **Korrekturen im Admin** (Moderation/Überarbeitung) werden in `edits` protokolliert und per `npm run apply:edits` in die Batch-Dateien übernommen – die Batch-Dateien sind die Quelle der Wahrheit.
- **Admin-Token nie im Chat/Code**: nur über `ADMIN_TOKEN` in der Umgebung.
- Tests: `npm test` (Node ≥ 22.18, keine Laufzeit-Abhängigkeiten); Typen: `npm run check`.
