# Online stellen (kostenlos oder fast kostenlos)

## Kurzantwort zu GitHub

- **GitHub Pages geht nicht.** Pages liefert nur statische Dateien. Ratespaß braucht einen laufenden Server (Spiellogik, Datenbank, Push).
- **GitHub kann trotzdem helfen:** Der Code liegt dort, `ci.yml` testet jeden Push, und `publish.yml` baut das Docker-Image und legt es kostenlos in der **GitHub Container Registry** ab (`ghcr.io/qwertz098/ratespass`). Dort wird nur das Image *gespeichert* – laufen muss es woanders.
- Codespaces sind Entwicklungsumgebungen und kein Dauerhosting.

## Was der Server braucht

| | |
|---|---|
| RAM | gemessen ca. 90 MB (Node 22, nach längeren Testläufen) |
| Speicher | SQLite-Datei (aktuell ~2 MB mit 1556 Fragenzeilen) + VAPID-Schlüssel in `/data` – **muss dauerhaft sein** |
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

Läuft bei dir schon Nginx Proxy Manager, nimm Variante C.

**Empfehlung:** Zum Testen mit Freunden: eigener Rechner + Cloudflare Tunnel. Für dauerhaften öffentlichen Betrieb ohne Kosten: Oracle-VM (mit Backups). Beides ist unten beschrieben – ich konnte hier keinen echten Anbieter-Account anlegen, die Schritte sind daher *nicht live getestet*, nur Compose/Caddy-Konfiguration ist statisch geprüft (siehe Hinweis am Ende).

