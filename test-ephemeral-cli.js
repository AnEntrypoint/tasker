// CLI script for testing the test-ephemeral task with ephemeral execution
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { config } from "https://deno.land/x/dotenv/mod.ts";
const env = config();

// Configuration
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
const FUNCTIONS_URL = Deno.env.get("FUNCTIONS_URL") || "http://127.0.0.1:8000";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const TASK_NAME = "test-ephemeral";

console.log('Starting test for test-ephemeral task with ephemeral execution');
console.log(`Using Supabase URL: ${SUPABASE_URL}`);
console.log(`Using Functions URL: ${FUNCTIONS_URL}`);

if (!SUPABASE_URL || !FUNCTIONS_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing required environment variables");
  Deno.exit(1);
}

// Get command line arguments
const args = Deno.args;
const shouldFailStep1 = args.includes("--fail-step1");
const shouldFailStep2 = args.includes("--fail-step2");
const timeout = args.includes("--timeout") ? 
  parseInt(args[args.indexOf("--timeout") + 1], 10) : 60;
const verbose = args.includes("--verbose");

console.log(`Test configuration:
- Fail Step 1: ${shouldFailStep1}
- Fail Step 2: ${shouldFailStep2}
- Timeout: ${timeout} seconds
- Verbose: ${verbose}
`);

// Poll for status until completed or error
async function pollTaskStatus(taskRunId, maxAttempts = timeout) {
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    attempts++;
    if (verbose) console.log(`Polling for task status with ID: ${taskRunId}`);
    console.log(`Attempt ${attempts}/${maxAttempts}: Calling status endpoint...`);
    
    const statusResponse = await fetch(`${FUNCTIONS_URL}/functions/v1/tasks/status?id=${taskRunId}`, {
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      }
    });
    
    if (!statusResponse.ok) {
      throw new Error(`Failed to get task status: ${statusResponse.status} - ${await statusResponse.text()}`);
    }
    
    const statusData = await statusResponse.json();
    console.log(`Task status (attempt ${attempts}): ${statusData.status}`);
    
    if (verbose && statusData.logs) {
      console.log("\nTask logs:");
      statusData.logs.forEach(log => {
        console.log(`[${log.level.toUpperCase()}] ${log.message}`);
      });
      console.log("");
    }
    
    // If task is completed or has an error, return the result
    if (statusData.status === 'completed' || statusData.status === 'error' || statusData.status === 'failed') {
      return statusData;
    }
    
    // Wait before polling again
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  throw new Error(`Task did not complete within ${maxAttempts} attempts`);
}

// Check database for debugging
async function checkStackRuns(taskRunId) {
  if (!verbose) return;
  
  try {
    console.log("\nChecking stack_runs table for related runs...");
    
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    
    // First check if the table exists and we have access
    try {
      const { error: accessError } = await supabase
        .from('stack_runs')
        .select('count')
        .limit(1);
      
      if (accessError) {
        if (accessError.code === '42P01') {
          console.error("Error: Table 'stack_runs' does not exist in the database");
        } else {
          console.error(`Error accessing stack_runs table: ${accessError.message}`);
        }
        console.warn("Skipping stack runs check due to database access issue");
        return;
      }
    } catch (e) {
      console.error("Error checking database access:", e);
      console.warn("Skipping stack runs check due to database access issue");
      return;
    }
    
    // Use a safer query that's less likely to fail
    const query = supabase
      .from('stack_runs')
      .select('*');
      
    // Only add the filter if we have a valid task run ID
    if (taskRunId && typeof taskRunId === 'string' && taskRunId.trim() !== '') {
      query.or(`parent_task_run_id.eq.${taskRunId},id.eq.${taskRunId}`);
    }
    
    const { data: stackRuns, error } = await query;
    
    if (error) {
      console.error("Error querying stack_runs:", error);
      return;
    }
    
    if (stackRuns && stackRuns.length > 0) {
      // If we didn't filter, show that we're displaying all runs
      if (!taskRunId || typeof taskRunId !== 'string' || taskRunId.trim() === '') {
        console.log(`Found ${stackRuns.length} total stack runs (no filter applied):`);
      } else {
        console.log(`Found ${stackRuns.length} related stack runs for task ${taskRunId}:`);
      }
      
      // Only show the most recent 10 runs if there are many
      const runsToShow = stackRuns.length > 10 ? stackRuns.slice(0, 10) : stackRuns;
      
      runsToShow.forEach(run => {
        console.log(`- ${run.id} (${run.service_name}.${run.method_name}): ${run.status}`);
      });
      
      if (stackRuns.length > 10) {
        console.log(`... and ${stackRuns.length - 10} more runs (showing only the first 10)`);
      }
    } else {
      console.log("No stack runs found matching the criteria.");
    }
  } catch (e) {
    console.error("Error checking stack runs:", e);
    console.warn("Stack runs check functionality may not be available in your environment");
  }
}

async function runTest() {
  try {
    // First, publish the task to make sure we have the latest version
    console.log("Publishing test-ephemeral task...");
    try {
      const publishResponse = await fetch(`${FUNCTIONS_URL}/functions/v1/tasks/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({
          taskName: TASK_NAME
        })
      });
      
      if (!publishResponse.ok) {
        console.warn(`Failed to publish task: ${publishResponse.status} - ${await publishResponse.text()}`);
        console.warn("Continuing with execution anyway...");
      } else {
        console.log("Task published successfully.");
      }
    } catch (e) {
      console.warn("Error publishing task:", e);
      console.warn("Continuing with execution anyway...");
    }
    
    // Add a delay before starting to ensure functions are ready
    console.log("Waiting 3 seconds before executing task...");
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log(`Executing ${TASK_NAME} task...`);
    
    // Call the tasks endpoint to execute the test-ephemeral task
    const response = await fetch(`${FUNCTIONS_URL}/functions/v1/tasks/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        taskName: TASK_NAME,
        input: {
          failStep1: shouldFailStep1,
          failStep2: shouldFailStep2
        }
      })
    });
    
    const responseText = await response.text();
    console.log(`Task execution response (${response.status}):`, responseText);
    
    if (!response.ok) {
      throw new Error(`Task execution failed: ${responseText}`);
    }
    
    let taskResult;
    try {
      taskResult = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`Failed to parse response: ${responseText}`);
    }
    
    // Extract task run ID
    const taskRunId = taskResult.taskRunId;
    if (!taskRunId) {
      throw new Error("No task run ID returned from task execution");
    }
    
    console.log(`Task run ID: ${taskRunId}`);
    
    // Check database for stack runs
    await checkStackRuns(taskRunId);
    
    // Poll for task completion
    console.log("Polling for task completion...");
    const finalResult = await pollTaskStatus(taskRunId, timeout);
    
    // Check database again after completion
    await checkStackRuns(taskRunId);
    
    // Display the result nicely
    console.log("\n=== TEST EPHEMERAL TASK RESULTS ===\n");
    if (finalResult.status === 'completed') {
      console.log("Task completed successfully.");
      console.log(JSON.stringify(finalResult.result, null, 2));
    } else if (finalResult.status === 'error' || finalResult.status === 'failed') {
      console.error("Task failed with error:", finalResult.error);
    } else {
      console.log("Task completed with unexpected status:", finalResult.status);
    }
    
    console.log("\nTest completed");
  } catch (error) {
    console.error("Test failed:", error);
    Deno.exit(1);
  }
}

// Run the test
await runTest(); 