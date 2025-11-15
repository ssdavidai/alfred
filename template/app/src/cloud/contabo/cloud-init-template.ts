/**
 * Generate cloud-init script for deploying LibreChat + NocoDB stack
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

packages:
  - apt-transport-https
  - ca-certificates
  - curl
  - gnupg
  - lsb-release
  - git

write_files:
  - path: /root/docker-compose.yml
    content: |
      version: '3.8'

      services:
        # Traefik reverse proxy with automatic SSL
        traefik:
          image: traefik:v2.10
          container_name: traefik
          restart: unless-stopped
          security_opt:
            - no-new-privileges:true
          ports:
            - "80:80"
            - "443:443"
          volumes:
            - /etc/localtime:/etc/localtime:ro
            - /var/run/docker.sock:/var/run/docker.sock:ro
            - ./traefik-data/traefik.yml:/traefik.yml:ro
            - ./traefik-data/acme.json:/acme.json
            - ./traefik-data/config.yml:/config.yml:ro
          networks:
            - proxy
          labels:
            - "traefik.enable=true"
            - "traefik.http.routers.traefik.entrypoints=http"
            - "traefik.http.routers.traefik.rule=Host(\`traefik.${fullDomain}\`)"
            - "traefik.http.middlewares.traefik-https-redirect.redirectscheme.scheme=https"
            - "traefik.http.routers.traefik.middlewares=traefik-https-redirect"
            - "traefik.http.routers.traefik-secure.entrypoints=https"
            - "traefik.http.routers.traefik-secure.rule=Host(\`traefik.${fullDomain}\`)"
            - "traefik.http.routers.traefik-secure.tls=true"
            - "traefik.http.routers.traefik-secure.tls.certresolver=cloudflare"
            - "traefik.http.routers.traefik-secure.service=api@internal"

        # PostgreSQL for NocoDB
        postgres:
          image: postgres:15-alpine
          container_name: postgres
          restart: unless-stopped
          environment:
            POSTGRES_DB: nocodb
            POSTGRES_USER: nocodb
            POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-changeme123}
          volumes:
            - postgres-data:/var/lib/postgresql/data
          networks:
            - backend
          healthcheck:
            test: ["CMD-SHELL", "pg_isready -U nocodb"]
            interval: 10s
            timeout: 5s
            retries: 5

        # MongoDB for LibreChat
        mongodb:
          image: mongo:7.0
          container_name: mongodb
          restart: unless-stopped
          environment:
            MONGO_INITDB_ROOT_USERNAME: admin
            MONGO_INITDB_ROOT_PASSWORD: \${MONGO_PASSWORD:-changeme123}
          volumes:
            - mongodb-data:/data/db
          networks:
            - backend
          healthcheck:
            test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
            interval: 10s
            timeout: 5s
            retries: 5

        # NocoDB - No-code database platform
        nocodb:
          image: nocodb/nocodb:latest
          container_name: nocodb
          restart: unless-stopped
          environment:
            NC_DB: pg://postgres:5432?u=nocodb&p=\${POSTGRES_PASSWORD:-changeme123}&d=nocodb
            NC_PUBLIC_URL: https://db.${fullDomain}
            NC_DISABLE_TELE: true
          networks:
            - proxy
            - backend
          depends_on:
            postgres:
              condition: service_healthy
          labels:
            - "traefik.enable=true"
            - "traefik.http.routers.nocodb.entrypoints=http"
            - "traefik.http.routers.nocodb.rule=Host(\`db.${fullDomain}\`)"
            - "traefik.http.middlewares.nocodb-https-redirect.redirectscheme.scheme=https"
            - "traefik.http.routers.nocodb.middlewares=nocodb-https-redirect"
            - "traefik.http.routers.nocodb-secure.entrypoints=https"
            - "traefik.http.routers.nocodb-secure.rule=Host(\`db.${fullDomain}\`)"
            - "traefik.http.routers.nocodb-secure.tls=true"
            - "traefik.http.routers.nocodb-secure.tls.certresolver=cloudflare"
            - "traefik.http.routers.nocodb-secure.service=nocodb"
            - "traefik.http.services.nocodb.loadbalancer.server.port=8080"
            - "traefik.docker.network=proxy"

        # LibreChat - AI chat interface
        librechat:
          image: ghcr.io/danny-avila/librechat:latest
          container_name: librechat
          restart: unless-stopped
          environment:
            MONGO_URI: mongodb://admin:\${MONGO_PASSWORD:-changeme123}@mongodb:27017/LibreChat?authSource=admin
            HOST: 0.0.0.0
            PORT: 3080
            APP_TITLE: AlfredOS
            ENDPOINTS: openAI,azureOpenAI,anthropic
          volumes:
            - librechat-data:/app/client/public/images
          networks:
            - proxy
            - backend
          depends_on:
            mongodb:
              condition: service_healthy
          labels:
            - "traefik.enable=true"
            - "traefik.http.routers.librechat.entrypoints=http"
            - "traefik.http.routers.librechat.rule=Host(\`${fullDomain}\`)"
            - "traefik.http.middlewares.librechat-https-redirect.redirectscheme.scheme=https"
            - "traefik.http.routers.librechat.middlewares=librechat-https-redirect"
            - "traefik.http.routers.librechat-secure.entrypoints=https"
            - "traefik.http.routers.librechat-secure.rule=Host(\`${fullDomain}\`)"
            - "traefik.http.routers.librechat-secure.tls=true"
            - "traefik.http.routers.librechat-secure.tls.certresolver=cloudflare"
            - "traefik.http.routers.librechat-secure.service=librechat"
            - "traefik.http.services.librechat.loadbalancer.server.port=3080"
            - "traefik.docker.network=proxy"

      networks:
        proxy:
          name: proxy
          driver: bridge
        backend:
          name: backend
          driver: bridge

      volumes:
        postgres-data:
        mongodb-data:
        librechat-data:

  - path: /root/traefik-data/traefik.yml
    content: |
      api:
        dashboard: true
        debug: true

      entryPoints:
        http:
          address: ":80"
        https:
          address: ":443"

      providers:
        docker:
          endpoint: "unix:///var/run/docker.sock"
          exposedByDefault: false

      certificatesResolvers:
        cloudflare:
          acme:
            email: ${letsEncryptEmail}
            storage: acme.json
            httpChallenge:
              entryPoint: http

  - path: /root/traefik-data/config.yml
    content: |
      http:
        middlewares:
          secureHeaders:
            headers:
              sslRedirect: true
              forceSTSHeader: true
              stsIncludeSubdomains: true
              stsPreload: true
              stsSeconds: 31536000

  - path: /root/.env
    content: |
      POSTGRES_PASSWORD=$(openssl rand -base64 32)
      MONGO_PASSWORD=$(openssl rand -base64 32)

runcmd:
  # Install Docker
  - curl -fsSL https://get.docker.com -o get-docker.sh
  - sh get-docker.sh
  - systemctl enable docker
  - systemctl start docker

  # Install Docker Compose
  - curl -L "https://github.com/docker/compose/releases/download/v2.23.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
  - chmod +x /usr/local/bin/docker-compose

  # Create Traefik directories and set permissions
  - mkdir -p /root/traefik-data
  - touch /root/traefik-data/acme.json
  - chmod 600 /root/traefik-data/acme.json

  # Set hostname
  - hostnamectl set-hostname ${fullDomain}

  # Start the stack
  - cd /root
  - docker-compose up -d

  # Wait for services to be healthy
  - sleep 30

  # Signal readiness
  - touch /var/lib/cloud/instance/boot-finished
  - echo "AlfredOS deployment completed" > /root/deployment-status.txt

final_message: "AlfredOS Cloud instance is ready! Access at https://${fullDomain}"
`;
}
