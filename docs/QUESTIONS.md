# Fragen: Quellen, Batches, Lizenzen

## Prinzip

Jede Frage trägt ihre Herkunft: `source`, `license`, `attribution`, optional `source_ref`. Erlaubt sind nur **CC0-1.0, CC-BY-4.0 und CC-BY-SA-4.0** – der Import lehnt alles andere (z. B. CC BY-NC) ab. Der gesamte aktive Fragenpool wird als **CC BY-SA 4.0** veröffentlicht (`GET /api/dataset.jsonl`, in der App unter Profil → „Alle Fragen herunterladen“; Quellen/Namensnennung unter „Lizenzen & Quellen“). Das erfüllt die ShareAlike-Pflicht der Open Trivia DB und erlaubt CC0-Daten problemlos.

| Quelle | Lizenz | Pflichten | Umsetzung |
|---|---|---|---|
| [Open Trivia DB](https://opentdb.com) | CC BY-SA 4.0 | Namensnennung, Weitergabe (auch von Übersetzungen) unter gleicher Lizenz | `source: opentdb`, Attribution im Batch, Pool-Download offen |
| [Wikidata](https://www.wikidata.org) | CC0 1.0 | keine (Nennung freiwillig) | `source: wikidata`, generierte Vorlagenfragen |
| Wikipedia-Wissen (eigene Formulierung) | Fakten frei; Wikipedia-*Text* ist CC BY-SA/GFDL | **Keine Sätze kopieren**; Fakten in eigenen Worten als Frage fassen | `source: original`, optional `source_ref` = Artikel-URL |
| Selbst geschrieben / KI-generiert & geprüft | CC BY-SA 4.0 (Projektentscheidung) | Fakten vor Import prüfen; KI-Texte nicht blind übernehmen | `source: original` bzw. `llm` |
| Community | CC BY-SA 4.0 | Einreicher bestätigt Urheberschaft + Lizenz (Pflicht-Checkbox), Moderation vor Freigabe | `source: community`, Status `pending` → `active` |

Nicht erlaubt: Fragen aus kommerziellen Quiz-Apps (auch dem Original-Quizduell), Scraping fremder Quizseiten, NC-lizenzierte Datensätze. *Das ist keine Rechtsberatung; bei öffentlichem Betrieb bitte prüfen lassen.*

## Batch-Format

```json
{
  "format": "ratespass-batch", "version": 1,
  "batch": "original-001",
  "source": "original", "license": "CC-BY-SA-4.0",
  "attribution": "Ratespaß-Projekt",
  "questions": [
    {
      "category": "geography", "difficulty": 2,
      "source_ref": "https://de.wikipedia.org/wiki/Canberra",
      "i18n": {
        "de": { "text": "Was ist die Hauptstadt von Australien?", "correct": "Canberra", "wrong": ["Sydney", "Melbourne", "Perth"], "explanation": "optional" },
        "en": { "text": "What is the capital of Australia?", "correct": "Canberra", "wrong": ["Sydney", "Melbourne", "Perth"] }
      }
    }
  ]
}
```

- `category`: `general geography history science nature sports film_tv music literature art games tech`
- `difficulty`: 1 leicht, 2 mittel, 3 schwer
- Sprachen = beliebige ISO-Codes in `i18n`; eine Frage kann in mehreren Sprachen auf einmal kommen. Übersetzungen existierender Fragen: Eintrag mit `group` (statt Kategorie/Lizenz – diese werden geerbt).
- Prüfregeln: Fragetext 8–300 Zeichen; genau 1 richtige + 3 falsche Antworten, je ≤ 80 Zeichen, paarweise verschieden; keine Steuerzeichen. Duplikate (gleicher normalisierter Text pro Sprache) werden übersprungen.
- Import ist **strikt** (ein Fehler → nichts wird importiert); `--lenient` übernimmt gültige Einträge.

```bash
npm run import -- batches/original-001.json --dry-run   # prüfen
# danach Datei committen; beim nächsten Start importiert der Server sie automatisch
```

## Workflow „200er-Batch auf Abruf“

1. **Auftrag** (Kategorien, Sprachen, Quelle) → Batch-Datei `batches/<name>.json` mit je ca. 200 Fragen erstellen.
2. `npm run import -- <datei> --dry-run`, Stichproben lesen, committen, Container neu starten.
3. Für die Open Trivia DB: `npm run fetch:opentdb -- --amount 200 --name otdb-001` (englisch; API-Limit 1 Anfrage/5 s, Session-Token verhindert Wiederholungen), danach `npm run todo:translate -- --from en --to de --limit 200 --out tmp/todo.json` → Übersetzungsbatch (Einträge mit `group` + `i18n.de`) erstellen und importieren.
4. Für Geografie aus Wikidata: `npm run gen:wikidata` (Hauptstädte, Kontinente; deterministisch, de+en).

## Eigener LLM-Nachschub (später)

Gleiche Pipeline, nur automatisiert: Generator (strukturierte Ausgabe im Batch-Format) → **zweiter Prüf-Durchlauf** (Faktencheck, Eindeutigkeit, plausible Distraktoren) → `import --dry-run` → Import mit `source: llm`. Faustregel: Fragen mit unsicherem Fakt verwerfen statt raten; Schwierigkeitsgrad aus den Spielstatistiken nachkalibrieren.

## Community & Moderation

- Einreichen: Profil → „Frage einreichen“ (max. 10/Tag), landet als `pending` – nie direkt im Spiel.
- Moderation unter `/admin` (Header `X-Admin-Token`): freigeben (mit Korrekturen), ablehnen.
- Spieler können beantwortete Fragen melden; ab **3 Meldungen verschiedener Spieler** wird die Frage automatisch deaktiviert und erscheint in der Moderationsliste „Gemeldet/deaktiviert“.
