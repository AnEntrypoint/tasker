#!/usr/bin/env -S deno run --allow-env --allow-net

import { envVars } from "./env.ts";
import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";

const {
  SUPABASE_URL: _SUP_URL,
  SUPABASE_ANON_KEY: _SUP_KEY,
  EXT_SUPABASE_URL,
  EXT_SUPABASE_ANON_KEY,
} = envVars;

const SUPABASE_URL = EXT_SUPABASE_URL || _SUP_URL;
const SUPABASE_ANON_KEY = EXT_SUPABASE_ANON_KEY || _SUP_KEY;

// Parse arguments
const flags = parse(Deno.args, {
    string: ["query"],
    number: ["max-messages"],
    default: {
        query: "is:unread",
        "max-messages": 5,
    },
    alias: {
        q: "query",
        m: "max-messages",
    },
});

const searchQuery = flags.query;
const maxMessagesPerUser = flags["max-messages"];

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 4000)); //wait for server start, do not remove
  try {
    console.log(`[CLI] Using SUPABASE_URL: ${SUPABASE_URL}`);
    console.log(`[CLI] Using SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY ? "***REDACTED***" : "undefined"}`);
    console.log(`[CLI] Triggering task 'gapi-bulk-user-search' with query: "${searchQuery}", maxMessages: ${maxMessagesPerUser}`);

    const response = await fetch(`${SUPABASE_URL}/functions/v1/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        name: "gapi-bulk-user-search", // Task name
        input: { 
            searchQuery, 
            maxMessagesPerUser 
        },
      }),
    });

    console.log(`[CLI] Task execution request sent. Status: ${response.status}`);
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      console.log("[CLI] Task Response:");
      console.log(JSON.stringify(parsed, null, 2));
      // Also log the output field if it exists
      if (parsed && parsed.output) {
          console.log("\n[CLI] Task Output Field:");
          console.log(JSON.stringify(parsed.output, null, 2));
      } else if (parsed && parsed.error) {
          console.error("\n[CLI] Task Error Field:");
          console.error(JSON.stringify(parsed.error, null, 2));
      }
    } catch (e) {
      console.error("[CLI] Non-JSON response received:");
      console.error(text);
    }
    console.log(`[CLI] Script finished.`);
    Deno.exit(0);

  } catch (err) {
    console.error("[CLI] Error running script:", err);
    Deno.exit(1);
  }
})(); 