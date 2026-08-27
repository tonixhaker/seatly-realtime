import { z } from 'zod';

const port = () => z.coerce.number().int().min(1).max(65535);

const origins = () =>
  z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    )
    .pipe(
      z
        .array(
          z
            .url({ protocol: /^https?$/ })
            .refine(
              (entry) => URL.canParse(entry) && new URL(entry).origin === entry,
              {
                message:
                  'must be an exact origin, with no path or trailing slash',
              },
            ),
        )
        .min(1),
    );

export const envSchema = z
  .object({
    PORT: port().default(3000),
    INTERNAL_PORT: port().default(3001),
    INTERNAL_TOKEN: z.string().min(1),
    REDIS_HOST: z.string().min(1),
    REDIS_PORT: port(),
    RABBITMQ_URL: z.string().min(1),
    CORE_API_URL: z.url({ protocol: /^https?$/ }),
    WEB_ORIGIN: origins(),
  })
  .refine((env) => env.INTERNAL_PORT !== env.PORT, {
    message: 'must differ from PORT',
    path: ['INTERNAL_PORT'],
  });

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    throw new Error(
      `Environment validation failed.\n${z.prettifyError(result.error)}`,
    );
  }

  return result.data;
}
