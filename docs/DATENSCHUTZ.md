# Datenschutz: Konfiguration, Zustimmung, Nachweis

> Technische Umsetzung, **keine Rechtsberatung**. Vor dem öffentlichen Betrieb Text und Prozesse juristisch prüfen lassen (Impressum § 5 DDG, DSGVO, ggf. Auftragsverarbeitung mit dem Hoster, Verzeichnis von Verarbeitungstätigkeiten, Datenschutzbeauftragte/r).

## Pflichtangaben (Umgebungsvariablen)

| Variable | Zweck |
|---|---|
| `CONTROLLER_NAME`, `CONTROLLER_ADDRESS`, `CONTROLLER_EMAIL` | Verantwortlicher / Impressum (Pflicht). Fehlen sie, erscheint „[nicht konfiguriert: …]“ im Text, `GET /api/admin/stats` meldet `privacy_missing`, der Server warnt beim Start. |
| `CONTROLLER_PHONE`, `DPO_CONTACT`, `HOSTING_PROVIDER` | optional (Telefon, Datenschutzbeauftragte/r, Hoster inkl. Standort) |
| `PRIVACY_RETENTION_DAYS` | Speicherdauer anonymer Profile ohne Aktivität (Standard 730 Tage) |

## Wie die Zustimmung funktioniert

1. `server/privacy.ts` baut Erklärung + Impressum (de/en) aus Konfiguration und aktiven Funktionen (z. B. KI-Hinweis nur mit `ANTHROPIC_API_KEY`). `version` = SHA-256 des gesamten Textes.
2. Erster Aufruf: Zustimmungsbildschirm (nicht vorangekreuzt, Altersbestätigung, Volltext lesbar, Ablehnen möglich). `POST /api/players` verlangt `consent: {version, age_ok: true}` mit der **aktuellen** Version.
3. Nachweis: Tabelle `consents` (Spieler, Version, Zeitpunkt, Altersbestätigung, Sprache) und `privacy_versions` (voller Wortlaut je Version, Zeitpunkt der ersten Auslieferung). Auswertung: `GET /api/admin/stats` → `consents` (Zahl je Version).
4. Ändert sich der Text (auch durch geänderte Env-Werte oder neue Funktionen), ändert sich die Version: Alle Spieler stimmen **einmal** erneut zu; bis dahin antwortet die API mit `403 consent_required` (Ausnahmen: Profil abrufen, Zustimmen, Export, Abmelden, Löschen).
5. Widerruf (Art. 7 Abs. 3): Profil → „Zustimmung widerrufen und Profil löschen“. Das entfernt Zugang, Kontakte, Konto, Geburtsjahr, Bestenlisten-Name und die Zustimmungszeilen des Profils.

## Speicherbegrenzung
Anonyme Profile ohne Konto werden nach `PRIVACY_RETENTION_DAYS` ohne Aktivität automatisch gelöscht (`server/erase.ts`, stündlicher Sweep). Wartende Spiele verfallen nach 24 h, Mehrspieler-Runden werden nach 48 h ausgewertet, inaktive Duelle nach 7 Tagen beendet.

## Auskunft / Löschung auf Anfrage
Spieler laden ihr Profil selbst herunter (Profil → „Profil & Verlauf herunterladen“). Für Anfragen per E-Mail: öffentliche ID aus dem Profil verlangen, Zeilen in `players`, `games`, `answers`, `ladders`, `room_*`, `consents` zuordnen; Löschen entspricht „Profil löschen“ (`erasePlayer`).
