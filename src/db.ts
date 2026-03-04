import postgres from "postgres";
import { env } from "./config.ts";

export const sql = postgres(env.DATABASE_URL);
