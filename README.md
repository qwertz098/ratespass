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
# → http://localhost:3007   Moderation: http://localhost:3007/admin   (anderer Port: HOST_PORT=8080 …)
```

Daten liegen im Volume `ratespass-data` (SQLite). Hinter einem Reverse-Proxy (TLS ist für PWA/Service Worker außerhalb von localhost Pflicht) `TRUST_PROXY=1` setzen.

Entwicklung ohne Docker (Node ≥ 22.18):

```bash
npm install          # nur typescript + @types/node für `npm run check`
npm run dev          # http://localhost:3000, Seed-Fragen werden beim Start importiert
npm test             # Server-, Spiel-, Import-, Push- und i18n-Tests (41)
npm run backup -- ./backup   # konsistente DB-Sicherung + VAPID-Schlüssel
npm run check        # Typprüfung
```

## Online stellen

GitHub Pages reicht nicht (nur statisch); die Anleitung für kostenlose Varianten (eigener Rechner + Cloudflare Tunnel, Oracle-VM, Image in der GitHub Container Registry) steht in [`docs/DEPLOY.md`](docs/DEPLOY.md). Für **Nginx Proxy Manager** gibt es `docker-compose.npm.yml` (Abschnitt C).

## Absicherung des Admin-Bereichs (`/admin`)

- **Ein Token aus der Umgebung** (`ADMIN_TOKEN`), mindestens 16 Zeichen, sonst bleibt der Bereich aus (fail-closed, das Startlog sagt es). Ohne Token ist `/admin` komplett abgeschaltet (404). Auf der Seite gibst du das Token einmal ein.
- Danach gibt es ein **Session-Cookie** statt des Tokens im Browser: `HttpOnly` (für JavaScript unlesbar), `SameSite=Strict`, nur für den Pfad `/api/admin`, `Secure` sobald HTTPS erkannt wird, Laufzeit `ADMIN_SESSION_HOURS` (8 h). Die Sitzung liegt serverseitig im Speicher; Abmelden oder Neustart macht sie ungültig. Das Token wird nirgends im Browser gespeichert.
- **Brute-Force-Schutz:** Vergleich in konstanter Zeit, 400 ms Verzögerung je Fehlversuch, **Sperre nach 5 Fehlversuchen je IP für 15 Minuten** (auch mit richtigem Token; zählt für Login *und* Header-Zugriffe). Dafür müssen `TRUST_PROXY`/`PROXY_HOPS` hinter einem Reverse-Proxy stimmen, damit die echte Client-IP zählt.
- **CSRF:** zusätzlich zu `SameSite=Strict` müssen ändernde Anfragen mit Cookie einen passenden `Origin` (oder `Sec-Fetch-Site: same-origin`) mitbringen.
- **Skripte:** dasselbe Token geht auch als Header `X-Admin-Token` (z. B. `curl -H "X-Admin-Token: …" …/api/admin/stats`).
- Die statische Seite `/admin` ist öffentlich erreichbar, enthält aber keine Daten; alles Sensible steckt hinter der API. Empfehlung zusätzlich: HTTPS erzwingen und `/admin` bei Bedarf im Reverse-Proxy auf bekannte IPs beschränken (NPM: *Access List*).

## Konfiguration (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | 3000 | HTTP-Port |
| `DATA_DIR` | `./data` (Docker: `/data`) | SQLite-Datenbank |
| `ADMIN_TOKEN` | – | Zugang zu `/admin` und `/api/admin/*` (**mind. 16 Zeichen**, z. B. `openssl rand -hex 16`; leer oder kürzer = abgeschaltet) |
| `ADMIN_SESSION_HOURS` | 8 | Laufzeit der Admin-Sitzung nach dem Login |
| `HOST_PORT` / `BIND_ADDRESS` | 3007 / 0.0.0.0 | nur Compose: veröffentlichter Host-Port bzw. Bindeadresse (der Container hört intern auf 3000) |
| `TRUST_PROXY` | 0 | `1`: Client-IP aus `X-Forwarded-For` (Rate-Limits) |
| `PROXY_HOPS` | 1 | Anzahl Proxys vor der App (NPM/Caddy: 1, Cloudflare davor: 2); gezählt von rechts, damit gefälschte Header nichts bringen |
| `BATCH_DIR` | `./batches` | Fragen-Batches, die beim Start automatisch importiert werden |
| `MIN_LANG_QUESTIONS` | 30 | Sprache wird erst ab so vielen aktiven Fragen angeboten |
| `VAPID_SUBJECT` | Repo-URL | Kontakt für Push-Dienste (`mailto:…` oder `https://…`) – für den Betrieb setzen |
| `VAPID_FILE` | `DATA_DIR/vapid.json` | Push-Schlüssel (wird beim ersten Start erzeugt, mit dem Backup sichern) |
| `PUSH_EXTRA_HOSTS` | – | zusätzlich erlaubte Push-Dienst-Hosts (kommagetrennt) |

## Fragen

Beim Start werden alle neuen Dateien aus `batches/` importiert (idempotent, dedupliziert, Lizenz geprüft). Neue Batches = Datei ablegen, Container neu starten. Freigegebene Community-Fragen lassen sich per `npm run export:community` (oder `/admin` → „Batch exportieren“) als Batch ins Repo zurückschreiben. Details, Workflow für „200er-Batches auf Abruf“ und die **Lizenzregeln** stehen in [`docs/QUESTIONS.md`](docs/QUESTIONS.md).

Aktueller Bestand: **578 Fragen × de/en** (`seed-000` 72, `original-001` 200, `original-002` 106, `original-003` 200), selbst formuliert, CC BY-SA 4.0, über alle 12 Kategorien und Schwierigkeitsgrade verteilt. Zielbestand 4000 folgt in weiteren Batches; `test/batches.test.ts` prüft bei jedem Lauf alle Dateien auf Format, Lizenz und Dubletten.

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
- **Web-Push ist eingebaut** (Profil → Benachrichtigungen), aber die echte Zustellung über FCM/Mozilla/Apple konnte in der Entwicklungsumgebung nicht getestet werden (Netzwerk gesperrt). Verschlüsselung, VAPID und Auslöser sind gegen die Referenzbibliotheken `http_ece`/`web-push` und einen Fake-Push-Dienst getestet.
- `/legal.html` (Impressum/Datenschutz) ist ein **Platzhalter** und muss vor einem öffentlichen Betrieb ausgefüllt und rechtlich geprüft werden.
- `tools/fetch-opentdb.ts` und `tools/gen-wikidata.ts` sind gegen Fixtures im dokumentierten API-Format getestet, aber noch nicht gegen die Live-Dienste gelaufen (Netzwerkzugriff war in der Entwicklungsumgebung gesperrt).
- Code-Lizenz für dieses Repository ist noch nicht festgelegt (die **Fragen** stehen unter CC BY-SA 4.0, siehe Doku).
- Für „Quizduell“ als Name bestehen Markenrechte – deshalb „Ratespaß“.

## Drittbibliotheken

`web/vendor/` enthält unverändert `qrcode-generator` (MIT) und `jsQR` (Apache-2.0), nur bei Bedarf geladen – siehe `web/vendor/README.md` und die Lizenztexte dort.
