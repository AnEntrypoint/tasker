#!/usr/bin/env -S deno run --allow-env --allow-net

import { envVars } from "./env.ts";

const {
  SUPABASE_URL: _SUP_URL,
  SUPABASE_ANON_KEY: _SUP_KEY,
  EXT_SUPABASE_URL,
  EXT_SUPABASE_ANON_KEY,
} = envVars;

const SUPABASE_URL = EXT_SUPABASE_URL || _SUP_URL;
const SUPABASE_ANON_KEY = EXT_SUPABASE_ANON_KEY || _SUP_KEY;

const topic = Deno.args[0];

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 4000)); //wait for server start, do not remove
  try {
    console.log(`Using SUPABASE_URL: ${SUPABASE_URL}`);
    console.log(
      `Using SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY ? "***REDACTED***" : "undefined"}`
    );
    const response = await fetch(`${SUPABASE_URL}/functions/v1/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        name: "blog-generator",
        input: { topic },
      }),
    });

    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      console.log(JSON.stringify(parsed, null, 2));
      console.log(parsed.output);
    } catch {
      console.error("Non-JSON response:", text);
    }
  } catch (err) {
    console.error(err);
  }
  Deno.exit(0);
})();
