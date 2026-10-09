// Datenschutzerklärung und Impressum, zusammengesetzt aus der Konfiguration des Betreibers (Umgebungsvariablen) und den aktiven Funktionen.
// `version` ist die Prüfsumme des gesamten Textes (de + en): Ändert sich Text, Verantwortlicher oder eine Funktion, ändert sich die Version
// und alle Spieler stimmen einmal erneut zu – sonst nie. Jede ausgelieferte Version wird mit vollem Text archiviert (Nachweis der Zustimmung).
// Hinweis: Das ist eine technische Vorlage, keine Rechtsberatung – bitte vor dem öffentlichen Betrieb prüfen lassen.
import { sha256 } from './auth.ts'
import { config } from './config.ts'
import { all, get, run, now } from './db.ts'

export interface Section { title: string; paras?: string[]; items?: string[] }
export interface Doc { title: string; summary: string[]; sections: Section[] }
export interface Privacy { version: string; de: Doc; en: Doc; missing: string[] }

const todo = (name: string, v: string) => (v || `[nicht konfiguriert: ${name}]`)

export function missingSettings(): string[] {
  const p = config.privacy
  return [['CONTROLLER_NAME', p.controllerName], ['CONTROLLER_ADDRESS', p.controllerAddress], ['CONTROLLER_EMAIL', p.controllerEmail]].filter(([, v]) => !v).map(([k]) => k)
}

