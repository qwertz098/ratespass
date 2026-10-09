# Online stellen (kostenlos oder fast kostenlos)

## Kurzantwort zu GitHub

- **GitHub Pages geht nicht.** Pages liefert nur statische Dateien. Ratespaß braucht einen laufenden Server (Spiellogik, Datenbank, Push).
- **GitHub kann trotzdem helfen:** Der Code liegt dort, `ci.yml` testet jeden Push, und `publish.yml` baut das Docker-Image und legt es kostenlos in der **GitHub Container Registry** ab (`ghcr.io/qwertz098/ratespass`). Dort wird nur das Image *gespeichert* – laufen muss es woanders.
- Codespaces sind Entwicklungsumgebungen und kein Dauerhosting.

## Was der Server braucht

| | |
|---|---|
| RAM | gemessen ca. 90 MB (Node 22, nach längeren Testläufen) |
| Speicher | SQLite-Datei (aktuell ~1 MB mit 756 Fragen) + VAPID-Schlüssel in `/data` – **muss dauerhaft sein** |
| HTTPS | **Pflicht** für PWA-Installation, Push und Kamera-Scan (außer `localhost`) |
| Netz | ausgehend HTTPS zu den Push-Diensten (FCM, Mozilla, Apple, Microsoft) |

## Optionen im Vergleich

Stand der Websuche vom Oktober 2026 – Anbieter ändern Bedingungen oft, die Quellen sind teils Vergleichsseiten. **Vor dem Einrichten die Preisseite des Anbieters prüfen.**

| Option | Kosten | Daten bleiben? | Bemerkung |
|---|---|---|---|
| **Eigener Rechner / Raspberry Pi / NAS + Cloudflare Tunnel** | 0 € (Strom; Domain nötig) | ja | HTTPS ohne Portfreigabe, funktioniert auch hinter CGNAT. Der Rechner muss durchlaufen. Domain muss bei Cloudflare liegen (laut Quellen). |
| **Oracle Cloud „Always Free“ VM** | 0 € (Kreditkarte zur Verifizierung) | ja (Block-/Boot-Volume) | Eigene VM, Docker darauf. Laut Quellen widersprüchliche Limits (4 vs. 2 OCPU Arm) – für diese App egal. Berichte, dass ungenutzte Gratis-Instanzen zurückgenommen werden → **Backups**. |
| **Fly.io** | Gratis-Kontingent für Neukunden unklar | ja (Volumes) | Prüfen, ob für neue Konten noch kostenlos. |
| **Render / Koyeb (Free)** | 0 € | **nein** (ohne persistente Platte) | Nur zum Ausprobieren: SQLite ginge bei jedem Neustart verloren; Render-Free schläft nach Inaktivität. |

**Empfehlung:** Zum Testen mit Freunden: eigener Rechner + Cloudflare Tunnel. Für dauerhaften öffentlichen Betrieb ohne Kosten: Oracle-VM (mit Backups). Beides ist unten beschrieben – ich konnte hier keinen echten Anbieter-Account anlegen, die Schritte sind daher *nicht live getestet*, nur Compose/Caddy-Konfiguration ist statisch geprüft (siehe Hinweis am Ende).

Quellen der Recherche: [Vergleich kostenloser Docker-Hoster 2026](https://flywp.com/blog/9769/best-free-docker-hosting-platforms/), [Free-Docker-Hosting-Vergleich (SnapDeploy)](https://snapdeploy.dev/blog/free-docker-hosting-2026-platforms-compared), [Oracle Cloud Free Tier FAQ](https://www.oracle.com/cloud/free/faq/), [Cloudflare Tunnel für den Heimserver](https://benjamintseng.com/?p=1925).

## A) Eigene VM (z. B. Oracle Always Free) mit automatischem HTTPS

1. VM mit Docker + Compose-Plugin einrichten, Ports 80 und 443 freigeben (Firewall/Security List).
2. Domain besorgen (oder kostenlosen DynDNS-Namen) und per DNS auf die VM-IP zeigen lassen.
3. Repo (oder nur `docker-compose.prod.yml`, `Caddyfile`, `batches/`) auf die VM kopieren.
4. Image-Sichtbarkeit: In GitHub unter *Packages → ratespass → Package settings* auf **Public** stellen (sonst `docker login ghcr.io` mit einem Token).
5. Starten:
   ```bash
   export DOMAIN=quiz.example.org ADMIN_TOKEN=$(openssl rand -hex 16) VAPID_SUBJECT=mailto:du@example.org
   docker compose -f docker-compose.prod.yml up -d
   ```
   Caddy holt das Zertifikat automatisch. `ADMIN_TOKEN` notieren (Moderation unter `/admin`).
6. Updates: `docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`.

## B) Zuhause + Cloudflare Tunnel

1. Domain zu Cloudflare (DNS) bringen, im Zero-Trust-Dashboard einen Tunnel anlegen, Token kopieren, Public Hostname `quiz.deinedomain.de` → `http://ratespass:3000`.
2. Zusätzlich zu `docker-compose.yml` einen `cloudflared`-Dienst starten (gleiches Netzwerk):
   ```yaml
   services:
     cloudflared:
       image: cloudflare/cloudflared:latest
       command: tunnel run --token ${CF_TUNNEL_TOKEN}
       restart: unless-stopped
   ```
3. `TRUST_PROXY=1` setzen (Rate-Limits sollen die echte Client-IP sehen) und `VAPID_SUBJECT` setzen.

## Wichtig im Betrieb

- **Backup:** `docker compose exec ratespass node tools/backup.ts /data/backup` erzeugt eine konsistente DB-Kopie **und** sichert `vapid.json`. Regelmäßig (z. B. per Cron) ausführen und den Ordner **außerhalb** der Maschine ablegen. Gehen die VAPID-Schlüssel verloren, erzeugt der Server neue; die App abonniert dann automatisch neu, sobald sie geöffnet wird.
- **Push:** Läuft ohne Zusatzdienst (VAPID, direkt zu FCM/Mozilla/Apple). `VAPID_SUBJECT` sollte eine echte Kontaktadresse sein. iPhone/iPad: Push funktioniert nur, wenn die App über *Teilen → Zum Home-Bildschirm* installiert ist.
- **Neue Fragen:** Batch-Datei nach `batches/` legen, Container neu starten. Community-Fragen vorher mit `/admin` → „Batch exportieren“ sichern und einchecken.
- **Rechtliches:** `web/legal.html` (Impressum/Datenschutz) vor dem öffentlichen Betrieb ausfüllen.

## Hinweis zum Prüfstand

Geprüft wurde: Anwendung, Tests, Backup-Werkzeug, Verhalten hinter `TRUST_PROXY`. **Nicht** geprüft (kein Docker-Daemon, kein Anbieterkonto in der Entwicklungsumgebung): der tatsächliche Image-Build, `publish.yml`, die Caddy-/Tunnel-Konfiguration und echte Push-Zustellung über FCM/Mozilla/Apple. Beim ersten Deployment daher kurz den Test-Button unter *Profil → Benachrichtigungen* nutzen.
