# SES Relay

SMTP Relay with AWS SES Tenant Tagging & Queuing.

## Features
- **SMTP Relay**: Authenticates users against a MariaDB database.
- **Queuing**: Emails are stored in a `mail_queue` table before being sent to AWS SES.
- **Tenant Routing**: Automatically routes emails through AWS SES `TenantName` context.
- **Management UI**: Secure dashboard to manage tenants, limits, and configuration sets.
- **Reliability**: Atomic locking, exponential backoff retries, and automatic queue cleanup.
- **Security**: Forced STARTTLS on port 587, API key protection, and rate limiting.
- **Dockerized**: Fully containerized with `docker-compose`.

## Prerequisites
- **AWS Account**: IAM user with `AmazonSESFullAccess` (or specific `ses:SendRawEmail` permissions).
- **Cloudflare Account**: For automatic Let's Encrypt DNS challenge.
- **Dokploy**: Or any Docker-compatible hosting environment.

## Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `AWS_ACCESS_KEY_ID` | Standard IAM Access Key (NOT SMTP) | - | Yes |
| `AWS_SECRET_ACCESS_KEY` | Standard IAM Secret Key (NOT SMTP) | - | Yes |
| `AWS_REGION` | AWS Region (e.g., `ap-southeast-1`) | `us-east-1` | Yes |
| `ADMIN_API_KEY` | Key to protect the Management UI/API | - | Yes |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Token (Zone:DNS:Edit) | - | Yes |
| `SMTP_DOMAIN` | Your relay domain (e.g., `relay.example.com`) | - | Yes |
| `DB_PASSWORD` | Password for the `ses_relay` DB user | `ses_relay_pass` | Yes |
| `DB_ROOT_PASSWORD` | Root password for MariaDB container | `root_pass` | Yes |

## Deployment on Dokploy

1.  **Create a new Project** in Dokploy.
2.  **Add a Compose Service** and point it to this repository.
3.  **Configure Environment Variables** in the Dokploy UI (see table above).
4.  **Expose Ports**:
    - Dokploy handles port `3000` (Web UI) automatically via Traefik.
    - **Manually expose port `587`** in Dokploy settings for SMTP traffic.
5.  **Deploy**: The application will automatically initialize the database schema on startup.

## Usage

### Web Interface
Access the dashboard at `http://your-domain.com` (or the Dokploy URL).
1.  **Login**: Enter your `ADMIN_API_KEY`.
2.  **Stats**: Monitor the queue status (Pending, Processing, Sent, Failed) in real-time.
3.  **Tenants**: Create tenants with specific **AWS Configuration Sets** and **Daily Limits**.

### SMTP Relay
Connect your SMTP client to `your-domain.com:587`.
- **Security**: STARTTLS is **mandatory**. Plaintext connections are rejected.
- **Authentication**: Use the `smtp_username` and `smtp_password` generated in the UI.

#### Client Configuration (msmtp)
```conf
host relay.example.com
port 587
tls on
tls_starttls on
tls_certcheck on
auth plain
user your_smtp_username
password your_smtp_password
```

## Let's Encrypt Integration (Cloudflare DNS)

The project uses a Certbot sidecar with the Cloudflare DNS challenge. This allows SSL generation even if your server is behind a firewall or Cloudflare Proxy.

### 1. Initial Setup (One-time)
Run this command from your server's compose directory:
```bash
cd /etc/dokploy/compose/<your-service-id>/code
docker compose run --rm certbot -c "
  echo 'dns_cloudflare_api_token = \$CLOUDFLARE_API_TOKEN' > /etc/letsencrypt/cloudflare.ini && 
  chmod 600 /etc/letsencrypt/cloudflare.ini && 
  certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini --dns-cloudflare-propagation-seconds 60 --email your-email@example.com --agree-tos --no-eff-email -d relay.example.com
"
```

### 2. Automatic Renewal
The `certbot` container checks for renewals every 12 hours. The `app` container will pick up new certificates upon restart.

## Operations & Maintenance

### Monitoring Logs
```bash
docker compose logs -f app    # Application & Worker logs
docker compose logs -f db     # Database logs
docker compose logs -f certbot # SSL renewal logs
```

### Queue Management
- **Retries**: Failed emails are retried 3 times with exponential backoff.
- **Cleanup**: Sent emails are automatically deleted after 7 days.
- **Manual Fix**: If the database schema gets out of sync, the app attempts auto-migration on startup.

## Architecture
- **Node.js (TypeScript)**: Core logic and SMTP server.
- **MariaDB**: Persistent storage for tenants and the mail queue.
- **Certbot**: Automated SSL management via DNS challenge.
- **AWS SES v2**: High-reputation email delivery with tenant context routing.
