# Ratespaß auf Oracle Cloud (Always Free) – Terraform

Legt in Oracle Cloud eine kleine Gratis-VM an und richtet sie komplett ein: Docker, Ratespaß (Image aus `ghcr.io`), **Caddy mit automatischem HTTPS**, tägliche Backups, optional wöchentliche Updates. Danach brauchst du nur noch einen DNS-Eintrag.

## Was entsteht

- 1 VCN mit öffentlichem Subnetz, Internet-Gateway, Firewall-Regeln (SSH nur von **deiner** Adresse, 80/443 offen)
- 1 VM (Standard: `VM.Standard.A1.Flex`, ARM, **1 OCPU / 6 GB / 50 GB Platte** – bewusst klein; der Server braucht ~100 MB RAM)
- auf der VM unter `/opt/ratespass`: `docker-compose.yml`, `Caddyfile`, `.env` (nur root lesbar)
- systemd-Timer: Backup täglich 03:30 (14 Tage aufbewahrt), Update wöchentlich (nur wenn `auto_update = true`)

## Voraussetzungen

1. **Oracle-Konto** (Always Free; Kreditkarte zur Verifizierung nötig) und dessen **Home-Region** – Always-Free-Ressourcen gibt es nur dort.
2. Ein **Compartment** (am besten ein eigenes nur für Ratespaß) und dessen OCID.
3. **API-Zugang:** `oci setup config` (OCI-CLI) oder in der Konsole *Profil → Benutzereinstellungen → API-Schlüssel → Hinzufügen*; die erzeugte `~/.oci/config` genügt. Besser: ein eigener IAM-Benutzer, dessen Policy nur dieses Compartment verwalten darf. Schlüssel und OCIDs bleiben in `~/.oci/config` und werden **nicht** als Terraform-Variablen übergeben.
4. **Terraform ≥ 1.5** (oder OpenTofu), ein **SSH-Schlüssel** und eine **Domain**, bei der du einen A-Record setzen kannst (kostenlose DynDNS-Namen gehen auch).
5. **Das Container-Image muss existieren und – für die ARM-Variante – multi-arch sein:** `.github/workflows/publish.yml` baut `linux/amd64` und `linux/arm64`. Nach dem ersten Lauf in GitHub unter *Packages → ratespass → Package settings* auf **Public** stellen (sonst `ghcr_user`/`ghcr_token` setzen).

## Ablauf

```bash
cd deploy/oracle
cp terraform.tfvars.example terraform.tfvars   # anpassen: compartment_ocid, domain, vapid_subject, ssh_public_key, ssh_allowed_cidr
terraform init
terraform plan                                  # genau lesen: es dürfen nur die oben genannten Ressourcen entstehen
terraform apply
```

Danach:

1. **DNS:** `terraform output dns_record` zeigt den Eintrag (`A  quiz.example.org → <IP>`). Setzen. Caddy versucht die Zertifikatsausstellung automatisch erneut, bis der Eintrag greift (meist wenige Minuten).
2. Die VM braucht nach dem Start noch **2–5 Minuten** (Updates, Docker, Image-Pull). Fortschritt: `ssh ubuntu@<IP>` → `sudo cloud-init status --wait` und `cd /opt/ratespass && sudo docker compose ps`.
3. **Aufrufen:** `terraform output url`, Moderation unter `terraform output admin_url`; Token mit `terraform output -raw admin_token`.
4. In der App: *Profil → Benachrichtigungen → Test senden* (HTTPS ist Voraussetzung für Push).

## Betrieb

| Aufgabe | Befehl (auf der VM, per SSH) |
|---|---|
| Status / Logs | `cd /opt/ratespass && sudo docker compose ps` / `sudo docker compose logs -f` |
| Update auf neues Image | `sudo /usr/local/bin/ratespass-update` |
| Backup sofort | `sudo /usr/local/bin/ratespass-backup` |
| Backup herunterkopieren | `sudo docker cp ratespass:/data/backup ./backup && sudo chown -R ubuntu backup`, dann `scp -r ubuntu@<IP>:backup .` |
| Neue Fragen | Batch ins Repo, `main` pushen → `publish.yml` baut ein neues Image → Update (oben) |

