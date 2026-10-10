# Wordle

Tägliches Wortspiel in zwei Sprachen (de/en): 5 Buchstaben, 6 Versuche. Code: `server/wordle.ts` (Spiel, Gruppen, Bestenlisten, Erinnerungen, Admin), `server/wordle-words.ts` (Wortfilter), `tools/fetch-wordlists.ts` (Wortlisten laden), Oberfläche `wordle*()` in `web/app.js`, Admin-Tab „Wordle“, Tests `test/wordle*.test.ts`.

## Spielarten
- **Tägliches Wordle** je Sprache: alle Spieler bekommen am selben Tag dasselbe Wort (Tageswechsel in `WORDLE_TZ`, Standard Europe/Berlin). Das Wort wird beim ersten Zugriff gezogen und gespeichert; innerhalb von 365 Tagen wiederholt es sich nicht.
- **Kein Bonus-Wordle:** zusätzliche Wörter gibt es nur über Gruppen (früherer Bonus ist entfernt; Migration v18 löscht alte Bonus-Spiele).
- **Gruppen**: feste Spielgruppen, in denen man nur **ein- und austreten** kann – Punkte werden weder mitgebracht noch mitgenommen (Beitritt startet bei 0, Austritt löscht die eigenen Gruppenspiele und -shares, Wiedereintritt beginnt wieder bei 0). Beliebig viele Mitglieder (Obergrenze `WORDLE_GROUP_MAX`, Standard 200, je Spieler höchstens 30 Gruppen), jede Gruppe hat ihr **eigenes, unabhängiges Tageswort**. Beitritt per Code oder Link `/#/wordle/join/CODE` (mit QR). Ein **Duell** ist eine Gruppe mit zwei Mitgliedern: „Duell mit Bekanntem“ legt sie an und lädt die Person per Push ein.
- **Dauerwertung der Gruppe** (Gesamt, Monat, Woche, Tag; Standard Gesamt): Rang nach Punkten, dann Ø Versuche, dann Siege. Wer an einem Tag nicht spielt, bekommt dafür 0 Punkte; `verpasst` zählt die vergangenen Tage seit Beitritt ohne beendetes Spiel (heute zählt nicht). Dazu „Stand heute“ (wer hat gespielt, wer fehlt noch) und die aktuelle Serie. Das Farbraster der anderen sieht man erst, wenn man selbst heute fertig ist (nur Markierungen, nie Buchstaben).
- **Ergebnis teilen:** nach dem Tages-Wordle als Emoji-Text (System-Teilen/Kopieren) und **in der App** an einen Kontakt oder in eine eigene Gruppe (`POST /api/wordle/share`, nur eigenes beendetes Tages-Wordle; Eingang `GET /api/wordle/inbox`, Feed in der Gruppenansicht). Gespeichert werden nur Ausgang, Versuche und Markierungen; 14 Tage Aufbewahrung. **Spoilerregel:** das Raster sieht nur, wer dasselbe Tages-Wordle (Sprache + Tag) selbst beendet hat.
- **Bestenlisten**: global je Sprache (nur Tages-Wordle, nur Spieler mit Bestenlisten-Namen aus der Quiz-Bestenliste, Zeiträume Tag/Woche/Monat/gesamt) und je Gruppe (alle Mitglieder, Anzeigenamen).
- **Punkte**: gelöst im k-ten Versuch = 7 − k (6 … 1), nicht gelöst = 0; bei Gleichstand zählt der Ø der Versuche. **Serie** = aufeinanderfolgende Tage mit gelöstem Tages-Wordle.

## Schrift
Kacheln, Tastatur und Meldungen im Wordle nutzen **Clear Sans Bold** (Intel, Apache-2.0; Teilmenge als `web/fonts/ClearSans-Bold.woff2`, Lizenztext `web/fonts/ClearSans-LICENSE.txt`) statt der Systemschrift; die übrige App bleibt bei der Systemschrift.

**Layout:** Der Wordle-Spielbildschirm (Raster, Tastatur, Ergebnis) passt ohne Scrollen auf Handys ab 360×640; Raster- und Tastengrößen folgen der Fensterhöhe, nach dem Spielende ersetzt die Ergebnis-Karte die Tastatur.

