import { z } from "zod/v4";

const envSchema = z.object({
  DATABASE_URL: z.string(),
  PORT: z.coerce.number().default(8080),
});

export const env = envSchema.parse(process.env);
