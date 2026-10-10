# Ratespaß

Minimalistischer Quizduell-Clon als **PWA**, betrieben als **ein Docker-Container**. Ohne Anmeldung spielbar, optionaler Account, offener und lizenzsauberer Fragenpool.

- 2 Spieler, 6 Runden à 3 Fragen, Kategorie-Wahl aus 3 Vorschlägen, 4 Antworten, 20 s pro Frage – rundenbasiert (asynchron)
- Gegner: Freunde per Einladungslink/Freundescode, zufälliger Gegner (Warteliste), Bot
- **Kein Login nötig:** anonymes Profil beim ersten Start. Verlauf & Identität lassen sich als Datei exportieren oder per Einmal-Code auf ein anderes Gerät übertragen
- **Befreunden** per Link, per Freundescode (auch einfach einen Link/Chat-Text einfügen) oder per **QR-Code** (anzeigen und mit der In-App-Kamera scannen; mit der Kamera-App des Handys geht der Link ebenfalls)
- **Kontakte lokal + zentral:** Sie liegen auf dem Server (an den anonymen Zugangsschlüssel bzw. das Konto gebunden) und zusätzlich als lokale Kopie im Browser; ist die Server-Liste leer, werden sie aus der lokalen Kopie wiederhergestellt
- **Optionaler Account** (Benutzername + Passwort): Login auf jedem Gerät, Kontakte zentral gespeichert
- Mehrsprachig (UI und Fragen: de/en; weitere Sprachen = zusätzliche Texte bzw. Fragen-Batches)
- Fragen aus mehreren Quellen mit **Lizenz je Frage**, Community-Einreichungen mit Moderation, „Frage melden“-Button, Reviewer-Rolle für Überarbeitungs-Meldungen („falsch“ / „Formulierung“)
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
npm test             # Server-, Spiel-, Import-, Push-, Review- und i18n-Tests (48)
npm run backup -- ./backup   # konsistente DB-Sicherung + VAPID-Schlüssel
npm run check        # Typprüfung
```

## Online stellen

GitHub Pages reicht nicht (nur statisch); die Anleitung für kostenlose Varianten (eigener Rechner + Cloudflare Tunnel, Oracle-VM, Image in der GitHub Container Registry) steht in [`docs/DEPLOY.md`](docs/DEPLOY.md). Für **Nginx Proxy Manager** gibt es `docker-compose.npm.yml` (Abschnitt C). Für eine Gratis-VM bei **Oracle Cloud** gibt es ein Terraform-Paket in [`deploy/oracle/`](deploy/oracle/README.md).

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
| `CONTROLLER_NAME`, `CONTROLLER_ADDRESS`, `CONTROLLER_EMAIL` | – | **Pflicht** für Impressum und Datenschutzerklärung (Verantwortlicher); fehlen sie, zeigt die Erklärung „[nicht konfiguriert]“ und der Server warnt |
| `CONTROLLER_PHONE`, `CONTROLLER_REPRESENTATIVE`, `CONTROLLER_REGISTER`, `CONTROLLER_VAT_ID`, `DPO_CONTACT`, `SUPERVISORY_AUTHORITY`, `HOSTING_PROVIDER` | – | optionale Angaben für Impressum/Datenschutz; der übrige Text steht vorbereitet in `legal/` (eigene Fassung: `LEGAL_DIR`) |
| `PRIVACY_RETENTION_DAYS` | 730 | anonyme Profile ohne Anmeldung werden nach so vielen Tagen ohne Aktivität gelöscht |
| `WORDLE_TZ` / `WORDLE_GROUP_MAX` / `WORDLE_DIR` | Europe/Berlin / 200 / `wordlists` | Wordle: Zeitzone des Tageswechsels, Höchstzahl Mitglieder je Gruppe, Verzeichnis der Wortlisten |
| `LIVE_MAX_PLAYERS` / `LIVE_QUESTION_MS` / `LIVE_REVEAL_MS` / `LIVE_TEMPO_QUESTIONS` / `LIVE_BET_MS` / `LIVE_ESTIMATE_QUESTIONS` / `LIVE_BETWEEN_MS` | 30 / 20000 / 5000 / 10 / 8000 / 8 / 30000 | Live-Spielabend: Höchstzahl Spieler, Fragezeit (Schätzrunde 1,5×), Auflösungszeit (ms), Fragen im Tempo-Quiz, Einsatzphase (ms), Fragen der Schätzrunde, Pause zwischen Serienrunden (ms) |
| `CONSENT_REQUIRED` | 1 | `0` schaltet die Zustimmungspflicht nur für lokale Entwicklung/Tests ab |
| `ANTHROPIC_API_KEY` | – | aktiviert die KI-Schnittstelle (Fragen erzeugen/prüfen, Schwierigkeit schätzen); nie ins Repo, nur als Umgebungsvariable |
| `AI_MODEL` | `claude-sonnet-5-5` | Modell für die KI-Schnittstelle |
| `AI_DAILY_LIMIT` | 100 | Kostenbremse: höchstens so viele neu erzeugte Fragen pro Tag |
| `AI_AUTO` / `AI_AUTO_INTERVAL_HOURS` / `AI_AUTO_BATCH` | 0 / 24 / 20 | Auto-Lauf füllt regelmäßig die größten Lücken (Ergebnis landet immer in der Moderation); auch im Admin-Tab „KI“ schaltbar |
| `DUEL_FORFEIT_DAYS` / `DUEL_REMIND_HOURS` / `DUEL_TAKEOVER_HOURS` | 3 / 24 / 24 | Duelle: Aufgabe bei Inaktivität nach X Tagen (Wartender gewinnt), Push-Erinnerung an den Spieler am Zug nach X Stunden, Bot-Übernahme durch den Wartenden nach X Stunden („Gegen Bot weiterspielen“) |
| `PLAYER_REPORTS` | 1 | `0` schaltet den Melde-Knopf ⚑ für alle Spieler ab (Reviewer-Meldungen und Admin bleiben); jede Person kann ihn zusätzlich im Profil ausblenden |
| `PLAYER_CREATE_LIMIT_PER_HOUR` | 60 | neue anonyme Profile pro IP und Stunde (Missbrauchsschutz; hinter NAT/Schul-WLAN teilen sich viele Nutzer eine IP) |
| `HOST_PORT` / `BIND_ADDRESS` | 3007 / 0.0.0.0 | nur Compose: veröffentlichter Host-Port bzw. Bindeadresse (der Container hört intern auf 3000) |
| `TRUST_PROXY` | 0 | `1`: Client-IP aus `X-Forwarded-For` (Rate-Limits) |
| `PROXY_HOPS` | 1 | Anzahl Proxys vor der App (NPM/Caddy: 1, Cloudflare davor: 2); gezählt von rechts, damit gefälschte Header nichts bringen |
| `BATCH_DIR` | `./batches` | Fragen-Batches, die beim Start automatisch importiert werden |
| `MIN_LANG_QUESTIONS` | 30 | Sprache wird erst ab so vielen aktiven Fragen angeboten |
| `VAPID_SUBJECT` | Repo-URL | Kontakt für Push-Dienste (`mailto:…` oder `https://…`) – für den Betrieb setzen |
| `VAPID_FILE` | `DATA_DIR/vapid.json` | Push-Schlüssel (wird beim ersten Start erzeugt, mit dem Backup sichern) |
| `PUSH_EXTRA_HOSTS` | – | zusätzlich erlaubte Push-Dienst-Hosts (kommagetrennt) |

