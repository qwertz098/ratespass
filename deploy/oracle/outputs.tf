output "public_ip" {
  description = "Öffentliche IP-Adresse – hierauf den DNS-A-Record der Domain setzen."
  value       = oci_core_instance.app.public_ip
}

output "dns_record" {
  description = "Der anzulegende DNS-Eintrag."
  value       = "A  ${var.domain}  →  ${oci_core_instance.app.public_ip}"
}

output "url" {
  value = "https://${var.domain}"
}

output "admin_url" {
  value = "https://${var.domain}/admin"
}

output "admin_token" {
  description = "Token für /admin (terraform output -raw admin_token)."
  value       = local.admin_token
  sensitive   = true
}

output "ssh" {
  value = "ssh ubuntu@${oci_core_instance.app.public_ip}"
}
