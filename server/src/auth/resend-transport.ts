import { z } from 'zod';

import { env } from '../config/env.js';
import { logger } from '../logger.js';
import type { Mail } from './mailer.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 15_000;

const acceptedSchema = z.object({ id: z.string() });
const rejectedSchema = z.object({ name: z.string().optional(), message: z.string().optional() });

async function describeRejection(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = rejectedSchema.safeParse(body);
  if (!parsed.success) return response.statusText;
  return parsed.data.message ?? parsed.data.name ?? response.statusText;
}

export async function sendViaResend(apiKey: string, mail: Mail): Promise<void> {
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const reason = await describeRejection(response);
    throw new Error(`Resend rejected the message with ${String(response.status)}: ${reason}`);
  }

  const accepted = acceptedSchema.safeParse(await response.json());
  logger.info(
    { providerMessageId: accepted.success ? accepted.data.id : undefined },
    'delivered email via Resend',
  );
}
