#!/usr/bin/env -S deno run --allow-env --allow-net

import { envVars } from "./env.ts";
import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.9/client";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  await sleep(3000);
  try {
    console.log(`Using SUPABASE_URL: ${SUPABASE_URL}`);
    console.log(
      `Using SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY ? "***REDACTED***" : "undefined"}`
    );

    const tasksProxy = createServiceProxy('tasks', {
        baseUrl: `${SUPABASE_URL}/functions/v1/tasks`,
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'apikey': SUPABASE_ANON_KEY
        }
    });

    const result = await tasksProxy.execute('nested-task-caller', { topic });
    console.log(JSON.stringify(result, null, 2));
    if (result && result.data) {
        console.log("Extracted Task Output:", result.data);
    }
  } catch (err) {
    console.error("CLI Error:", err);
    if (err.responseBody) {
        console.error("Proxy Response Body:", err.responseBody);
    }
  }
  Deno.exit(0);
})();