**Wichtig:** Die Backups liegen im selben Datenvolume wie die Datenbank. Sie schützen vor Fehlbedienung, **nicht** vor dem Verlust der VM. Kopiere sie regelmäßig auf einen anderen Rechner.

## Fehlersuche

- **„Out of host capacity“ bei `apply`:** Bei A1-Instanzen häufig. `availability_domain_index = 1` (oder 2) probieren, später wiederholen, oder `shape = "VM.Standard.E2.1.Micro"` (AMD, 1 GB RAM – für Ratespaß ausreichend).
- **Kein HTTPS-Zertifikat:** DNS noch nicht gesetzt/verbreitet, oder Port 80/443 blockiert. `sudo docker compose logs caddy`. Die Instanz-Firewall (iptables) wird von cloud-init geöffnet; die Oracle-Security-List von Terraform.
- **SSH läuft in ein Timeout:** `ssh_allowed_cidr` passt nicht zu deiner aktuellen IP (Provider-Wechsel?). Wert ändern und `terraform apply` (ändert nur die Security-List).
- **`exec format error`:** Das Image ist nicht für ARM gebaut → `publish.yml` neu laufen lassen oder `shape = "VM.Standard.E2.1.Micro"`.

## Sicherheit

- Das **Terraform-State** (`terraform.tfstate`, lokal) enthält das Admin-Token im Klartext und gehört nicht ins Repo (ist ignoriert). Sichere es wie ein Passwort.
- Das Token steht auch in den **Instanz-Metadaten** (`user_data`) und in `/opt/ratespass/.env` (0600). Wer auf der VM root ist, kann es lesen. Optionales `ghcr_token` landet ebenso dort → nur ein eigenes, minimal berechtigtes Token (`read:packages`).
- SSH nur per Schlüssel (Standard der Ubuntu-Images) und nur von `ssh_allowed_cidr`; Sicherheitsupdates des Betriebssystems laufen automatisch (`unattended-upgrades`).
- Die Konfiguration erlaubt **nur Always-Free-Formen**. Ob dein Konto die Gratis-Grenzen noch erfüllt, prüfst du selbst in der Oracle-Konsole; Oracle hat die Grenzen der A1-Instanzen zuletzt verändert (Quellen widersprachen sich: 4 vs. 2 OCPU). Die Voreinstellung (1 OCPU/6 GB) liegt unter beiden Varianten. Nach einem Upgrade auf *Pay As You Go* können zu große oder zusätzliche Ressourcen **Kosten verursachen**.
- Oracle kann ungenutzte Always-Free-Instanzen zurücknehmen → Backups auslagern.

## Änderungen und Aufräumen

- Spätere Änderungen an `domain`, `admin_token` usw. werden **nicht** automatisch auf die laufende VM angewendet (cloud-init läuft nur beim ersten Start; die Instanz ignoriert Änderungen bewusst, damit nichts versehentlich ersetzt wird und Daten verloren gehen). Konfiguration auf der VM unter `/opt/ratespass` direkt anpassen, oder bewusst neu aufbauen: `terraform apply -replace=oci_core_instance.app` – **das löscht die Daten der alten VM**, vorher Backup kopieren.
- Alles entfernen: `terraform destroy` (**löscht auch die Daten**).
- Es wird absichtlich keine `.terraform.lock.hcl` eingecheckt; `terraform init` erzeugt sie bei dir (kannst du danach selbst einchecken).

## Was geprüft wurde

Geprüft (ohne Oracle-Konto): `terraform fmt`, **`terraform validate` mit dem echten Oracle-Provider** (Argumente und Ressourcen stimmen mit dem Schema überein), alle Eingabe-Validierungen mit absichtlich falschen Werten, das Rendern der cloud-init-Datei in allen Varianten (YAML gültig, Shell-Skripte syntaktisch korrekt, Docker Compose löst die erzeugte Konfiguration auf).

**Nicht** geprüft, weil dafür ein echtes Oracle-Konto und eine laufende VM nötig sind: das eigentliche `terraform apply`, die Ausführung von cloud-init auf dem Oracle-Ubuntu-Image, der Start der Container auf ARM und die Zertifikatsausstellung. Prüfe beim ersten Mal `terraform plan` sorgfältig und beobachte `cloud-init status`.
