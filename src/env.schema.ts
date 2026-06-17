import { z } from 'zod';

const port = () => z.coerce.number().int().min(1).max(65535);

export const envSchema = z.object({
  PORT: port().default(3000),
  INTERNAL_TOKEN: z.string().min(1),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: port(),
  RABBITMQ_URL: z.string().min(1),
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
