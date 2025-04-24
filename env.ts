import { config } from "https://deno.land/x/dotenv/mod.ts";

// Load environment variables from .env file
const envVars = await config();

// Set environment variables
for (const [key, value] of Object.entries(envVars)) {
  Deno.env.set(key, value);
}

export { envVars };
