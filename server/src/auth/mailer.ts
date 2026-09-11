import { lookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import nodemailer from 'nodemailer';

import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { sendViaResend } from './resend-transport.js';

const DEV_MAIL_DIR = 'var/mail';
const IPV4 = 4;
const IMPLICIT_TLS_PORT = 465;
const STARTTLS_PORT = 587;
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

async function writeDevMail(mail: Mail, rendered: string): Promise<void> {
  await mkdir(DEV_MAIL_DIR, { recursive: true });
  const fileName = `${String(Date.now())}-${mail.to.replaceAll(/[^\w.@-]/g, '_')}.eml`;
  await writeFile(path.join(DEV_MAIL_DIR, fileName), rendered);
  logger.info({ file: fileName }, 'wrote dev email to disk');
}

async function ipv4SmtpOptions(smtpUrl: string) {
  const url = new URL(smtpUrl);
  const secure = url.protocol === 'smtps:';
  const { address } = await lookup(url.hostname, { family: IPV4 });
  return {
    host: address,
    port: url.port ? Number(url.port) : secure ? IMPLICIT_TLS_PORT : STARTTLS_PORT,
    secure,
    tls: { servername: url.hostname },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    ...(url.username
      ? {
          auth: {
            user: decodeURIComponent(url.username),
            pass: decodeURIComponent(url.password),
          },
        }
      : {}),
  };
}

async function sendViaSmtp(smtpUrl: string, mail: Mail): Promise<void> {
  const transport = nodemailer.createTransport(await ipv4SmtpOptions(smtpUrl));
  await transport.sendMail({
    from: env.MAIL_FROM,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
  });
}

async function sendViaDevStream(mail: Mail): Promise<void> {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const info = await transport.sendMail({
    from: env.MAIL_FROM,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
  });
  if (!Buffer.isBuffer(info.message)) {
    throw new Error('Expected the dev stream transport to buffer the message');
  }
  await writeDevMail(mail, info.message.toString('utf8'));
}

export async function sendMail(mail: Mail): Promise<void> {
  if (env.RESEND_API_KEY) {
    await sendViaResend(env.RESEND_API_KEY, mail);
    return;
  }
  if (env.SMTP_URL) {
    await sendViaSmtp(env.SMTP_URL, mail);
    return;
  }
  await sendViaDevStream(mail);
}
