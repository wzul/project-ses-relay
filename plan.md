## Plan: SMTP Relay with AWS SES Tenant Tagging & Queuing (MariaDB)

Create a Node.js-based SMTP relay server that authenticates users against a MariaDB database, queues emails locally, and forwards them to AWS SES with a `tenant_id` tag and a custom header.

**Steps**

### Phase 1: Project Setup
1. Initialize a Node.js project with TypeScript.
2. Install dependencies: `smtp-server`, `mailparser`, `@aws-sdk/client-sesv2`, `mysql2`, `express`, `dotenv`, `bcrypt`.
3. Set up a MariaDB schema for `tenants` (id, name, smtp_username, smtp_password_hash, tenant_tag) and `mail_queue` (id, tenant_id, raw_email, status, retries, created_at).

### Phase 2: SMTP Relay & Queuing Implementation
1. Create an SMTP server using `smtp-server` on port 587 with STARTTLS support.
2. Implement `onAuth` callback to verify credentials against the MariaDB database.
3. Implement `onData` callback to:
    - Parse the incoming email using `mailparser`.
    - Identify the tenant based on the authenticated session.
    - Save the email content and tenant info into a `mail_queue` table in MariaDB with status `pending`.
    - Acknowledge receipt to the SMTP client immediately (Send and Forget).
4. Implement a background worker that:
    - Polls the `mail_queue` table for `pending` emails.
    - Forwards them to AWS SES using `SendRawEmail`.
    - Adds the `X-SES-TENANT` header and `MessageTag`.
    - Updates the status to `sent` or `failed` (with retry logic).

### Phase 3: Management API
1. Create a simple Express.js API to manage tenants.
2. `POST /api/tenants`: Create a new tenant with a name. Generate a random SMTP username and password. Store the password hash.
3. `GET /api/tenants`: List all tenants and their SMTP usernames.

### Phase 4: Deployment & Configuration (Docker Compose)
1. Create a `Dockerfile` for the Node.js application.
2. Create a `docker-compose.yml` file to orchestrate the Node.js app and a MariaDB container.
3. Set up environment variables for AWS credentials, MariaDB connection details, and SMTP configuration.
4. Prepare for Dokploy deployment.

**Relevant files**
- `src/index.ts` — Main entry point for SMTP and API servers.
- `src/db.ts` — MariaDB database initialization and helper functions.
- `src/smtp.ts` — SMTP server logic and AWS SES integration.
- `src/worker.ts` — Background worker for processing the mail queue.
- `src/api.ts` — Express.js routes for tenant management.
- `Dockerfile` — Containerization for the Node.js app.
- `docker-compose.yml` — Orchestration for app and MariaDB.
- `.env.example` — Template for environment variables.

**Verification**
1. Use an SMTP client (e.g., `swaks` or a simple script) to send an email through the relay.
2. Verify that the email is received and contains the `X-SES-TENANT` header and `tenant_id` tag in AWS SES.
3. Test the management API to create and list tenants.

**Decisions**
- **Database**: MariaDB for robust queuing and multi-tenant management.
- **SMTP Port**: 587 with STARTTLS.
- **Queuing**: Emails are stored in a `mail_queue` table in MariaDB before being sent to AWS SES. This allows the SMTP server to acknowledge receipt immediately (Send and Forget).
- **Background Worker**: A simple polling mechanism to process the queue and handle retries.
- **AWS SES**: Using `SendRawEmail` to preserve the original email structure while adding the `X-SES-TENANT` header and SES `MessageTag`.
- **Tenant Tagging**: Using `MessageTag` in SES and `X-SES-TENANT` header to identify the tenant.
- **Docker**: The project will use `docker-compose` to manage the application and MariaDB.

**Further Considerations**
1. **Security**: Ensure the SMTP server is only accessible via authenticated users.
2. **Rate Limiting**: Consider adding rate limiting per tenant to prevent abuse.
3. **Logging**: Implement logging for sent emails and errors.
