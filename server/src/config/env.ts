import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const envFilesHighestPrecedenceFirst = ['.env', '../.env'];

loadDotenv({ path: envFilesHighestPrecedenceFirst, quiet: true });

const requiredInProduction = ['FIELD_ENCRYPTION_KEY', 'EMAIL_LOOKUP_PEPPER'] as const;

const devOnlyDefaults = {
  FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  EMAIL_LOOKUP_PEPPER: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
} as const;

function blankToUndefined(value: unknown): unknown {
  return value === '' ? undefined : value;
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    APP_ORIGIN: z
      .url()
      .transform((value) => new URL(value).origin)
      .default('http://localhost:5100'),
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

    DATABASE_URL: z.url().default('postgres://app:app@localhost:5433/app'),
    REDIS_URL: z.url().default('redis://localhost:6380'),
    BLOB_ROOT: z.string().min(1).default('var/blobs'),

    FIELD_ENCRYPTION_KEY: z.preprocess(blankToUndefined, z.string().optional()),
    EMAIL_LOOKUP_PEPPER: z.preprocess(blankToUndefined, z.string().optional()),

    RESEND_API_KEY: z.preprocess(blankToUndefined, z.string().min(1).optional()),
    SMTP_URL: z.preprocess(blankToUndefined, z.url().optional()),
    MAIL_FROM: z.preprocess(blankToUndefined, z.email().default('no-reply@example.com')),

    MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(2_147_483_648),
    MAX_CHUNK_BYTES: z.coerce.number().int().positive().default(4_194_320),
    ACCOUNT_QUOTA_BYTES: z.coerce.number().int().positive().default(10_737_418_240),
    TRANSFER_DEFAULT_TTL_HOURS: z.coerce.number().int().positive().default(168),
    TRANSFER_MAX_TTL_HOURS: z.coerce.number().int().positive().default(720),
    DOWNLOAD_GRANT_TTL_MINUTES: z.coerce.number().int().positive().default(15),
    SESSION_IDLE_HOURS: z.coerce.number().int().positive().default(24),
    SESSION_ABSOLUTE_DAYS: z.coerce.number().int().positive().default(14),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return;
    for (const key of requiredInProduction) {
      if (value[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when NODE_ENV=production`,
        });
      }
    }
    if (value.RESEND_API_KEY === undefined && value.SMTP_URL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'Either RESEND_API_KEY or SMTP_URL is required when NODE_ENV=production',
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', z.treeifyError(parsed.error));
  process.exit(1);
}

const { FIELD_ENCRYPTION_KEY, EMAIL_LOOKUP_PEPPER, ...rest } = parsed.data;

export const env = {
  ...rest,
  FIELD_ENCRYPTION_KEY: FIELD_ENCRYPTION_KEY ?? devOnlyDefaults.FIELD_ENCRYPTION_KEY,
  EMAIL_LOOKUP_PEPPER: EMAIL_LOOKUP_PEPPER ?? devOnlyDefaults.EMAIL_LOOKUP_PEPPER,
};
export const isProduction = env.NODE_ENV === 'production';
