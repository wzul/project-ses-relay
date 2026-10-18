import { SESv2Client, ListEmailIdentitiesCommand, ListConfigurationSetsCommand } from '@aws-sdk/client-sesv2';

/**
 * SES pre-flight guard.
 *
 * SES accepts an SMTP message and only rejects it later, inside the worker, with
 * "Email address is not verified" or "Configuration set does not exist". By then the
 * client saw a 250 and the failure is buried in mail_queue. This cache lets the SMTP
 * layer answer with a real 5xx at DATA time instead.
 *
 * Fails OPEN: if the SES API cannot be reached, mail is queued as before.
 */

const TTL_MS = Number(process.env.SES_GUARD_TTL_MS || 120_000);

export interface SesGuardState {
  domains: Set<string>;
  configSets: Set<string>;
  fetchedAt: number;
  ok: boolean;
  error?: string;
}

const client = new SESv2Client({
  region: process.env.AWS_REGION || 'ap-southeast-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

let state: SesGuardState = {
  domains: new Set(),
  configSets: new Set(),
  fetchedAt: 0,
  ok: false,
};

let inflight: Promise<void> | null = null;

export async function refreshSesGuard(force = false): Promise<void> {
  if (process.env.SES_GUARD === 'off') return;
  if (!force && Date.now() - state.fetchedAt < TTL_MS) return;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const domains = new Set<string>();
      let nextToken: string | undefined;
      do {
        const res = await client.send(new ListEmailIdentitiesCommand({ NextToken: nextToken }));
        for (const id of res.EmailIdentities ?? []) {
          if (id.VerificationStatus === 'SUCCESS' && id.SendingEnabled !== false) {
            domains.add((id.IdentityName || '').toLowerCase());
          }
        }
        nextToken = res.NextToken;
      } while (nextToken);

      const configSets = new Set<string>();
      let csToken: string | undefined;
      do {
        const res = await client.send(new ListConfigurationSetsCommand({ NextToken: csToken }));
        // SESv2 returns bare names here, not objects.
        for (const cs of res.ConfigurationSets ?? []) {
          if (cs) configSets.add(cs);
        }
        csToken = res.NextToken;
      } while (csToken);

      state = { domains, configSets, fetchedAt: Date.now(), ok: true };
      console.log(
        `SES guard: ${domains.size} verified identities, ${configSets.size} configuration sets`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state = { ...state, fetchedAt: Date.now(), ok: false, error: message };
      console.warn(`SES guard disabled (${message}) — mail will be queued unvalidated`);
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Parse the From domain out of a raw RFC822 message. */
export function fromDomainOf(raw: Buffer): string | null {
  const head = raw.subarray(0, 64 * 1024).toString('utf-8');
  const m = head.match(/^from:.*?@([A-Za-z0-9._-]+\.[A-Za-z]{2,})/im);
  return m ? m[1].toLowerCase() : null;
}

/** null = allowed, string = reason to reject. */
export function sesRejectReason(raw: Buffer, configurationSet: string | null): string | null {
  if (process.env.SES_GUARD === 'off' || !state.ok) return null;

  const domain = fromDomainOf(raw);
  if (!domain) return 'Message has no parsable From: address';

  const allowed =
    state.domains.has(domain) ||
    // a verified identity can also be a single address: sender@example.com
    [...state.domains].some((id) => id.includes('@') && id.endsWith(`@${domain}`));

  if (!allowed) {
    return `Sender domain "${domain}" is not a verified identity in AWS SES — verify it (or send from a verified domain) before retrying`;
  }

  if (configurationSet && !state.configSets.has(configurationSet)) {
    return `Configuration set "${configurationSet}" does not exist in AWS SES`;
  }

  return null;
}