Quellen der Recherche: [Vergleich kostenloser Docker-Hoster 2026](https://flywp.com/blog/9769/best-free-docker-hosting-platforms/), [Free-Docker-Hosting-Vergleich (SnapDeploy)](https://snapdeploy.dev/blog/free-docker-hosting-2026-platforms-compared), [Oracle Cloud Free Tier FAQ](https://www.oracle.com/cloud/free/faq/), [Cloudflare Tunnel für den Heimserver](https://benjamintseng.com/?p=1925).

## Windows: Bauen, in die Registry pushen und per Dockge starten (`build+deploy.bat`)

Für den Weg „Windows-PC → eigene Registry im Tailnet/LAN → Server (Dockge)“ liegt im Repo-Wurzelverzeichnis [`build+deploy.bat`](../build+deploy.bat). Der Ablauf entspricht `build_docker.bat` + `deploy_docker.bat` des HandPack-Projekts:

```bat
build+deploy.bat [registry-host:port] [namespace] [Optionen]
build+deploy.bat 100.68.13.43:5000            :: -> 100.68.13.43:5000/ratespass:<datum>-<commit> und :latest
build+deploy.bat 100.68.13.43:5000 kristian   :: -> 100.68.13.43:5000/kristian/ratespass:...
```

1. klont das Repo (inklusive sich selbst) nach `%USERPROFILE%\ratespass-build` und startet dann die Fassung aus dem Klon – oder nutzt das Repo, in dem sie liegt;
2. prüft Git, Docker und die Tailscale-Verbindung (SSH/SCP nur, wenn `SSH_TARGET` gesetzt ist);
3. baut das Image, taggt es `REGISTRY[/NAMESPACE]/ratespass:<datum>-<commit>` sowie `:latest` und pusht beides;
4. gibt am Ende **„In Dockge verwenden: `image: …`“** aus. Als Stack-`compose.yaml` den Inhalt von [`docker-compose.dockge.yml`](../docker-compose.dockge.yml) einfügen (Registry-Image + NPM-Netz, **kein** `build:`), in die Stack-`.env` `RATESPASS_IMAGE=…`, `ADMIN_TOKEN`, `VAPID_SUBJECT`, `CONTROLLER_*`, `NPM_NETWORK` eintragen und „Deploy“ bzw. „Update / Pull & Redeploy“ ausführen. **Nicht** `docker-compose.yml` oder `docker-compose.npm.yml` nehmen: sie enthalten `build: .`; im Dockge-Ordner fehlt das Dockerfile, und fehlt `RATESPASS_IMAGE`, kommt erst „manifest unknown“ (ghcr-Image nicht vorhanden) und dann „failed to read dockerfile“;
5. **optional per SSH:** ist `SSH_TARGET` gesetzt, kopiert sie die Compose-Datei nach `REMOTE_DIR/docker-compose.yml`, führt `docker compose pull && up -d` aus und wartet auf `/healthz`. Die `.env` auf dem Server wird nie überschrieben.

**Port ist Pflicht** (z. B. `:5000`), sonst versucht Docker HTTPS auf Port 443. Läuft die Registry ohne TLS, muss sie **auf PC und Server** als `insecure-registry` eingetragen sein (Docker Desktop → Settings → Docker Engine: `{ "insecure-registries": ["100.68.13.43:5000"] }` → Apply & Restart).

**Verknüpfung (wie „deploy_docker.bat - 192.168.178.222:5000“):** `build+deploy.bat --make-shortcut 100.68.13.43:5000` legt auf dem Desktop `Quissel deploy - 100.68.13.43_5000.lnk` an (Ziel = die bat, Argument = `registry-host:port`, Arbeitsordner = Ordner der bat). Ein Doppelklick baut und pusht danach; das Fenster wartet am Ende auf eine Taste (`--no-pause` schaltet das ab).

Einstellungen: `deploy.local.bat.example` nach `deploy.local.bat` kopieren (wird nicht eingecheckt) – dort `REGISTRY`, optional `NAMESPACE`, `SSH_TARGET`, `REMOTE_DIR`, `PLATFORM` (z. B. `linux/arm64`), `BRANCH`, `REGISTRY_USER`/`REGISTRY_PASSWORD`. Auf dem Server einmalig `.env` anlegen (Vorlage `.env.example`: `ADMIN_TOKEN`, `VAPID_SUBJECT`, `CONTROLLER_*`). Optionen: `--build-only`, `--no-deploy`, `--branch NAME`, `--tag NAME`, `--no-pull`, `--no-pause`, `--make-shortcut`.

> Die Datei konnte in der Entwicklungsumgebung nicht auf Windows ausgeführt werden (kein cmd, kein Docker, keine Tailscale-Registry) – bitte beim ersten Lauf mit `--build-only` beginnen.

## A) Eigene VM (z. B. Oracle Always Free) mit automatischem HTTPS

> **Oracle Cloud per Terraform:** Für eine Always-Free-VM bei Oracle gibt es ein fertiges Paket mit Netzwerk, Firewall, Docker, Caddy-HTTPS und Backups: [`deploy/oracle/`](../deploy/oracle/README.md). Die folgenden Schritte beschreiben die manuelle Variante für beliebige VMs.

1. VM mit Docker + Compose-Plugin einrichten, Ports 80 und 443 freigeben (Firewall/Security List).
2. Domain besorgen (oder kostenlosen DynDNS-Namen) und per DNS auf die VM-IP zeigen lassen.
3. Repo (oder nur `docker-compose.prod.yml`, `Caddyfile`, `batches/`) auf die VM kopieren.
4. Image-Sichtbarkeit: In GitHub unter *Packages → ratespass → Package settings* auf **Public** stellen (sonst `docker login ghcr.io` mit einem Token).
5. Starten:
   ```bash
   export DOMAIN=quiz.example.org ADMIN_TOKEN=$(openssl rand -hex 16) VAPID_SUBJECT=mailto:du@example.org
   docker compose -f docker-compose.prod.yml up -d
   ```
   Caddy holt das Zertifikat automatisch. `ADMIN_TOKEN` notieren (Anmeldung unter `/admin`).
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

## C) Hinter Nginx Proxy Manager (NPM)

Für alle, die NPM schon im Homelab/auf dem Server haben: `docker-compose.npm.yml` startet Ratespaß **ohne veröffentlichten Port** im selben Docker-Netzwerk wie NPM; HTTPS und Zertifikate übernimmt NPM.

1. **Netzwerk finden:** `docker network ls` – das Netzwerk, in dem der NPM-Container hängt (häufig `npm_default` oder `<ordner>_default`).
2. **`.env` anlegen** (Vorlage `.env.example`): `NPM_NETWORK`, `ADMIN_TOKEN` (mind. 16 Zeichen, `openssl rand -hex 16`), `VAPID_SUBJECT` (echte Mailadresse). Bei Cloudflare-Proxy vor NPM `PROXY_HOPS=2`.
3. **Starten:** `docker compose -f docker-compose.npm.yml up -d --build`
   (Alternativ ohne lokalen Build das Image aus `ghcr.io` verwenden, sobald `publish.yml` gelaufen und das Paket öffentlich ist: `docker compose -f docker-compose.npm.yml pull && … up -d`.)
4. **In NPM → Hosts → Proxy Hosts → Add Proxy Host:**
   | Feld | Wert |
   |---|---|
   | Domain Names | `quiz.deinedomain.de` |
   | Scheme | `http` |
   | Forward Hostname / IP | `ratespass` (Container-Name) |
   | Forward Port | `3000` |
   | Block Common Exploits | an |
   | Websockets Support | egal (wird nicht benötigt) |
   | **Cache Assets** | **aus** – sonst bleiben alte `app.js`/`sw.js` im Cache und Updates kommen nicht an |
   | Tab SSL | *Request a new SSL Certificate*, **Force SSL** an, HTTP/2 an (HSTS optional) |
   **Port:** Zusätzlich zum internen Port 3000 veröffentlicht die Compose-Datei den Host-Port **3007** (`HOST_PORT` in der `.env` ändert ihn, `BIND_ADDRESS=127.0.0.1` macht ihn nur lokal erreichbar). Hängt NPM *nicht* im selben Docker-Netzwerk, trägst du bei „Forward Hostname“ die IP des Hosts und Port `3007` ein. Direkt testen: `http://<host>:3007`. Soll der Port gar nicht veröffentlicht werden, die `ports:`-Zeile in `docker-compose.npm.yml` löschen.
5. Aufrufen: `https://quiz.deinedomain.de` – Test: *Profil → Benachrichtigungen → Test senden*.

Hinweise:
- **Echte Client-IP:** Die App wertet `X-Forwarded-For` von *rechts* aus (`PROXY_HOPS` = Anzahl der Proxys). Mit nur NPM ist `1` richtig; mit Cloudflare davor `2`. Stimmt der Wert nicht, teilen sich alle Nutzer ein Rate-Limit (zu klein) oder ein Angreifer könnte seine IP fälschen (zu groß).
- **„502 Bad Gateway“:** Meist sind NPM und Ratespaß nicht im selben Netzwerk (`NPM_NETWORK` prüfen) oder der Container läuft nicht (`docker compose -f docker-compose.npm.yml logs ratespass`).
- Backups und Updates wie in den anderen Varianten: `docker compose -f docker-compose.npm.yml exec ratespass node tools/backup.ts /data/backup`.

## Wichtig im Betrieb

- **Backup:** `docker compose exec ratespass node tools/backup.ts /data/backup` erzeugt eine konsistente DB-Kopie **und** sichert `vapid.json`. Regelmäßig (z. B. per Cron) ausführen und den Ordner **außerhalb** der Maschine ablegen. Gehen die VAPID-Schlüssel verloren, erzeugt der Server neue; die App abonniert dann automatisch neu, sobald sie geöffnet wird.
- **Push:** Läuft ohne Zusatzdienst (VAPID, direkt zu FCM/Mozilla/Apple). `VAPID_SUBJECT` sollte eine echte Kontaktadresse sein. iPhone/iPad: Push funktioniert nur, wenn die App über *Teilen → Zum Home-Bildschirm* installiert ist.
- **Neue Fragen:** Batch-Datei nach `batches/` legen, Container neu starten. Community-Fragen vorher mit `/admin` → „Batch exportieren“ sichern und einchecken.
- **Rechtliches:** `web/legal.html` (Impressum/Datenschutz) vor dem öffentlichen Betrieb ausfüllen.

## Hinweis zum Prüfstand

Geprüft wurde: Anwendung, Tests, Backup-Werkzeug, Verhalten hinter `TRUST_PROXY`. **Nicht** geprüft (kein Docker-Daemon, kein Anbieterkonto in der Entwicklungsumgebung): der tatsächliche Image-Build, `publish.yml`, die Caddy-/Tunnel-Konfiguration und echte Push-Zustellung über FCM/Mozilla/Apple. Beim ersten Deployment daher kurz den Test-Button unter *Profil → Benachrichtigungen* nutzen.