export function buildPrivacy(): Privacy {
  const p = config.privacy
  const ai = !!config.ai.key
  const contact = [todo('CONTROLLER_NAME', p.controllerName), todo('CONTROLLER_ADDRESS', p.controllerAddress), 'E-Mail: ' + todo('CONTROLLER_EMAIL', p.controllerEmail), p.controllerPhone && 'Telefon: ' + p.controllerPhone].filter(Boolean) as string[]
  const contactEn = [todo('CONTROLLER_NAME', p.controllerName), todo('CONTROLLER_ADDRESS', p.controllerAddress), 'Email: ' + todo('CONTROLLER_EMAIL', p.controllerEmail), p.controllerPhone && 'Phone: ' + p.controllerPhone].filter(Boolean) as string[]
  const host = p.hosting || '[nicht konfiguriert: HOSTING_PROVIDER]'
  const years = (p.retentionDays / 365).toFixed(p.retentionDays % 365 ? 1 : 0)

  const de: Doc = {
    title: 'Impressum & Datenschutz',
    summary: [
      'Du spielst mit einem anonymen Profil: Anzeigename, Spielstand und deine Antworten werden gespeichert. Kein Tracking, keine Werbung, keine Cookies.',
      'Mitspieler sehen deinen Anzeigenamen. Geburtsjahr und Bestenliste sind freiwillig und nur mit eigener Entscheidung aktiv.',
      'Du kannst die Zustimmung jederzeit widerrufen: „Profil löschen“ entfernt deine Daten.',
    ],
    sections: [
      { title: 'Verantwortlicher und Impressum (§ 5 DDG)', paras: [contact.join(', ')].concat(p.dpoContact ? ['Datenschutzbeauftragte/r: ' + p.dpoContact] : []) },
      { title: 'Was diese App speichert', items: [
        'Anonymes Profil: zufälliger Freundescode, frei gewählter Anzeigename, Sprache, Spielstufe und Kategorie-Auswahl, ein geheimer Zugangsschlüssel (im Browser, auf dem Server nur als Hash).',
        'Spielverlauf: Spiele, Runden, Antworten (richtig/falsch, Antwortzeit), Ergebnisse, Millionen-Leiter-Stände, Kontakte (Freundescodes), die du hinzufügst.',
        'Optional: Benutzername und Passwort (als Hash), Geburtsjahr (nur das Jahr), Bestenlisten-Name, Push-Abo deines Browsers, Reviewer-Rolle.',
        'Technisch: IP-Adressen nur flüchtig im Arbeitsspeicher für Missbrauchsschutz (Rate-Limits); der Browser speichert Zugangsschlüssel und Einstellungen lokal (technisch notwendig, keine Tracking-Cookies).',
      ] },
      { title: 'Zwecke und Rechtsgrundlagen', items: [
        'Betrieb des Spiels und Matchmaking (Art. 6 Abs. 1 lit. b DSGVO).',
        'Missbrauchsschutz, Sicherheit und Fehleranalyse (Art. 6 Abs. 1 lit. f DSGVO).',
        'Deine Zustimmung (Art. 6 Abs. 1 lit. a DSGVO) für die Nutzung der App mit anonymem Profil, für das freiwillige Geburtsjahr und für die Teilnahme an der Bestenliste; sie ist jederzeit mit Wirkung für die Zukunft widerrufbar.',
        'Anonyme statistische Auswertung, wie schwer Fragen für Altersgruppen sind (nur mit freiwilligem Geburtsjahr; Gruppen unter 5 Antworten werden nicht ausgewertet).',
      ] },
      { title: 'Was andere sehen', items: [
        'Gegner und Mitspieler in Duellen, Runden und Live-Spielen sehen deinen Anzeigenamen und das Spielergebnis.',
        'In der Bestenliste erscheint nur der eigene Bestenlisten-Name – und nur, wenn du aktiv teilnimmst. Du kannst die Teilnahme jederzeit beenden; der Name wird sofort entfernt.',
        'Von dir eingereichte Community-Fragen werden mit deiner Zustimmung unter CC BY-SA 4.0 veröffentlicht; dein Name wird nicht genannt.',
      ] },
      { title: 'Empfänger und Hosting', paras: ['Hosting: ' + host + '. Der Hoster verarbeitet Daten in unserem Auftrag.', ai ? 'KI-Funktionen: Fragen werden mit einem KI-Dienst erstellt und geprüft. Dabei werden keine Daten von Spielerinnen und Spielern übermittelt.' : 'Es werden keine Daten an KI-Dienste übermittelt.', 'Push-Nachrichten laufen über den Push-Dienst deines Browsers/Betriebssystems, sofern du sie aktivierst.'] },
      { title: 'Speicherdauer', items: [
        `Anonyme Profile ohne Anmeldung werden nach ${years} ${p.retentionDays % 365 ? 'Jahren' : 'Jahr(en)'} ohne Aktivität gelöscht.`,
        'Wartende Spiele verfallen nach 24 Stunden, Mehrspieler-Runden werden spätestens nach 48 Stunden ausgewertet, inaktive Spiele nach 7 Tagen beendet.',
        'Mit „Profil löschen“ werden Zugang, Kontakte, Konto, Geburtsjahr, Bestenlisten-Name und deine Zustimmungsdokumentation sofort entfernt; abgeschlossene Spiele bleiben für Gegner anonymisiert (Name „—“).',
      ] },
      { title: 'Deine Rechte', items: [
        'Auskunft und Datenübertragbarkeit: Profil → „Profil & Verlauf herunterladen“; zusätzlich per E-Mail an den Verantwortlichen.',
        'Berichtigung (Anzeigename, Geburtsjahr im Profil), Löschung („Profil löschen“), Einschränkung und Widerspruch gegen Verarbeitungen nach Art. 6 Abs. 1 lit. f.',
        'Widerruf der Zustimmung jederzeit; die Rechtmäßigkeit der bisherigen Verarbeitung bleibt unberührt.',
        'Beschwerde bei einer Datenschutz-Aufsichtsbehörde.',
      ] },
      { title: 'Alter und Zustimmung', paras: ['Die Nutzung setzt voraus, dass du mindestens 16 Jahre alt bist oder die Zustimmung deiner Sorgeberechtigten hast (Art. 8 DSGVO). Deine Zustimmung wird mit Zeitpunkt und Version dieses Textes dokumentiert. Du wirst nur dann erneut gefragt, wenn sich dieser Text ändert.'] },
    ],
  }
  const en: Doc = {
    title: 'Legal notice & privacy',
    summary: [
      'You play with an anonymous profile: display name, progress and your answers are stored. No tracking, no ads, no cookies.',
      'Other players see your display name. Birth year and leaderboard are optional and only active if you choose them.',
      'You can withdraw your consent at any time: “Delete profile” removes your data.',
    ],
    sections: [
      { title: 'Controller and legal notice (§ 5 DDG)', paras: [contactEn.join(', ')].concat(p.dpoContact ? ['Data protection officer: ' + p.dpoContact] : []) },
      { title: 'What this app stores', items: [
        'Anonymous profile: random friend code, display name of your choice, language, play level and category selection, a secret access key (in your browser, stored on the server only as a hash).',
        'Play history: games, rounds, answers (right/wrong, response time), results, million ladder progress, contacts (friend codes) you add.',
        'Optional: username and password (hashed), birth year (year only), leaderboard name, your browser’s push subscription, reviewer role.',
        'Technical: IP addresses only transiently in memory for abuse protection (rate limits); your browser stores the access key and settings locally (technically necessary, no tracking cookies).',
      ] },
      { title: 'Purposes and legal bases', items: [
        'Operating the game and matchmaking (Art. 6(1)(b) GDPR).',
        'Abuse protection, security and error analysis (Art. 6(1)(f) GDPR).',
        'Your consent (Art. 6(1)(a) GDPR) to use the app with an anonymous profile, for the optional birth year and for taking part in the leaderboard; you can withdraw it at any time with effect for the future.',
        'Anonymous statistics on how hard questions are for age groups (only with the optional birth year; groups under 5 answers are not evaluated).',
      ] },
      { title: 'What others can see', items: [
        'Opponents and fellow players in duels, rounds and live games see your display name and the result.',
        'The leaderboard shows only your leaderboard name – and only if you actively take part. You can stop at any time; the name is removed immediately.',
        'Community questions you submit are published under CC BY-SA 4.0 with your consent; your name is not mentioned.',
      ] },
      { title: 'Recipients and hosting', paras: ['Hosting: ' + host + '. The host processes data on our behalf.', ai ? 'AI features: questions are created and checked with an AI service. No player data is transmitted in the process.' : 'No data is transmitted to AI services.', 'Push messages go through your browser’s/operating system’s push service if you enable them.'] },
      { title: 'Retention', items: [
        `Anonymous profiles without an account are deleted after ${years} year(s) without activity.`,
        'Waiting games expire after 24 hours, multiplayer rounds are evaluated after 48 hours at the latest, inactive games end after 7 days.',
        'With “Delete profile”, access, contacts, account, birth year, leaderboard name and your consent record are removed immediately; finished games remain anonymised for opponents (name “—”).',
      ] },
      { title: 'Your rights', items: [
        'Access and data portability: Profile → “Download profile & history”; additionally by email to the controller.',
        'Rectification (display name, birth year in your profile), erasure (“Delete profile”), restriction and objection to processing under Art. 6(1)(f).',
        'Withdrawal of consent at any time; the lawfulness of earlier processing remains unaffected.',
        'Complaint to a data protection supervisory authority.',
      ] },
      { title: 'Age and consent', paras: ['Use requires that you are at least 16 years old or have your guardians’ consent (Art. 8 GDPR). Your consent is documented with time and version of this text. You are only asked again if this text changes.'] },
    ],
  }
  return { version: sha256(JSON.stringify({ de, en })), de, en, missing: missingSettings() }
}

