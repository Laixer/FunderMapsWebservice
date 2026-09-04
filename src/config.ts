import { z } from "zod/v4";

const envSchema = z.object({
  DATABASE_URL: z.string(),
  PORT: z.coerce.number().default(8080),
  // Object storage holding the research source documents (issue
  // Laixer/FunderMapsApi#140). All optional: without them the service boots
  // and serves every product as before, only the `resource` link on the
  // research endpoints is missing (see src/document.ts). Same variable
  // names and values as FunderMapsApi so the two apps share one config.
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
});

export const env = envSchema.parse(process.env);
