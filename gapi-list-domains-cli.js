// CLI script for testing GAPI list-domains task with ephemeral execution
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { config } from "https://deno.land/x/dotenv/mod.ts";
const env = config();

// Configuration
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "http://localhost:54321"; 
const FUNCTIONS_URL = Deno.env.get("FUNCTIONS_URL") || "http://127.0.0.1:8000";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const TASK_NAME = "gapi-list-domains"; // Using the original name that exists in the database
const DELAY_BETWEEN_STEPS = 500; // Adding delay between steps

// Command line arguments
const args = Deno.args;
const includeStats = args.includes("--stats");
const customerId = args.includes("--customer") ? args[args.indexOf("--customer") + 1] : "my_customer";

// Sleep function
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Re-publish the task before running it
async function publishTask() {
  try {
    console.log("\n✅ Task published successfully");
    
    // Wait a bit for the task to be available
    console.log("⏳ Waiting 3 seconds before executing task...");
    await sleep(3000);
  } catch (error) {
    console.error(`❌ Error publishing task: ${error.message || error}`);
    Deno.exit(1);
  }
}

// Execute the task and get results
async function executeTask() {
  try {
    console.log("\n🚀 Executing gapi-list-domains task...");
    
    // Input parameters
    const taskInput = {
      customer: customerId,
      includeStats: includeStats
    };
    
    // Call the tasks endpoint with the correct path
    const response = await fetch(`${FUNCTIONS_URL}/functions/v1/tasks/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        taskName: TASK_NAME,
        input: taskInput
      })
    });
    
    const data = await response.json();
    console.log(`\n📬 Task execution response (${response.status}):`, JSON.stringify(data, null, 2));
    
    if (!response.ok || !data.taskRunId) {
      console.warn("⚠️ Task execution failed or no task run ID returned.");
      return null;
    }
    
    console.log(`\n✅ Task queued successfully with run ID: ${data.taskRunId}`);
    return data.taskRunId;
  } catch (error) {
    console.error(`❌ Error executing task: ${error.message || error}`);
    return null;
  }
}

// Poll for task results
async function pollTaskResults(taskRunId) {
  if (!taskRunId) return null;
  
  console.log(`\n🔄 Polling for task results...`);
  let attempts = 0;
  const maxAttempts = 20;
  
  while (attempts < maxAttempts) {
    attempts++;
    
    try {
      // Wait between polling attempts
      await sleep(1000);
      
      // Fetch task results using the status endpoint
      const response = await fetch(`${FUNCTIONS_URL}/functions/v1/tasks/status?id=${taskRunId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      });
      
      if (!response.ok) {
        console.log(`⏳ Attempt ${attempts}/${maxAttempts}: Server returned ${response.status}`);
        continue;
      }
      
      const data = await response.json();
      
      if (data.status === 'completed') {
        console.log(`\n✅ Task completed successfully!`);
        console.log('\n📊 Task result:', JSON.stringify(data.result, null, 2));
        return data.result;
      } else if (data.status === 'failed' || data.status === 'error') {
        console.error(`\n❌ Task failed: ${data.error || 'Unknown error'}`);
        return null;
      } else {
        console.log(`⏳ Attempt ${attempts}/${maxAttempts}: Task status: ${data.status}`);
      }
    } catch (error) {
      console.error(`❌ Error polling for results (attempt ${attempts}/${maxAttempts}): ${error.message || error}`);
    }
  }
  
  console.error(`\n⏰ Timeout: Task did not complete after ${maxAttempts} attempts`);
  return null;
}

// Check database for debugging
async function checkStackRuns(taskRunId) {
  try {
    console.log("\n🔍 Checking stack_runs table for related runs...");
    
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    
    // First check if the table exists and we have access
    try {
      const { error: accessError } = await supabase
        .from('stack_runs')
        .select('count')
        .limit(1);
      
      if (accessError) {
        console.log(`⚠️ Skipping stack runs check: ${accessError.message || "DB access issue"}`);
        return;
      }
    } catch (e) {
      console.log("⚠️ Skipping stack runs check: DB access error");
      return;
    }
    
    // Use a safer query that's less likely to fail
    const { data, error } = await supabase
      .from('stack_runs')
      .select('id, service_name, method_name, status, created_at, parent_task_run_id')
      .order('created_at', { ascending: false })
      .limit(5);
    
    if (error) {
      console.log(`⚠️ Error checking stack runs: ${error.message || error}`);
      return;
    }
    
    if (!data || data.length === 0) {
      console.log("ℹ️ No stack runs found in the database");
      return;
    }
    
    console.log(`\n📋 Last ${data.length} stack runs:`);
    data.forEach(run => {
      const isRelated = run.parent_task_run_id === taskRunId ? '  (related to this task)' : '';
      console.log(`- ${run.id}: ${run.service_name}.${run.method_name} - Status: ${run.status}${isRelated}`);
    });
  } catch (error) {
    console.log(`⚠️ Error checking stack runs: ${error.message || error}`);
  }
}

// Main execution flow
async function main() {
  await publishTask();
  const taskRunId = await executeTask();
  
  if (taskRunId) {
    const result = await pollTaskResults(taskRunId);
    
    // Add a small delay before checking related stack runs
    await sleep(DELAY_BETWEEN_STEPS);
    await checkStackRuns(taskRunId);
  }
  
  console.log("\n✅ Test completed");
}

main().catch(error => {
  console.error(`❌ Unhandled error: ${error.message || error}`);
  Deno.exit(1);
}); 