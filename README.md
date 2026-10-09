# Ratespaß

Minimalistischer Quizduell-Clon als **PWA**, betrieben als **ein Docker-Container**. Ohne Anmeldung spielbar, optionaler Account, offener und lizenzsauberer Fragenpool.

- 2 Spieler, 6 Runden à 3 Fragen, Kategorie-Wahl aus 3 Vorschlägen, 4 Antworten, 20 s pro Frage – rundenbasiert (asynchron)
- Gegner: Freunde per Einladungslink/Freundescode, zufälliger Gegner (Warteliste), Bot
- **Kein Login nötig:** anonymes Profil beim ersten Start. Verlauf & Identität lassen sich als Datei exportieren oder per Einmal-Code auf ein anderes Gerät übertragen
- **Befreunden** per Link, per Freundescode (auch einfach einen Link/Chat-Text einfügen) oder per **QR-Code** (anzeigen und mit der In-App-Kamera scannen; mit der Kamera-App des Handys geht der Link ebenfalls)
- **Kontakte lokal + zentral:** Sie liegen auf dem Server (an den anonymen Zugangsschlüssel bzw. das Konto gebunden) und zusätzlich als lokale Kopie im Browser; ist die Server-Liste leer, werden sie aus der lokalen Kopie wiederhergestellt
- **Optionaler Account** (Benutzername + Passwort): Login auf jedem Gerät, Kontakte zentral gespeichert
- Mehrsprachig (UI und Fragen: de/en; weitere Sprachen = zusätzliche Texte bzw. Fragen-Batches)
- Fragen aus mehreren Quellen mit **Lizenz je Frage**, Community-Einreichungen mit Moderation, „Frage melden“-Button
- Keine Laufzeit-Abhängigkeiten (Node 24 führt TypeScript direkt aus, SQLite via `node:sqlite`), kein Build-Schritt fürs Frontend

## Schnellstart

```bash
ADMIN_TOKEN=$(openssl rand -hex 16) docker compose up -d --build
# → http://localhost:3000   Moderation: http://localhost:3000/admin
```

Daten liegen im Volume `ratespass-data` (SQLite). Hinter einem Reverse-Proxy (TLS ist für PWA/Service Worker außerhalb von localhost Pflicht) `TRUST_PROXY=1` setzen.

Entwicklung ohne Docker (Node ≥ 22.18):

```bash
npm install          # nur typescript + @types/node für `npm run check`
npm run dev          # http://localhost:3000, Seed-Fragen werden beim Start importiert
npm test             # Server-, Spiel-, Import- und i18n-Tests (17)
npm run check        # Typprüfung
```

## Konfiguration (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | 3000 | HTTP-Port |
| `DATA_DIR` | `./data` (Docker: `/data`) | SQLite-Datenbank |
| `ADMIN_TOKEN` | – | aktiviert Moderation (`/admin`, `/api/admin/*`) |
| `TRUST_PROXY` | 0 | `1`: Client-IP aus `X-Forwarded-For` (Rate-Limits) |
| `BATCH_DIR` | `./batches` | Fragen-Batches, die beim Start automatisch importiert werden |
| `MIN_LANG_QUESTIONS` | 30 | Sprache wird erst ab so vielen aktiven Fragen angeboten |

## Fragen

Beim Start werden alle neuen Dateien aus `batches/` importiert (idempotent, dedupliziert, Lizenz geprüft). Neue Batches = Datei ablegen, Container neu starten. Details, Workflow für „200er-Batches auf Abruf“ und die **Lizenzregeln** stehen in [`docs/QUESTIONS.md`](docs/QUESTIONS.md).

Aktueller Bestand: `batches/seed-000.json` (72 Fragen × de/en) – ein Entwicklungs-Seed, damit die App sofort spielbar ist. Zielbestand 4000 Fragen folgt in Batches.

## Architektur

```
server/   Node-HTTP-Server (ohne Framework): API, Spiellogik, Import, Moderation
web/      PWA: Vanilla-ES-Module, strikte CSP (kein Inline-JS/CSS), Service Worker, Manifest
tools/    Import, OpenTDB-Abruf, Wikidata-Generator, Übersetzungs-To-do, Icon-Rendering
batches/  Fragen als JSON (versioniert, reviewbar)
test/     node:test – inkl. kompletter Spielabläufe über HTTP
```

Spielregeln serverseitig: Die Lösung verlässt den Server erst nach der Antwort; Antwortreihenfolge wird pro Spiel gemischt; Zeitlimit wird serverseitig durchgesetzt; Gegnerantworten bleiben verdeckt, bis man selbst geantwortet hat; Fragen wiederholen sich weder im Spiel noch (soweit der Pool reicht) bei denselben Spielern.

## Bekannte Lücken / Nächste Schritte

- Der Kamera-Scan braucht HTTPS (oder `localhost`) und die Kamera-Berechtigung; ohne beides bleibt der Link-/Code-Weg.
- Gleichen Kontakt auf einem Gerät entfernen und auf einem anderen noch lokal gespeichert haben: die lokale Kopie stellt Kontakte nur wieder her, wenn die Server-Liste komplett leer ist.
- **Web-Push** („Du bist dran“) fehlt noch – Spielstände aktualisieren sich per Polling, solange die App offen ist.
- `/legal.html` (Impressum/Datenschutz) ist ein **Platzhalter** und muss vor einem öffentlichen Betrieb ausgefüllt und rechtlich geprüft werden.
- `tools/fetch-opentdb.ts` und `tools/gen-wikidata.ts` sind gegen Fixtures im dokumentierten API-Format getestet, aber noch nicht gegen die Live-Dienste gelaufen (Netzwerkzugriff war in der Entwicklungsumgebung gesperrt).
- Code-Lizenz für dieses Repository ist noch nicht festgelegt (die **Fragen** stehen unter CC BY-SA 4.0, siehe Doku).
- Für „Quizduell“ als Name bestehen Markenrechte – deshalb „Ratespaß“.

## Drittbibliotheken

`web/vendor/` enthält unverändert `qrcode-generator` (MIT) und `jsQR` (Apache-2.0), nur bei Bedarf geladen – siehe `web/vendor/README.md` und die Lizenztexte dort.
