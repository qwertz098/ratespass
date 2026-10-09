terraform {
  required_version = ">= 1.5"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 7.0, < 11.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Anmeldung über die übliche OCI-Konfiguration (~/.oci/config, erzeugt mit `oci setup config`).
# Es werden bewusst keine Schlüssel oder OCIDs als Terraform-Variablen übergeben.
provider "oci" {
  auth                = "ApiKey"
  config_file_profile = var.oci_config_profile
  region              = var.region != "" ? var.region : null
}
