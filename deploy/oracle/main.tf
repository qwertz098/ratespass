data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_ocid
}

data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = var.ubuntu_version
  shape                    = var.shape
  state                    = "AVAILABLE"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "random_id" "admin_token" {
  byte_length = 16 # 32 Hex-Zeichen
}

locals {
  admin_token = var.admin_token != "" ? var.admin_token : random_id.admin_token.hex

  cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    domain        = var.domain
    admin_token   = local.admin_token
    vapid_subject = var.vapid_subject
    controller_name    = var.controller_name
    controller_address = var.controller_address
    controller_email   = var.controller_email
    controller_phone   = var.controller_phone
    hosting_provider   = var.hosting_provider
    image         = var.image
    ghcr_user     = var.ghcr_user
    ghcr_token    = var.ghcr_token
    auto_update   = var.auto_update
  })
}

/* ---------- Netzwerk ---------- */
resource "oci_core_vcn" "main" {
  compartment_id = var.compartment_ocid
  display_name   = "${var.name_prefix}-vcn"
  cidr_blocks    = ["10.20.0.0/16"]
  dns_label      = "ratespass"
}

resource "oci_core_internet_gateway" "main" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name_prefix}-igw"
  enabled        = true
}

resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name_prefix}-public"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.main.id
  }
}

resource "oci_core_security_list" "web" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${var.name_prefix}-web"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
    stateless   = false
  }

  # SSH nur von der angegebenen Adresse
  ingress_security_rules {
    protocol  = "6"
    source    = var.ssh_allowed_cidr
    stateless = false
    tcp_options {
      min = 22
      max = 22
    }
  }

  # HTTP (Weiterleitung auf HTTPS und Zertifikatsprüfung) und HTTPS
  ingress_security_rules {
    protocol  = "6"
    source    = "0.0.0.0/0"
    stateless = false
    tcp_options {
      min = 80
      max = 80
    }
  }

  ingress_security_rules {
    protocol  = "6"
    source    = "0.0.0.0/0"
    stateless = false
    tcp_options {
      min = 443
      max = 443
    }
  }

  # Path-MTU-Discovery
  ingress_security_rules {
    protocol  = "1"
    source    = "0.0.0.0/0"
    stateless = false
    icmp_options {
      type = 3
      code = 4
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.main.id
  display_name               = "${var.name_prefix}-public"
  cidr_block                 = "10.20.1.0/24"
  dns_label                  = "app"
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.web.id]
  prohibit_public_ip_on_vnic = false
}

/* ---------- Server ---------- */
resource "oci_core_instance" "app" {
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name
  display_name        = "${var.name_prefix}-app"
  shape               = var.shape

  dynamic "shape_config" {
    for_each = var.shape == "VM.Standard.A1.Flex" ? [1] : []
    content {
      ocpus         = var.ocpus
      memory_in_gbs = var.memory_in_gbs
    }
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_in_gbs
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = true
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = base64encode(local.cloud_init)
  }

  # cloud-init läuft nur beim ersten Start. Spätere Änderungen an Variablen sollen die Instanz (und damit die Daten)
  # NICHT stillschweigend ersetzen; ein neues Image-Release ebenso nicht. Gewollter Neuaufbau: terraform apply -replace=oci_core_instance.app
  lifecycle {
    ignore_changes = [metadata, source_details[0].source_id]

    precondition {
      condition     = length(data.oci_core_images.ubuntu.images) > 0
      error_message = "Kein Ubuntu-${var.ubuntu_version}-Image für die Form ${var.shape} in dieser Region gefunden."
    }
  }
}