## Klickbare Demo

`npm run build:demo` baut `demo/demo.html`: eine einzige Datei mit der echten Oberfläche (`web/`), allen Fragen und einem Mini-Server im Browser (`demo/mock.js`, Bot-Gegner, Daten nur im Browser). Sie lässt sich lokal im Browser öffnen oder als Claude-Artifact veröffentlichen. Nach Änderungen an `web/` oder den Batches neu bauen; der Mini-Server bildet die API nach und muss bei neuen Endpunkten ergänzt werden. In der Demo stellst du die Spielstufe im Profil ein; der Bot-Gegner übernimmt sie.

## Fragen

Beim Start werden alle neuen Dateien aus `batches/` importiert (idempotent, dedupliziert, Lizenz geprüft). Neue Batches = Datei ablegen, Container neu starten. Freigegebene Community-Fragen lassen sich per `npm run export:community` (oder `/admin` → „Batch exportieren“) als Batch ins Repo zurückschreiben. Details, Workflow für „200er-Batches auf Abruf“ und die **Lizenzregeln** stehen in [`docs/QUESTIONS.md`](docs/QUESTIONS.md).

Aktueller Bestand: **3778 Fragen** (davon 3556 auch auf Englisch spielbar) (`seed-000` 72, `original-001` 200, `original-002` 106, `original-003` 200, `original-004` 200, `original-005` 200, `original-006` 200, `original-007` 200, `original-008` 200, `original-009` 200, `original-010` 200, `original-011` 200, `original-012` 200, `original-013` 200, `original-014` und `original-017` je 200 Nerd-Fragen, `original-018` und `original-019` je 200 besonders schwere Basis-Fragen, `original-015` und `original-016` je 200 Experten-Fragen), selbst formuliert, CC BY-SA 4.0, über 12 Basis-, 4 Nerd- und 4 Experten-Kategorien und alle Schwierigkeitsgrade verteilt; Englisch bekommt nur *globale* Fragen, rein deutschsprachig relevante (`region: dach`) laufen nur auf Deutsch. Zielbestand 4000 folgt in weiteren Batches; `test/batches.test.ts` prüft bei jedem Lauf alle Dateien auf Format, Lizenz und Dubletten.

