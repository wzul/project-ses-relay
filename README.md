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

## Use Case: Multi-Tenant Hosting

This project is ideal for SaaS providers or agencies hosting multiple clients who need to send emails via AWS SES.

- **Isolation**: Each client gets their own SMTP username and password.
- **Automatic Tagging**: When a client sends an email, the relay automatically maps their credentials to their specific **Tenant ID** (via `TenantName` and `X-Tenant-ID` header).
- **Zero Configuration for Clients**: Clients don't need to know about AWS, IAM keys, or Tenant IDs. They just use standard SMTP credentials.
- **Credential Security**: Your master AWS IAM keys and main SMTP settings are never exposed to your clients.
- **Control**: You can pause sending or set daily limits for specific clients without affecting others.

## Prerequisites
- **AWS Account**: IAM user with `AmazonSESFullAccess` (or specific `ses:SendRawEmail` permissions).
- **Cloudflare Account**: For automatic Let's Encrypt DNS challenge.
- **Dokploy**: Or any Docker-compatible hosting environment.

## Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `AWS_ACCESS_KEY_ID` | Standard IAM Access Key (NOT SMTP) | - | Yes |
| `AWS_SECRET_ACCESS_KEY` | Standard IAM Secret Key (NOT SMTP) | - | Yes |
| `AWS_REGION` | AWS Region (e.g., `ap-southeast-1`) | `ap-southeast-1` | Yes |
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
- **Visibility**: Every email sent through the relay will include an `X-Tenant-ID` header containing the tenant's tag for easy identification in the message source.

#### Client Configuration (msmtp)
```conf
host relay.example.com
port 587
tls on
tls_starttls on
tls_certcheck on
auth on
user your_smtp_username
password your_smtp_password
```
*Note: `auth on` is secure here because the connection is encrypted via STARTTLS before authentication occurs.*

## API Reference

All API requests (except `/api/health`) require the `X-API-Key` header.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/tenants` | GET | List all tenants |
| `/api/tenants` | POST | Create a new tenant |
| `/api/tenants/:id` | PUT | Update an existing tenant |
| `/api/stats` | GET | Get real-time queue statistics |
| `/api/health` | GET | Service health check (Public) |
| `/api/verify` | GET | Verify Admin API Key |

## AWS SES Setup
To ensure emails are delivered correctly:
1.  **Verify Domain**: Your `SMTP_DOMAIN` (or the domain used in `From` addresses) must be verified in the AWS SES Console.
2.  **Configuration Sets**: If you assign a Configuration Set to a tenant, ensure it exists in the **same AWS Region** as your relay.
3.  **Permissions**: The IAM user must have `ses:SendRawEmail` and `ses:GetSendQuota` permissions.

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
