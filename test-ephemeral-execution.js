#!/usr/bin/env -S deno run --allow-net --allow-env

// Test script for ephemeral task execution
import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";

// Get Supabase credentials
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

if (!SUPABASE_ANON_KEY) {
  console.error("Missing SUPABASE_ANON_KEY environment variable");
  Deno.exit(1);
}

// Create service proxies for needed services
const tasks = createServiceProxy("tasks", {
  baseUrl: `${SUPABASE_URL}/functions/v1/tasks`,
  headers: {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
  },
});

const supabase = createServiceProxy("supabase", {
  baseUrl: `${SUPABASE_URL}/functions/v1/wrappedsupabase`,
  headers: {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
  },
});

/**
 * Polls a task run until it's completed
 * @param {string} taskRunId - The task run ID to poll
 * @param {number} maxAttempts - Maximum number of polling attempts
 * @param {number} interval - Polling interval in milliseconds
 * @returns {Promise<any>} - The task result
 */
async function pollTaskRun(taskRunId, maxAttempts = 30, interval = 1000) {
  console.log(`Polling task run ${taskRunId}...`);
  
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Check task run status
      const taskRun = await supabase.from("task_runs").select("*").eq("id", taskRunId).single();
      
      if (taskRun.status === "completed") {
        console.log(`Task run ${taskRunId} completed successfully`);
        return taskRun.result;
      } else if (taskRun.status === "failed" || taskRun.status === "error") {
        console.error(`Task run ${taskRunId} failed: ${JSON.stringify(taskRun.error)}`);
        throw new Error(`Task failed: ${JSON.stringify(taskRun.error)}`);
      }
      
      console.log(`Task run ${taskRunId} status: ${taskRun.status} (attempt ${i + 1}/${maxAttempts})`);
      
      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, interval));
    } catch (error) {
      console.error(`Error polling task run: ${error.message}`);
      throw error;
    }
  }
  
  throw new Error(`Polling timeout for task run ${taskRunId}`);
}

/**
 * Execute a task ephemerally and poll for results
 * @param {string} taskName - The task name to execute
 * @param {object} input - The task input parameters
 * @returns {Promise<any>} - The task result
 */
async function executeEphemeralTask(taskName, input = {}) {
  console.log(`Executing task ${taskName} with input:`, input);
  
  try {
    // Submit the task for execution
    const response = await tasks.execute(taskName, input);
    
    if (response.error) {
      console.error(`Error executing task: ${response.error}`);
      throw new Error(response.error);
    }
    
    // Check if we have a task run ID to poll
    if (!response.taskRunId) {
      console.warn("No taskRunId returned, assuming direct execution");
      return response.result;
    }
    
    console.log(`Task submitted with run ID: ${response.taskRunId}`);
    
    // Poll for the task result
    return await pollTaskRun(response.taskRunId);
  } catch (error) {
    console.error(`Error executing task: ${error.message}`);
    throw error;
  }
}

async function main() {
  const args = Deno.args;
  
  // Get task name from command line or use default
  const taskName = args[0] || "gapi-list-domains-with-nested";
  
  // Parse input JSON if provided
  let input = {};
  if (args[1]) {
    try {
      input = JSON.parse(args[1]);
    } catch (e) {
      console.error(`Invalid JSON input: ${e.message}`);
      Deno.exit(1);
    }
  } else {
    // Default input for demonstration
    input = { includeStats: true };
  }
  
  console.log(`Running task ${taskName} with input:`, input);
  
  try {
    // Execute the task ephemerally
    const result = await executeEphemeralTask(taskName, input);
    
    // Display the results
    console.log("\n==== TASK RESULT ====");
    console.log(JSON.stringify(result, null, 2));
    console.log("\n==== END RESULT ====");
  } catch (error) {
    console.error(`Error: ${error.message}`);
    Deno.exit(1);
  }
}

// Run the main function
main().catch(error => {
  console.error("Unhandled error:", error);
  Deno.exit(1);
}); 