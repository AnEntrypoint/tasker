#!/usr/bin/env -S deno run --allow-env --allow-net

import { envVars } from "./env.ts";

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

// Define parameters for the search (passed to the new task)
const searchQuery = "is:unread";
const maxMessagesPerUser = 5;

(async () => {
  await sleep(3000); // Give services time to potentially start
  const publishProcess = Deno.run({
    cmd: ["deno", "run", "-A", "./taskcode/publish.ts", "--all"],
    stdout: "piped",
    stderr: "piped"
  });

  const { code } = await publishProcess.status();
  // const rawOutput = await publishProcess.output(); // Output is often too verbose
  const rawError = await publishProcess.stderrOutput();

  // if (rawOutput.length) {
  //   console.log("Publish Output:", new TextDecoder().decode(rawOutput).trim());
  // }
  if (rawError.length) {
    console.error("Publish Errors:", new TextDecoder().decode(rawError).trim());
  }
  if (code !== 0) {
    throw new Error(`Publish script exited with code ${code}`);
  }
  console.log("Publish step completed successfully.");

  try {
    console.log(`Using SUPABASE_URL: ${SUPABASE_URL}`);
    console.log(
      `Using SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY ? "***REDACTED***" : "undefined"}`
    );

    console.log("Invoking 'gapi-bulk-user-search' task...");
    const startTime = Date.now();

    const response = await fetch(`${SUPABASE_URL}/functions/v1/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        name: "gapi-bulk-user-search",
        input: {
          searchQuery: searchQuery,
          maxMessagesPerUser: maxMessagesPerUser,
        },
      }),
    });

    const endTime = Date.now();
    const durationSeconds = (endTime - startTime) / 1000;
    console.log(`Task invocation took ${durationSeconds.toFixed(2)} seconds.`);

    const responseText = await response.text();
    let taskResult;
    try {
      taskResult = JSON.parse(responseText);
    } catch (parseError) {
      console.error("Failed to parse response as JSON:", responseText);
      throw new Error(`Non-JSON response received. Status: ${response.status}`);
    }

    if (!response.ok) {
        console.error(`Task execution failed with status ${response.status}.`);
        console.error("Response Body:", JSON.stringify(taskResult, null, 2));
        throw new Error(`Task execution failed. See logs above.`);
    }

    console.log("\n--- Task Execution Summary ---");
    console.log(JSON.stringify(taskResult, null, 2)); // Log the entire result from the task

    // Optional: Add specific checks based on the task's return structure
    if (taskResult?.output?.success === false) {
        console.warn("Task reported failure or partial failure.");
    } else if (taskResult?.output?.success === true) {
        console.log("Task reported success.");
    } else {
        console.warn("Task response format might be unexpected.");
    }

    if ((taskResult?.output?.errorCount ?? 0) > 0) {
        console.warn(`Task reported ${taskResult.output.errorCount} errors during execution.`);
        // Consider exiting with an error code if any errors occurred within the task
        // Deno.exit(1);
    }

  } catch (err) {
    console.error("\n--- Top Level CLI Error ---");
    console.error("Error executing tasks:", err);
    // Check for sdk-http-wrapper specific error structure
    if (err?.responseBody) {
        console.error("Proxy Response Body:", err.responseBody);
    } else if (err?.response?.data) { // Check for Axios-like error structure
        console.error("Proxy Error Data:", JSON.stringify(err.response.data, null, 2));
    } else if (err?.message) {
        console.error("Error Message:", err.message);
    }
    Deno.exit(1); // Exit with error code
  }
  Deno.exit(0); // Explicitly exit with success code
})(); 