## Regeln und Konvention
- Das gesuchte Wort verlässt den Server erst nach Spielende; die Auswertung (richtig / falsche Stelle / nicht enthalten, Doppelbuchstaben korrekt) geschieht nur dort. Eingaben müssen in der Rateliste stehen; zwischen zwei Versuchen liegen mindestens 300 ms.
- **Nur Buchstaben A–Z.** Deutsche Wörter mit Ä, Ö, Ü oder ß sind aus den Listen entfernt (nicht umgeschrieben); das steht auch im Spielfenster.

## Wortlisten
`npm run fetch:wordlists` lädt Listen aus dem Netz, filtert auf genau 5 Buchstaben a–z und schreibt `wordlists/<lang>.words.txt` (gültige Eingaben) und `<lang>.solutions.txt` (mögliche Tageswörter, häufige echte Wörter; Eigennamen, Fremdwörter und manuelle Sperren aus `wordlists/blocklist.<lang>.txt` ausgenommen). Die Dateien liegen im Repo und im Docker-Image; beim Start liest der Server neue Wörter in die Datenbank (Sperren aus dem Admin bleiben bestehen). Ein Verzeichnis außerhalb des Repos geht per `WORDLE_DIR`.

| Quelle | Verwendung | Lizenz |
|---|---|---|
| [tabatkins/wordle-list](https://github.com/tabatkins/wordle-list) | englische Rateliste | MIT |
| [lorenbrichter/Words](https://github.com/lorenbrichter/Words) | deutsche Wörterliste (Groß-/Kleinschreibung) | CC0 |
| [hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords) (2018, 50k) | Häufigkeiten de/en | MIT (laut README; Quelle: OpenSubtitles) |
| [dominictarr/random-name](https://github.com/dominictarr/random-name) | Vornamen (aus den Lösungen entfernt) | MIT |

Die Lösungslisten sind maschinell gefiltert und enthalten trotzdem ungeeignete Wörter (Namen, Anstößiges, Konjugationen, Fremdwörter). Solche Wörter im Admin-Tab sperren oder in `wordlists/blocklist.<lang>.txt` eintragen (`wort` = nur nicht als Tageswort, `!wort` = auch nicht als Eingabe). Lizenzangaben bitte vor einer Veröffentlichung noch einmal an den Quellen prüfen.

## Erinnerung um 9 Uhr (optional)
Pro Wordle einschaltbar (tägliches Wordle je Sprache, jede Gruppe): Glocke im Wordle-Hub bzw. in der Gruppe. Beim Einschalten aktiviert die App bei Bedarf die Push-Benachrichtigungen des Geräts und meldet die Zeitzone des Browsers; um 9:00–9:59 **lokaler** Zeit sendet der Server (Prüfung minütlich) genau eine Nachricht je Wordle und lokalem Tag – nicht, wenn man das Wordle schon gespielt hat. Standard: aus. Mit gespeicherter Serie: „Halte deine Serie …“.

## Admin
Tab **Wordle**: aktive Spieler (heute/7/30 Tage), Spiele, Gruppen, Erinnerungen; je Sprache der Verlauf der letzten 14 Tage (Wort, Spiele, Lösungsquote, Ø Versuche, Verteilung 1–6/✗); kommende Tageswörter und **Wort für einen künftigen Tag festlegen** (heute nur, solange niemand gespielt hat); **Wortlisten** durchsuchen, Wörter sperren/freigeben, Listen neu laden; aktivste Gruppen; Auffälligkeiten (oft im 1. Versuch oder in unter 5 s gelöst – Hinweise, keine Beweise).

## Datenschutz
Neu gespeichert werden Versuche/Ergebnisse je Spiel, Gruppen und Mitgliedschaften, geteilte Ergebnisse (14 Tage) und – nur bei eingeschalteter Erinnerung – die Zeitzone des Geräts. Gruppenmitglieder sehen Anzeigenamen und den Stand des Gruppen-Wordles des Tages; die globale Bestenliste zeigt nur den Bestenlisten-Namen. Beim Verlassen einer Gruppe werden die zugehörigen Spiele und dorthin geteilte Ergebnisse entfernt, beim Profil-Löschen alles Wordle-Bezogene. Der Text in `legal/` beschreibt das (neue Version, einmalige erneute Zustimmung).
