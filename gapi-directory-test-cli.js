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

// No input arguments needed for this task

(async () => {
  await sleep(3000);
  const publishProcess = Deno.run({
    cmd: ["deno", "run", "-A", "./taskcode/publish.ts", "--all"],
    stdout: "piped",
    stderr: "piped"
  });

  const { code } = await publishProcess.status();
  const rawOutput = await publishProcess.output();
  const rawError = await publishProcess.stderrOutput();

  //if (rawOutput.length) {
  //  console.log(new TextDecoder().decode(rawOutput).trim());
  //}
  if (rawError.length) {
    console.error(new TextDecoder().decode(rawError).trim());
  }
  if (code !== 0) {
    throw new Error(`Publish script exited with code ${code}`);
  }
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

    // --- Execute the Orchestrator Task ---
    console.log("Executing gmail-search-orchestrator task via proxy...");
    // Pass any input needed for the orchestrator (e.g., different query or max messages)
    const orchestratorInput = {
        searchQuery: "is:unread",
        maxMessagesPerUser: 5
    };
    const result = await tasksProxy.execute(`gmail-search-orchestrator`, orchestratorInput); 
    
    console.log("--- Orchestrator Task Response ---");
    // Log the full response structure from the orchestrator
    console.log(JSON.stringify(result, null, 2)); 

    // Optional: Log just the aggregated results part
    if (result && result.data && result.data.results) {
        console.log("\n--- Aggregated Search Results (from Orchestrator) ---");
        console.log(JSON.stringify(result.data.results, null, 2));
    }
    // Optional: Log summary
     if (result && result.data && result.data.summary) {
        console.log("\n--- Summary (from Orchestrator) ---");
        console.log(JSON.stringify(result.data.summary, null, 2));
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