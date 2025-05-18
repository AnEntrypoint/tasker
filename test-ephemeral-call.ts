// Test script for testing ephemeral task execution with pause/resume functionality
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { config } from "https://deno.land/x/dotenv/mod.ts";
const env = config();

// Configuration
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "http://localhost:54321"; // Use localhost:54321 for direct REST API access
const FUNCTIONS_URL = Deno.env.get("FUNCTIONS_URL") || "http://127.0.0.1:8000"; // Keep this for edge functions access
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"; // Updated with actual anon key
const TASK_NAME = "test-ephemeral";

console.log('Starting test for hierarchical task execution');
console.log(`Using Supabase URL: ${SUPABASE_URL}`);
console.log(`Using Functions URL: ${FUNCTIONS_URL}`);

if (!SUPABASE_URL || !FUNCTIONS_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing required environment variables");
  Deno.exit(1);
}

// Add initial delay to make sure Supabase functions are running
console.log("Waiting for 10 seconds before executing task");
await new Promise(resolve => setTimeout(resolve, 10000));

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Helper to format console output
function logSeparator(message: string): void {
  console.log("\n" + "=".repeat(80));
  console.log(" 📋 " + message);
  console.log("=".repeat(80) + "\n");
}

// Poll for status until completed or error
async function pollTaskStatus(taskRunId: string, maxAttempts = 30): Promise<any> {
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    attempts++;
    console.log(`Polling for task status with ID: ${taskRunId}`);
    console.log(`Attempt ${attempts}: Calling status endpoint...`);
    
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
        
    // If task is completed or has an error, return the result
    if (statusData.status === 'completed' || statusData.status === 'error') {
          return statusData;
        }
    
    // Wait before polling again
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  throw new Error(`Task did not complete within ${maxAttempts} attempts`);
}

// Function to execute task and handle suspended state
async function executeTask(taskName: string, input: any): Promise<any> {
  logSeparator(`Executing task: ${taskName}`);
  console.log("Input:", JSON.stringify(input, null, 2));
  
  // Call the tasks endpoint using the FUNCTIONS_URL where edge functions are running
  const response = await fetch(`${FUNCTIONS_URL}/functions/v1/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
    },
    body: JSON.stringify({
      taskName,
      input
    })
  });
  
  const responseData = await response.json();
  console.log("Initial Response:", JSON.stringify(responseData, null, 2));
  
  // If the task was suspended, poll for completion
  if (response.status === 202 && responseData.taskRunId) {
    console.log(`Task suspended with ID: ${responseData.taskRunId}`);
    console.log("Polling for completion...");
    
    const finalResult = await pollTaskStatus(responseData.taskRunId);
    return finalResult;
  }
  
  return responseData;
}

async function runTest() {
  try {
    // Step 1: Call the task edge function to execute the test-ephemeral task
    console.log("Executing test-ephemeral task...");
    
    // Use the correct endpoint path
    const taskResponse = await fetch(`${FUNCTIONS_URL}/functions/v1/tasks/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        taskName: TASK_NAME,
        input: { message: "Hello from ephemeral test!" }
      })
    });
    
    const responseText = await taskResponse.text();
    console.log(`Task execution response (${taskResponse.status}):`, responseText);
    
    if (!taskResponse.ok) {
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
    
    // Step 2: Poll for task completion
    console.log("Polling for task completion...");
    const finalResult = await pollTaskStatus(taskRunId);
    
    console.log("Final task result:", finalResult);
    
    // Step 3: Test error handling by executing the task with throwError: true
    console.log("\n=== Testing Error Handling ===\n");
    console.log("Executing test-ephemeral task with throwError: true");
    
    const errorTaskResponse = await fetch(`${FUNCTIONS_URL}/functions/v1/tasks/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        taskName: TASK_NAME,
        input: { 
          message: "This task will throw an error",
          throwError: true
        }
      })
    });
    
    const errorResponseText = await errorTaskResponse.text();
    console.log(`Error task execution response (${errorTaskResponse.status}):`, errorResponseText);
    
    if (!errorTaskResponse.ok) {
      throw new Error(`Error task execution failed: ${errorResponseText}`);
    }
    
    let errorTaskResult;
    try {
      errorTaskResult = JSON.parse(errorResponseText);
    } catch (e) {
      throw new Error(`Failed to parse error response: ${errorResponseText}`);
    }
    
    // Extract error task run ID
    const errorTaskRunId = errorTaskResult.taskRunId;
    if (!errorTaskRunId) {
      throw new Error("No task run ID returned from error task execution");
    }
    
    console.log(`Error task run ID: ${errorTaskRunId}`);
    
    // Step 4: Poll for error task completion
    console.log("Polling for error task completion...");
    try {
      const errorFinalResult = await pollTaskStatus(errorTaskRunId);
      console.log("Error task final result:", errorFinalResult);
      
      // Verify that the task failed with our expected error
      if (errorFinalResult.status !== 'error' || !errorFinalResult.error) {
        throw new Error("Expected error task to fail, but it did not fail correctly");
      }
      
      console.log("Error task failed as expected:", errorFinalResult.error);
    } catch (pollError) {
      console.log("Error polling task (expected):", pollError);
    }
    
    console.log("Test completed successfully");
  } catch (error) {
    console.error("Test failed:", error);
    Deno.exit(1);
  }
}

// Add a delay before starting the test to allow the functions server to initialize
console.log("Waiting 5 seconds before starting the test...");
await new Promise(resolve => setTimeout(resolve, 5000));

// Run the test
await runTest(); 