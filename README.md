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
    - `AWS_ACCESS_KEY_ID`
    - `AWS_SECRET_ACCESS_KEY`
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
Connect your SMTP client to `localhost:26` using the credentials provided by the API.

#### Troubleshooting
The relay is configured to use port **26** and has **TLS/SSL disabled** by default for simplicity.

## Let's Encrypt Integration

To make your SMTP relay verifiable with Let's Encrypt, you need a valid domain name (e.g., `smtp.yourdomain.com`) pointing to your server.

### Option 1: Manual Certbot (Easiest for standalone)
1.  Install Certbot on your host machine.
2.  Generate a certificate:
    ```bash
    sudo certbot certonly --standalone -d smtp.yourdomain.com
    ```
3.  Update your `docker-compose.yml` to mount the certificates:
    ```yaml
    services:
      app:
        # ...
        volumes:
          - /etc/letsencrypt/live/smtp.yourdomain.com/privkey.pem:/app/certs/server.key:ro
          - /etc/letsencrypt/live/smtp.yourdomain.com/fullchain.pem:/app/certs/server.crt:ro
    ```
4.  Restart the container.

### Option 2: Dokploy / Traefik (Advanced)
Since Dokploy uses Traefik, you can technically use Traefik to handle TLS termination for port 587. However, this requires advanced Traefik configuration (TCP Routers with TLS). 

The most reliable way for SMTP is to let the application handle STARTTLS directly using the volume mount method described in Option 1.

## Architecture
- **Node.js**: Main application logic.
- **MariaDB**: Stores tenant information and the mail queue.
- **AWS SES**: Final destination for emails.
- **Background Worker**: Polls the database for pending emails and sends them to SES.