### Spielstufen und Extra-Kategorien

Jeder Spieler wählt im Profil sein **Level** – Basis, Nerd (Sci-Fi & Fantasy, Programmieren & IT, Anime & Manga, Retro-Games) oder Experte (MINT & Ingenieurwesen, Geisteswissenschaften, Kunst & Literatur, Informatik) – und kann einzelne Extra-Kategorien abwählen. Im Duell zählt immer die **niedrigste Einstellung** beider Spieler (niedrigstes Level, Schnitt der aktiven Kategorien); beim Spielstart wird die Auswahl im Spiel festgehalten. Details in [`docs/QUESTIONS.md`](docs/QUESTIONS.md).

### Wordle

Tägliches Wordle je Sprache (de/en; alle Spieler dasselbe Wort), ein zusätzliches Wordle pro Tag, **Wordle-Gruppen** beliebiger Größe mit eigenem Tageswort (2 Mitglieder = Duell, Beitritt per Code/Link/QR), **Bestenliste** (global mit Bestenlisten-Namen, je Gruppe) und optionale **Erinnerung um 9 Uhr lokaler Zeit** je Wordle. Nur Buchstaben A–Z (deutsche Wörter mit Ä/Ö/Ü/ß sind entfernt). Wortlisten laden und filtern: `npm run fetch:wordlists` (Ergebnis im Repo: `wordlists/`). Admin-Tab „Wordle“ mit Statistik, Wortsperren und Tageswort-Vorgabe. Details, Quellen und Lizenzen: [`docs/WORDLE.md`](docs/WORDLE.md). Läuft in der Demo (Tages- und Bonus-Wordle); Gruppen, Bestenliste und Erinnerungen brauchen den Server.

### Sofa-Modus

„Neues Spiel → Sofa-Modus“: ein Gerät, 2–8 Spieler; wahlweise **dieselbe Frage für alle** (Standard: nacheinander verdeckt antworten, danach gemeinsame Auflösung, Startspieler rotiert) oder **jeder eine eigene Frage** (3/5/8 Fragen pro Person), ohne QR, ohne Konten und ohne Spielzustand auf dem Server. `GET /api/sofa?lang&n` liefert nur den Fragensatz mit Lösung (der Bestand ist ohnehin über `/api/dataset.jsonl` öffentlich); Namen und Punkte bleiben im Browser, nichts wird gespeichert oder für Statistik/Bestenliste gezählt. Läuft auch in der Demo. Code: `server/sofa.ts`, `sofa()` in `web/app.js`.

