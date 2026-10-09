variable "compartment_ocid" {
  description = "OCID des Compartments, in dem alles angelegt wird (am besten ein eigenes Compartment nur für Ratespaß)."
  type        = string
}

variable "oci_config_profile" {
  description = "Profilname in ~/.oci/config."
  type        = string
  default     = "DEFAULT"
}

variable "region" {
  description = "OCI-Region (z. B. eu-frankfurt-1). Leer = Region aus dem Profil. Always-Free-Ressourcen gibt es nur in der Home-Region des Kontos."
  type        = string
  default     = ""
}

variable "domain" {
  description = "Öffentlicher Hostname, z. B. quiz.example.org. Muss per DNS-A-Record auf die ausgegebene IP zeigen (Caddy holt damit das HTTPS-Zertifikat)."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.domain))
    error_message = "domain muss ein gültiger Hostname in Kleinbuchstaben sein, z. B. quiz.example.org."
  }
}

variable "vapid_subject" {
  description = "Kontakt für Push-Dienste: mailto:du@example.org oder eine https-URL."
  type        = string

  validation {
    condition     = can(regex("^(mailto:[^@ ]+@[^@ ]+|https://[^ ]+)$", var.vapid_subject))
    error_message = "vapid_subject muss mit mailto:… oder https://… beginnen."
  }
}

# --- Betreiber (Impressum & Datenschutzerklärung) – siehe .env.example im Repo -------------------------------------------------
variable "controller_name" {
  description = "Verantwortlicher (Person/Firma inkl. Rechtsform) für Impressum und Datenschutzerklärung."
  type        = string
  validation {
    condition     = length(trimspace(var.controller_name)) > 0 && !can(regex("[\"$\\n\\r]", var.controller_name))
    error_message = "controller_name darf nicht leer sein und kein Anführungszeichen, Dollarzeichen oder Zeilenumbruch enthalten."
  }
}

variable "controller_address" {
  description = "Ladungsfähige Anschrift des Verantwortlichen."
  type        = string
  validation {
    condition     = length(trimspace(var.controller_address)) > 0 && !can(regex("[\"$\\n\\r]", var.controller_address))
    error_message = "controller_address darf nicht leer sein und kein Anführungszeichen, Dollarzeichen oder Zeilenumbruch enthalten."
  }
}

variable "controller_email" {
  description = "Kontakt-E-Mail des Verantwortlichen."
  type        = string
  validation {
    condition     = can(regex("^[^@ \"$]+@[^@ \"$]+$", var.controller_email))
    error_message = "controller_email muss eine E-Mail-Adresse sein."
  }
}

variable "controller_phone" {
  description = "Optional: Telefonnummer."
  type        = string
  default     = ""
}

variable "hosting_provider" {
  description = "Hoster inkl. Standort für die Datenschutzerklärung."
  type        = string
  default     = "Oracle Cloud Infrastructure"
}

variable "ssh_public_key" {
  description = "Öffentlicher SSH-Schlüssel (Inhalt von z. B. ~/.ssh/id_ed25519.pub) für den Benutzer „ubuntu“."
  type        = string
}

variable "ssh_allowed_cidr" {
  description = "Von welchen Adressen SSH (Port 22) erreichbar ist, z. B. 203.0.113.7/32 (deine IP). Bewusst ohne Standardwert."
  type        = string

  validation {
    condition     = can(cidrhost(var.ssh_allowed_cidr, 0))
    error_message = "ssh_allowed_cidr muss ein CIDR-Block sein, z. B. 203.0.113.7/32."
  }
}

variable "admin_token" {
  description = "Token für /admin (mind. 16 Zeichen). Leer = wird zufällig erzeugt (terraform output -raw admin_token)."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = var.admin_token == "" || length(var.admin_token) >= 16
    error_message = "admin_token muss leer oder mindestens 16 Zeichen lang sein."
  }
}

variable "shape" {
  description = "Instanzform. Always-Free: VM.Standard.A1.Flex (ARM, flexibel) oder VM.Standard.E2.1.Micro (AMD, 1 GB RAM)."
  type        = string
  default     = "VM.Standard.A1.Flex"

  validation {
    condition     = contains(["VM.Standard.A1.Flex", "VM.Standard.E2.1.Micro"], var.shape)
    error_message = "Nur die Always-Free-Formen VM.Standard.A1.Flex und VM.Standard.E2.1.Micro sind vorgesehen."
  }
}

variable "ocpus" {
  description = "Nur für A1.Flex: Anzahl OCPUs. Klein halten, die Gratis-Grenze hat Oracle zuletzt verändert (siehe README)."
  type        = number
  default     = 1

  validation {
    condition     = var.ocpus >= 1 && var.ocpus <= 4
    error_message = "ocpus muss zwischen 1 und 4 liegen."
  }
}

variable "memory_in_gbs" {
  description = "Nur für A1.Flex: Arbeitsspeicher in GB."
  type        = number
  default     = 6

  validation {
    condition     = var.memory_in_gbs >= 1 && var.memory_in_gbs <= 24 && var.memory_in_gbs >= var.ocpus
    error_message = "memory_in_gbs muss zwischen 1 und 24 liegen und mindestens so groß wie ocpus sein."
  }
}

variable "boot_volume_in_gbs" {
  description = "Größe der Bootplatte in GB (die Gratis-Grenze für Speicher gilt über alle Instanzen zusammen)."
  type        = number
  default     = 50

  validation {
    condition     = var.boot_volume_in_gbs >= 50 && var.boot_volume_in_gbs <= 200
    error_message = "boot_volume_in_gbs muss zwischen 50 und 200 liegen."
  }
}

variable "availability_domain_index" {
  description = "Welche Availability Domain (0, 1, 2 …). Bei „Out of host capacity“ eine andere probieren."
  type        = number
  default     = 0
}

variable "ubuntu_version" {
  description = "Ubuntu-Version des Images."
  type        = string
  default     = "24.04"
}

variable "image" {
  description = "Container-Image von Ratespaß. Für ARM (A1.Flex) muss es ein multi-arch-Image sein (baut .github/workflows/publish.yml)."
  type        = string
  default     = "ghcr.io/qwertz098/ratespass:latest"
}

variable "ghcr_user" {
  description = "Nur falls das Image privat ist: GitHub-Benutzername für den Pull."
  type        = string
  default     = ""
}

variable "ghcr_token" {
  description = "Nur falls das Image privat ist: GitHub-Token mit read:packages. Landet in den Instanz-Metadaten – nur ein eigenes, minimal berechtigtes Token verwenden."
  type        = string
  default     = ""
  sensitive   = true
}

variable "auto_update" {
  description = "true = einmal pro Woche automatisch das neueste Image ziehen und neu starten."
  type        = bool
  default     = false
}

variable "name_prefix" {
  description = "Namenspräfix der Ressourcen."
  type        = string
  default     = "ratespass"
}
