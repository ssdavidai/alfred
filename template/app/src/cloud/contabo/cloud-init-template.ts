/**
 * Generate cloud-init script for deploying AlfredOS stack from GitHub repo
 */
export function generateCloudInit(params: {
  hostname: string;
  domain: string;
  letsEncryptEmail: string;
}): string {
  const { hostname, domain, letsEncryptEmail } = params;
  const fullDomain = `${hostname}.${domain}`;

  return `#cloud-config
package_update: true
package_upgrade: true

# Enable SSH access
ssh_pwauth: false
disable_root: false

# Write SSH key directly to root's authorized_keys
write_files:
  - path: /root/.ssh/authorized_keys
    permissions: '0600'
    owner: root:root
    content: |
      ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBpN5rbgSQ5Y9PDP3t7jBdlgwoNbyLwkD9Gqs7wJel3G admin@alfredos.cloud

packages:
  - apt-transport-https
  - ca-certificates
  - curl
  - gnupg
  - lsb-release
  - git

runcmd:
  # Ensure SSH directory permissions
  - chmod 700 /root/.ssh
  - chmod 600 /root/.ssh/authorized_keys

  # Install Docker
  - curl -fsSL https://get.docker.com -o get-docker.sh
  - sh get-docker.sh
  - systemctl enable docker
  - systemctl start docker

  # Install Docker Compose
  - curl -L "https://github.com/docker/compose/releases/download/v2.23.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
  - chmod +x /usr/local/bin/docker-compose

  # Set hostname
  - hostnamectl set-hostname ${fullDomain}

  # Clone alfredos-stack repository
  - cd /root
  - git clone https://github.com/ssdavidai/alfredos-stack.git
  - cd alfredos-stack

  # Make bootstrap script executable and run it with environment variables
  - chmod +x bootstrap.sh
  - HOSTNAME=${fullDomain} LETSENCRYPT_EMAIL=${letsEncryptEmail} ./bootstrap.sh 2>&1 | tee /var/log/alfredos-bootstrap.log

  # Wait for services to be healthy
  - sleep 30

  # Signal readiness
  - touch /var/lib/cloud/instance/boot-finished
  - echo "AlfredOS deployment completed at ${fullDomain}" > /root/deployment-status.txt

final_message: "AlfredOS Cloud instance is ready! Access at https://${fullDomain}"
`;
}