### Live-Spielabend (Echtzeit, Beitritt per QR)

Gesellschaftsspiel-Ersatz: Der **Initiator** (Host) öffnet unter „Neues Spiel → Live-Spielabend“ eine Lobby und zeigt einen **QR-Code**; Mitspieler scannen ihn mit der Handy-Kamera und sind dabei (kein Raumcode zum Eintippen; der Token gilt nur in der Lobby, 2 Stunden, und lässt sich erneuern). Modi: **Tempo-Quiz** (feste Fragenzahl, bis zu 1000 Punkte je Frage nach Tempo), **Survival-Leiter** (Leiter-Schwierigkeit, wer falsch antwortet, scheidet aus), **Rennen** (richtig = 1 Feld, die schnellste richtige Antwort +1, wer 12 Felder erreicht gewinnt) und **Einsatz** (vor jeder Frage nur die Kategorie sichtbar, Einsatz 100/300/500/All-in, richtig +Einsatz, falsch −Einsatz, letzte Frage doppelt; Startkapital 1000). **Blitzrunde** (45/60/90 s, jeder arbeitet dieselbe Fragenliste im eigenen Tempo ab: richtig = 1 Punkt, falsch = 2 s Pause; die Handys bekommen die nächste Frage mit der Antwort-Rückgabe, Host/Bildschirm gedrosselt (1×/s) den Zwischenstand; zu schnelle Antworten ohne Lesezeit werden abgelehnt) und **Quizshow** (Kandidat per „Schnellster Finger“ steigt die Millionen-Leiter hoch, alle anderen sind das Publikum und stimmen mit ab; Joker: Publikum und 50:50, Aussteigen jederzeit; Publikum sammelt 100 Punkte je richtiger Stimme; danach nächster Kandidat, bis alle dran waren) und **Schätzrunde** (alle tippen eine Zahl – Jahr, Länge, Anzahl –, eigener Bestand `batches/estimates/*.json` (`ratespass-estimates`, Format in `docs/QUESTIONS.md`); der nächste Tipp bekommt 1000, der zweite 700, der dritte 500 Punkte (sofern weniger als 100 % daneben), alle anderen bis 300 Punkte linear fallend bis 50 % Abweichung; 8 Fragen, ein Tipp pro Frage, früher Abschluss wenn alle getippt haben; kein Einfluss auf Bestenliste/Statistik). **Spielabend-Serie:** statt eines Einzelspiels wählt der Host 2–7 verschiedene Modi als Runden (Vorlagen Klassik/Nervenkitzel/Alle Modi). Nach jeder Runde gibt es **Serienpunkte** nach Platzierung (10/7/5/4/3/2/1, alle weiteren 1) und eine **Zwischenwertung** (Host: „Nächste Runde“, sonst automatisch nach `LIVE_BETWEEN_MS`, Standard 30 s); die Rundenstände werden je Runde zurückgesetzt, die Fragen/Antworten früherer Runden bleiben (mit negativem Index archiviert) für die Statistik erhalten. Gesamtsieger: meiste Serienpunkte, dann Rundensiege, dann bestes Ergebnis der letzten Runde. Teams bleiben über die Serie bestehen und zählen in den Runden mit addierbaren Punkten. **Teams** (2–4) lassen sich bei Tempo, Einsatz, Blitz und Schätzrunde zuschalten (Teamwahl am Handy oder automatisch ausgleichen, Wertung = Durchschnitt je Mitglied). Regeln in `server/live-modes.ts`. Anzeige: **Bildschirm-Modus** (Host-Gerät zeigt Frage und Ergebnisse groß auf TV/Laptop, Handys zeigen nur die Tasten A–D, der Host spielt nicht mit) oder **Handy-Modus** (jedes Handy zeigt die Frage, der Host spielt mit). Es gilt die niedrigste Einstellung aller Mitspieler. Technik: Server-Sent Events über `fetch` (`GET /api/live/:id/events`), Zeitgeber im Server und nach einem Neustart aus der Datenbank wieder aufgenommen; die richtige Antwort wird erst in der Auflösung gesendet. **Hinter einem Reverse-Proxy darf die Antwort nicht gepuffert werden:** Caddy (`flush_interval -1`, siehe `Caddyfile`), nginx/NPM (`proxy_buffering off`; der Server setzt zusätzlich `X-Accel-Buffering: no`). Einzelinstanz-Annahme (SQLite, ein Container). Live-Antworten zählen für die Bestenliste als „gegen Menschen“. Code: `server/live.ts`, Tests: `test/live.test.ts`; in der Demo nicht verfügbar.

