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

- `category`: Basis (für alle): `general geography history science nature sports film_tv music literature art games tech` · Nerd: `scifi_fantasy coding anime retro_games` · Experte: `expert_mint expert_humanities expert_arts expert_it`. Stufen und Kategorien stehen in `server/categories.ts` (`CATEGORY_TIERS`).
- `difficulty`: 1 leicht, 2 mittel, 3 schwer
- Sprachen = beliebige ISO-Codes in `i18n`; eine Frage kann in mehreren Sprachen auf einmal kommen. Übersetzungen existierender Fragen: Eintrag mit `group` (statt Kategorie/Lizenz – diese werden geerbt).
- Prüfregeln: Fragetext 8–300 Zeichen; genau 1 richtige + 3 falsche Antworten, je ≤ 80 Zeichen, paarweise verschieden; keine Steuerzeichen. Duplikate (gleicher normalisierter Text pro Sprache) werden übersprungen.
- Import ist **strikt** (ein Fehler → nichts wird importiert); `--lenient` übernimmt gültige Einträge.

```bash
npm run import -- batches/original-001.json --dry-run   # prüfen
# danach Datei committen; beim nächsten Start importiert der Server sie automatisch
```

## Spielstufen: Basis, Nerd, Experte

- Jede Kategorie gehört zu einer Stufe (`CATEGORY_TIERS` in `server/categories.ts`): `basic`, `nerd` (`scifi_fantasy coding anime retro_games`), `expert` (`expert_mint expert_humanities expert_arts expert_it`). Neue Kategorie = Eintrag dort + `cat.*`-Texte (de+en) + Farbe in `web/style.css` + mind. 40 Fragen je Sprache.
- Jeder Spieler wählt selbst sein **Level** (`players.level`) und kann einzelne Extra-Kategorien abwählen (`players.disabled_cats`; Basis-Kategorien sind immer an). Es gibt keine Sperre und keine Codes.
- **Im Duell zählt die niedrigste Einstellung**: wirksames Level = Minimum, wirksame Kategorien = Schnitt der Auswahl aller menschlichen Teilnehmer (`effectiveFor()` in `server/settings.ts`). Die Auswahl wird beim Spielstart in `games.level`/`games.cats` festgehalten (Zufallsgegner: beim Beitritt neu berechnet); spätere Profiländerungen wirken auf neue Spiele. Gegen den Bot gilt deine Einstellung.
- Bei den Rundenoptionen ist immer mindestens eine wirksame Extra-Kategorie dabei, sofern es welche gibt.
- Experten-Fragen sind überwiegend Schwierigkeit 2–3 (relativ zur Kategorie), `region: global`, de+en. Inhalte: MINT & Ingenieurwesen, Geisteswissenschaften, Kunst & Literatur, Informatik – klar abgegrenzt von den Basis-/Nerd-Kategorien `science`, `tech`, `literature`, `art`, `coding`.
- Quellenlage: Fragen aus „Wer wird Millionär?“ o. Ä. sind nicht frei lizenziert und tabu; geeignet sind eigene Fragen, Open Trivia DB (CC BY-SA 4.0) und Wikidata (CC0).

## Workflow „200er-Batch auf Abruf“

1. **Auftrag** (Kategorien, Sprachen, Quelle) → Batch-Datei `batches/<name>.json` mit je ca. 200 Fragen erstellen.
2. `npm run import -- <datei> --dry-run`, Stichproben lesen, committen, Container neu starten.
3. Für die Open Trivia DB: `npm run fetch:opentdb -- --amount 200 --name otdb-001` (englisch; API-Limit 1 Anfrage/5 s, Session-Token verhindert Wiederholungen), danach `npm run todo:translate -- --from en --to de --limit 200 --out tmp/todo.json` → Übersetzungsbatch (Einträge mit `group` + `i18n.de`) erstellen und importieren.
4. Für Geografie aus Wikidata: `npm run gen:wikidata` (Hauptstädte, Kontinente; deterministisch, de+en).

## Eigener LLM-Nachschub (später)

Gleiche Pipeline, nur automatisiert: Generator (strukturierte Ausgabe im Batch-Format) → **zweiter Prüf-Durchlauf** (Faktencheck, Eindeutigkeit, plausible Distraktoren) → `import --dry-run` → Import mit `source: llm`. Faustregel: Fragen mit unsicherem Fakt verwerfen statt raten; Schwierigkeitsgrad aus den Spielstatistiken nachkalibrieren.

## Community & Moderation

- Einreichen: Profil → „Frage einreichen“ (max. 10/Tag), landet als `pending` – nie direkt im Spiel.
- Moderation unter `/admin` (Anmeldung mit dem `ADMIN_TOKEN`; Skripte nutzen den Header `X-Admin-Token`): freigeben (mit Korrekturen), ablehnen.
- Spieler können beantwortete Fragen melden (⚑); ab **3 Meldungen verschiedener Spieler** wird die Frage automatisch deaktiviert und erscheint in der Moderationsliste „Gemeldet“.

### Community-Fragen zurück ins Repo (Single Source of Truth)

Freigegebene Community-Fragen leben zunächst nur in der Datenbank. Damit sie versioniert, prüfbar und bei Datenverlust wiederherstellbar sind, werden sie als Batch exportiert:

