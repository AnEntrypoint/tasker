#!/usr/bin/env -S deno run --allow-env --allow-net

import { envVars } from "./env.ts";
import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";

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

// Optional: Get search query from command line arguments
const customSearchQuery = Deno.args[0]; // Example: deno run ... cli.js "subject:Test"
const taskInput = customSearchQuery ? { searchQuery: customSearchQuery } : {};

(async () => {
  await sleep(3000);
  try {
    console.log(`Using SUPABASE_URL: ${SUPABASE_URL}`);
    console.log(
      `Using SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY ? "***REDACTED***" : "undefined"}`
    );

    console.log("Creating tasks service proxy...");
    const tasksProxy = createServiceProxy('tasks', {
        baseUrl: `${SUPABASE_URL}/functions/v1/tasks`,
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'apikey': SUPABASE_ANON_KEY
        }
    });

    console.log(`Executing gmail-search-all-users task via proxy... Input: ${JSON.stringify(taskInput)}`);
    const result = await tasksProxy.execute('gmail-search-all-users', taskInput); 
    
    console.log("--- Full Task Response ---");
    console.log(JSON.stringify(result, null, 2));

    if (result && result.data) {
        console.log("\n--- Extracted Task Output --- ");
        console.log(JSON.stringify(result.data, null, 2));
    }
  } catch (err) {
    console.error("CLI Error:", err);
    // Check for sdk-http-wrapper specific error structure
    if (err?.responseBody) {
        console.error("Proxy Response Body:", err.responseBody);
    } else if (err?.response?.data) { // Check for Axios-like error structure
        console.error("Proxy Error Data:", JSON.stringify(err.response.data, null, 2));
    } else if (err?.message) {
        console.error("Error Message:", err.message);
    }
  }
  Deno.exit(0);
})(); 