### Bestenlisten (Opt-in)

Unter „🏆 Bestenliste“ (Startseite) kann man freiwillig mit einem **eigenen Bestenlisten-Namen** teilnehmen – oder auf ausdrücklichen Wunsch (Häkchen) mit dem eigenen **Anzeigenamen** (zieht bei Umbenennung mit; Namen sind eindeutig, 3–20 Zeichen – ist der neue Name dort vergeben oder ungültig, bleibt der bisherige Name und die Verknüpfung endet). **Absolut** = richtig beantwortete Fragen, **Quote** = gewusst/(gewusst + nicht gewusst) ab 100 Antworten; je Woche/Monat/Gesamt, jeweils „mit Bot-Spielen“ oder „nur gegen Menschen“ (ohne Bot-Duelle und Solo-Leiter). Bot-Schutz Basis: plausible Lesezeit, Tages- und Stundenlimit, Wertung erst ab 24 h Profilalter und 50 Antworten, Auffälligkeits-Liste mit manueller Sperre im Admin (Tab „Bestenliste“). Stärkere Maßnahmen als Plan: [`docs/BOTSCHUTZ.md`](docs/BOTSCHUTZ.md). Code: `server/leaderboard.ts`, Tests: `test/leaderboard.test.ts`.

### Datenschutz und Zustimmung

Beim ersten Aufruf zeigt die App die Datenschutzerklärung (Kurzfassung + Volltext) und verlangt eine **nicht vorangekreuzte Zustimmung** inkl. Altersbestätigung (16 Jahre bzw. Sorgeberechtigte). Die Zustimmung wird mit Zeitpunkt und **Version** dokumentiert; die Version ist die Prüfsumme des gesamten Textes (de + en, inkl. der Verantwortlichen-Angaben aus den Umgebungsvariablen und der aktiven Funktionen). Der Wortlaut jeder Version wird archiviert. Gefragt wird nur beim ersten Mal und erneut, wenn sich der Text ändert; der Server sperrt die API bis zur Zustimmung. Widerruf = „Zustimmung widerrufen und Profil löschen“ im Profil. Details und Betreiberpflichten: [`docs/DATENSCHUTZ.md`](docs/DATENSCHUTZ.md). Code: `server/privacy.ts`, `server/erase.ts`, Tests: `test/privacy.test.ts`.

### KI-Schnittstelle (Fragen-Nachschub und Schwierigkeit)