/** Aktueller Text; jede Version wird beim ersten Ausliefern mit vollem Wortlaut archiviert. */
export function currentPrivacy(): Privacy {
  const p = buildPrivacy()
  if (!get('SELECT 1 FROM privacy_versions WHERE version=?', p.version)) run('INSERT INTO privacy_versions(version,text_json,first_seen) VALUES(?,?,?)', p.version, JSON.stringify({ de: p.de, en: p.en }), now())
  return p
}

export interface ConsentState { current: string; accepted: string | null; at: number | null }
export function consentState(playerId: number): ConsentState {
  const cur = currentPrivacy().version
  const c = get<{ version: string; accepted_at: number }>('SELECT version, accepted_at FROM consents WHERE player_id=? ORDER BY id DESC LIMIT 1', playerId)
  return { current: cur, accepted: c?.version ?? null, at: c?.accepted_at ?? null }
}
export const hasConsent = (playerId: number) => { const s = consentState(playerId); return s.accepted === s.current }

export function recordConsent(playerId: number, version: unknown, ageOk: unknown, lang: unknown) {
  const cur = currentPrivacy().version
  if (version !== cur) return 'changed' as const
  if (ageOk !== true) return 'age' as const
  run('INSERT INTO consents(player_id,version,accepted_at,age_ok,lang) VALUES(?,?,?,?,?)', playerId, cur, now(), 1, typeof lang === 'string' ? lang.slice(0, 5) : null)
  return 'ok' as const
}

export const consentStats = () => all<{ version: string; n: number; first_seen: number }>(
  'SELECT c.version, COUNT(DISTINCT c.player_id) n, v.first_seen FROM consents c JOIN privacy_versions v ON v.version=c.version GROUP BY c.version ORDER BY v.first_seen DESC')