```bash
npm run export:community -- --dry-run   # nur anzeigen
npm run export:community                # schreibt batches/community-NNN.json (nächste freie Nummer) und markiert sie in der DB
git add batches && git commit           # Datei einchecken
```

- Ohne Shell-Zugriff (z. B. gehosteter Container): `/admin` → **Batch exportieren** lädt dieselbe Datei herunter und markiert die Fragen als exportiert; sie dann unter `batches/` ins Repo legen.
- Exportiert werden nur Fragen mit Status `active` und ohne bisherigen Batch. Die Fragen werden danach dem Batch zugeordnet: kein zweiter Export, kein Doppelimport beim Neustart. Der Einreicher (`submitted_by`) wird **nicht** exportiert.
- Wiederherstellung: Datenbank neu aufgebaut → Server importiert beim Start alle `batches/*.json`, auch `community-NNN.json` (Quelle `community`, Lizenz CC BY-SA 4.0).
- Korrekturen an Fragen aus *anderen* Batches (z. B. ein verbesserter Text) werden in der Tabelle `edits` protokolliert und mit `apply:edits` in die Batch-Dateien übernommen (siehe „Überarbeitung“).


## Überarbeitung: Reviewer melden, Admin korrigiert

Neben dem ⚑-Knopf für alle gibt es eine feinere Rückmeldung für **Reviewer** – vom Admin bestimmte Spieler:

- **Reviewer bestimmen:** `/admin` → Tab **Reviewer** → Freundescode der Person (Profil → „Dein Freundescode“) eintragen. Entfernen geht dort ebenfalls. Reviewer sehen im Profil einen Hinweis und beim Spielen nach jeder beantworteten Frage den Knopf **✎**.
- **Melden:** ✎ öffnet ein kleines Formular: *Was?* **Frage** oder **Antworten**, *Warum?* **Falsch** oder **Formulierung**, dazu ein optionaler Hinweis (max. 300 Zeichen). Die Frage bleibt im Spiel; mehrfaches Melden derselben Sache aktualisiert nur den Hinweis.
- **Admin selbst:** `/admin` → Tab **Suche** (Text, Antwort oder `#ID`, Filter Sprache/Region) → eine Frage direkt bearbeiten („Speichern“, Status bleibt) oder mit Teil/Grund **markieren**.
- **Abarbeiten:** Tab **Überarbeiten** (Zähler = offene Meldungen) zeigt die Meldung mit **allen Sprachfassungen** der Frage zum Mitkorrigieren. *Korrigiert / erledigt* speichert die Änderungen der gemeldeten Fassung und schließt die Meldung; *Verwerfen* schließt sie ohne Änderung. Die andere Sprachfassung wird über „… speichern“ angepasst. Schwierigkeit und Region gelten für die ganze Gruppe.
- **Zurück ins Repo:** Jede Änderung landet in `edits` (alt/neu, Sprache, Batch). `/admin` → **Korrekturen exportieren** lädt `edits.json`; danach

```bash
npm run apply:edits -- edits.json --dry-run   # zeigt, was übernommen würde
npm run apply:edits -- edits.json             # schreibt die Korrekturen in batches/*.json (idempotent)
```

  So bekommen auch Neuinstallationen die korrigierte Fassung; die Fragen werden über ihren alten Text gefunden.

## Regionen: Englisch = internationales Wissen

Fragen werden nicht nur nach Sprache, sondern auch nach **Region** einsortiert (`region` je Eintrag im Batch, Standard `global`):

| Region | Bedeutung | Wird ausgespielt in |
|---|---|---|
| `global` | weltweit geläufiges Wissen (Hauptstädte, Wissenschaft, internationale Filme/Musik/Sport, Märchen …) | allen Sprachen |
| `dach` | vor allem im deutschsprachigen Raum geläufig (Bundesländer, Bundesliga, deutsche Redewendungen/Grammatik, Brettspiele wie Skat, regionale Bauwerke, Kinderbuch-Klassiker …) | nur **Deutsch** |

- **Regel für neue Fragen:** Englisch soll internationales/globales Wissen abbilden. Rein deutschsprachig relevante Fragen bekommen `"region": "dach"` und brauchen nur eine deutsche Fassung (`i18n` mit nur `de`); globale Fragen kommen in beiden Sprachen. Test: *Würde man das in London, New York oder Delhi erkennen?* Wenn nein → `dach`.
- Die Zuordnung steckt in `server/categories.ts` (`REGIONS`, `REGION_LANGS`, `SERVABLE_SQL`). Weitere Regionen (z. B. eine Region für Frankreich) = Eintrag in `REGIONS` und `REGION_LANGS`.
- Der Import erbt die Region einer Gruppe bei Übersetzungen; im Admin lässt sie sich pro Frage ändern (gilt für alle Sprachen der Gruppe). Der Pool-Export (`/api/dataset.jsonl`) enthält `region`.
- Bestehende Fragen wurden einmalig per Stichwortliste vorsortiert und gesichtet (rund 10 % `dach`); Einzelfälle korrigiert man im Admin und überträgt sie per `apply:edits`.
