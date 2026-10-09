# Bot- und Betrugsschutz für die Bestenliste

Ziel: Die Bestenliste soll für Menschen fair bleiben. Bei einem Trivia-Spiel lässt sich ein KI-Bot, der über die normale Oberfläche antwortet, **nicht vollständig ausschließen** – realistisch sind höhere Kosten für Bots und statistische Erkennung. Deshalb gestuft.

## Stufe 1 – umgesetzt (`server/leaderboard.ts`)
- **Opt-in mit eigenem Namen:** Nur wer aktiv teilnimmt, erscheint; der normale Anzeigename bleibt privat.
- **Plausible Lesezeit:** Nur Antworten mit Reaktionszeit ≥ 600 ms + 2 ms je Zeichen der Frage zählen für die Wertung (Bots, die sofort antworten, scheiden aus).
- **Mengenbegrenzung:** höchstens 400 gewertete Antworten pro Tag und 120 pro Stunde je Spieler.
- **Wartezeit und Mindestmenge:** sichtbar erst ab 24 h Profilalter und 50 gewerteten Antworten (relative Wertung ab 100).
- **Zwei Zählweisen:** „nur gegen Menschen“ schließt Bot-Duelle und die Solo-Leiter aus – das trifft die einfachste Farm-Strategie.
- **Auffälligkeits-Erkennung (Admin → Bestenliste):** Quote > 97 %; Quote deutlich über dem Durchschnitt aller Spieler bei *denselben* Fragen (Fragenquoten aus echten Antworten); sehr gleichförmige Antwortzeiten (Variationskoeffizient < 0,12); Aktivität in ≥ 22 verschiedenen Tagesstunden. Nur Hinweise – gesperrt wird **manuell** (Sperre entfernt den Namen und verhindert erneute Teilnahme), weil starke Spieler sonst zu Unrecht getroffen würden.
- Bestehende Rate-Limits (Profile pro IP, Beitritts-/Meldungs-Limits).

## Stufe 2 – geplant (bei Bedarf)
1. **Konto/Passkey nur für die Liste:** Teilnahme setzt ein Konto (später Passkey/WebAuthn) voraus; hebt die Kosten für Massen-Profile deutlich.
2. **Proof-of-Work beim Opt-in:** Hashcash (SHA-256 per WebCrypto im Browser, serverseitig geprüft), Schwierigkeit adaptiv bei vielen neuen Teilnehmern. Kein externer Captcha-Dienst (passt zu „kein Tracking“).
3. **Köderfragen:** gelegentlich Fragen einstreuen, deren richtige Antwort sich nicht per Suche/LLM ermitteln lässt (frisch erfundene Fakten mit im Vorfeld bekannter Lösung, z. B. aus der laufenden Live-Runde); wer sie „weiß“, ist auffällig.
4. **Antwort-Streuung und Fragenrotation:** Antworten sind schon pro Frage durchgemischt; zusätzlich Fragenpool je Spieler/Woche variieren, damit Lookup-Bots keinen festen Katalog aufbauen.
5. **Anwesenheits-Wertung:** eigene „Turnier“-Liste nur aus Live-Runden mit QR-Beitritt (Menschen in einem Raum).
6. **Verhaltensmerkmale:** Wischen/Tippen-Muster, Fokuswechsel, Antwortzeit-Verteilung gegen Lesezeit; nur anonym und aggregiert, mit Hinweis in der Datenschutzerklärung.
7. **Regelmäßige Neubewertung:** Schwellen aus echten Daten nachziehen (Statistik-Tab), alte Auffälligkeiten erneut prüfen.

Jede neue Maßnahme, die zusätzliche Daten erhebt, muss in `server/privacy.ts` beschrieben werden (ändert die Version und löst eine einmalige erneute Zustimmung aus).
