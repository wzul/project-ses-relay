# SES Relay

SMTP Relay with AWS SES Tenant Tagging & Queuing.

## Features
- **SMTP Relay**: Authenticates users against a MariaDB database.
- **Queuing**: Emails are stored in a `mail_queue` table before being sent to AWS SES.
- **Tenant Tagging**: Adds `X-SES-TENANT` header and SES `MessageTag` based on the authenticated tenant.
- **Management API**: Simple API to create and list tenants.
- **Dockerized**: Fully containerized with `docker-compose`.

## Deployment on Dokploy

1.  **Create a new Project** in Dokploy.
2.  **Add a Compose Service** and point it to this repository.
3.  **Configure Environment Variables** in the Dokploy UI:
    - `AWS_ACCESS_KEY_ID` (Standard IAM Access Key, **NOT** SMTP credentials)
    - `AWS_SECRET_ACCESS_KEY` (Standard IAM Secret Key, **NOT** SMTP credentials)
    - `AWS_REGION` (default: `us-east-1`)
    - `ADMIN_API_KEY` (a secure key to protect the Management API)
    - `DB_ROOT_PASSWORD` (for the MariaDB container)
    - `DB_PASSWORD` (for the application user)
4.  **Expose Ports**:
    - Dokploy will automatically handle the web port (3000) for the Management API.
    - You may need to manually expose port `587` for SMTP traffic in the Dokploy service settings.
5.  **Deploy**: Dokploy will build the image and start the services. The application includes a retry mechanism to wait for the database to be ready.

## Usage

### Web Interface
Access the management dashboard at `http://localhost:3000` (or your Dokploy domain).
1.  **Set Admin API Key**: Enter the `ADMIN_API_KEY` you configured in the environment variables.
2.  **Create Tenant**: Provide a name and a tenant tag.
3.  **Copy Credentials**: The SMTP username and password will be displayed once.

### Management API
- **Create Tenant**:
    ```bash
    curl -X POST http://localhost:3000/api/tenants \
      -H "Content-Type: application/json" \
      -H "X-API-Key: your_secure_admin_api_key" \
      -d '{"name": "My Tenant", "tenant_tag": "tenant_123"}'
    ```
    This will return the `smtp_username` and `smtp_password`.

- **List Tenants**:
    ```bash
    curl -H "X-API-Key: your_secure_admin_api_key" http://localhost:3000/api/tenants
    ```

### SMTP Relay
Connect your SMTP client to `localhost:587` using the credentials provided by the API.

#### Troubleshooting STARTTLS (SSL/TLS)
The relay uses a self-signed certificate by default.

If you are using **PHPMailer**, ensure you have these settings:
```php
$mail->Port = 587;
$mail->SMTPSecure = 'tls';
$mail->SMTPOptions = array(
    'ssl' => array(
        'verify_peer' => false,
        'verify_peer_name' => false,
        'allow_self_signed' => true
    )
);
```

If you are using **msmtp**, ensure you have these settings:
```conf
host your-domain.com
port 587
tls on
tls_starttls on
tls_certcheck off
auth plain
user your_smtp_username
password your_smtp_password
```
*Note: `tls_certcheck off` is required to ignore self-signed certificate errors.*

If you still get a `handshake failure`, it's because your client is trying to use STARTTLS on a server that has it disabled.

## Let's Encrypt Integration (Automatic)

The project is configured to automatically manage Let's Encrypt certificates using a Certbot sidecar.

### Prerequisites
1.  **DNS**: Point your domain (e.g., `smtp.yourdomain.com`) to your server's IP address.
2.  **Dokploy Domain**: In Dokploy, add the domain `smtp.yourdomain.com` to your service. This ensures Traefik routes HTTP traffic to the Node.js app.
3.  **Verify Access**: Ensure you can access the management dashboard via the domain before proceeding.

### 1. Initial Setup (One-time)
Run this command to generate your first certificate. Replace `your-email@example.com` with your real email and `smtp.yourdomain.com` with your domain.

**Note for Dokploy users**: You must run this command from the directory where Dokploy stores your compose file:
```bash
cd /etc/dokploy/compose/<your-service-id>/code
docker compose run --rm certbot certonly --webroot --webroot-path /var/www/html --email your-email@example.com --agree-tos --no-eff-email -d smtp.yourdomain.com
```

### 2. Automatic Renewal
The `certbot` container in `docker-compose.yml` is configured to check for renewals every 12 hours. When the certificate is renewed, the Node.js app will use the new files on the next restart.

### 3. Client Configuration (msmtp)
Now that you have a valid certificate, you can enable verification:
```conf
host smtp.yourdomain.com
port 587
tls on
tls_starttls on
tls_certcheck on  # <--- Now you can turn this ON!
auth plain
user your_username
password your_password
```

## Architecture
- **Node.js**: Main application logic.
- **MariaDB**: Stores tenant information and the mail queue.
- **AWS SES**: Final destination for emails.
- **Background Worker**: Polls the database for pending emails and sends them to SES.