Mit `ANTHROPIC_API_KEY` bietet der Admin-Tab **KI** (Code: `server/ai.ts`, Tests: `test/ai.test.ts`): einen **Plan** (Soll-Ist je Kategorie und Schwierigkeit aus einer einstellbaren Zielverteilung, Standard 25/40/35 % leicht/mittel/schwer und mindestens 100 Fragen je Kategorie – „mehr schwere Fragen“ = Prozentwerte verschieben), **Lücken füllen** (Fragen auf Deutsch und Englisch erzeugen, danach ein getrennter Prüfdurchlauf für Fakten/Eindeutigkeit/Zeitlosigkeit; alles Zweifelhafte wird verworfen), **Schwierigkeit schätzen** (KI-Einschätzung mit Sicherheitswert für bestehende Fragen) und **Schätzungen übernehmen** (ab wählbarer Sicherheit, wird in `edits` protokolliert). Neue KI-Fragen sind immer `pending` in der Moderation und lassen sich nach der Freigabe als `ai-NNN`-Batch exportieren (`source: llm`, CC BY-SA 4.0). Ein optionaler Auto-Lauf arbeitet die größten Lücken ab; ein Tageslimit begrenzt die Kosten. Gemessene Lösungsquoten (Statistik-Tab) und KI-Schätzungen ergänzen sich: Ab genug Antworten gilt die Messung. In der Entwicklungsumgebung nicht gegen die echte API getestet (Tests nutzen eine Fake-API).

### Geburtsjahr und Statistik „Lösungen vs. Alter“

Im Profil kann man **freiwillig** sein Geburtsjahr eintragen (nur das Jahr, jederzeit löschbar; Hinweis auch in „Impressum & Datenschutz“). Der Admin-Tab **Statistik** wertet alle Antworten menschlicher Spieler aus Duellen, Millionen-Leiter und Mehrspieler-Runden aus: Lösungsquote je Schwierigkeit und Altersgruppe (<18, 18–29, 30–44, 45–59, 60+, keine Angabe; Gruppen unter 5 Antworten werden nicht angezeigt) sowie je Frage mit einem Vorschlag für die Schwierigkeit (ab 75 % richtig = leicht, ab 50 % = mittel, darunter schwer; Ratequote 25 %). Vorschläge lassen sich einzeln oder gesammelt übernehmen und werden wie andere Admin-Korrekturen in `edits` protokolliert. Code: `server/stats.ts`, Tests: `test/stats.test.ts`.

### Millionen-Leiter (Solo)

Quiz-Modus „Millionen-Leiter“ (Neues Spiel → Millionen-Leiter): 15 Fragen mit steigender Schwierigkeit (1–5 leicht, 6–10 mittel, 11–15 schwer), Beträge von 100 bis 1.000.000 „Ratetaler“, Sicherheitsstufen bei Frage 5 und 10, **Aussteigen** sichert den aktuellen Betrag, eine falsche Antwort wirft auf die letzte Sicherheitsstufe zurück. Zeit je Frage 30/45/60 s, vom Server überwacht; Joker gibt es bewusst (noch) nicht. Der Fragenpool folgt deiner Spielstufe und deinen Extra-Kategorien. Name und Währung sind eigene Wortschöpfungen – das Fernsehformat und seine Fragen sind geschützt und werden nicht verwendet. Code: `server/ladder.ts`, Tests: `test/ladder.test.ts`.

### Mehrspieler-Runden (asynchron)

Unter „Neues Spiel → Mehrspieler“ legt man eine **Quiz-Runde** (12 Fragen, je 4 leicht/mittel/schwer; Wertung = richtige Antworten, bei Gleichstand die schnellere Zeit) oder einen **Leiter-Wettkampf** (alle steigen dieselbe Millionen-Leiter hoch; Wertung = erreichter Betrag) an. 2–6 Spieler treten per Raumcode oder Link (`/#/join/CODE`) bei; der Gastgeber startet. Alle spielen dieselben Fragen im eigenen Tempo (Zeit je Frage serverseitig); bis zum Ende sehen die anderen nur den Fortschritt, nicht Antworten oder Punkte. Die Runde endet, sobald alle fertig sind, spätestens nach 48 Stunden (dann zählt der aktuelle Stand; Lobbys verfallen nach 24 Stunden). Es gilt die niedrigste Einstellung aller Teilnehmer (Level, Schnitt der Extra-Kategorien). Push-Nachrichten: „Runde gestartet“ und „Runde beendet“. Code: `server/rooms.ts`, Tests: `test/rooms.test.ts`. Live-Räume in Echtzeit sind als nächste Phase geplant.

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
