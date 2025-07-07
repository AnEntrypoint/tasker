#!/usr/bin/env deno run --allow-read --allow-env --allow-net
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Define Supabase connection details from Supabase status output
const SUPABASE_URL = "http://127.0.0.1:8000"; // REST API URL (not Studio URL)
const SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing required environment variables");
  Deno.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function publishTask(taskName: string, taskCode: string, description: string) {
  console.log(`Publishing task: ${taskName}`);
  
  try {
    // Check if the task already exists
    const { data: existingTask, error: fetchError } = await supabase
      .from("task_functions")
      .select("*")
      .eq("name", taskName)
      .single();
    
    if (fetchError && fetchError.code !== "PGRST116") {
      console.error(`Error checking if task exists: ${fetchError.message}`);
      return false;
    }
    
    if (existingTask) {
      // Update existing task
      console.log(`Task '${taskName}' already exists, updating...`);
      const { error: updateError } = await supabase
        .from("task_functions")
        .update({
          code: taskCode,
          description: description,
          updated_at: new Date().toISOString()
        })
        .eq("name", taskName);
      
      if (updateError) {
        console.error(`Error updating task: ${updateError.message}`);
        return false;
      }
      
      console.log(`Task '${taskName}' updated successfully`);
    } else {
      // Create new task
      console.log(`Creating new task: ${taskName}`);
      const { error: insertError } = await supabase
        .from("task_functions")
        .insert({
          name: taskName,
          description: description,
          code: taskCode,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      
      if (insertError) {
        console.error(`Error creating task: ${insertError.message}`);
        return false;
      }
      
      console.log(`Task '${taskName}' created successfully`);
    }
    
    return true;
  } catch (error: unknown) {
    console.error(`Error publishing task: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// The test-ephemeral task code
const testEphemeralCode = `/**
 * @task test-ephemeral
 * @description Test task demonstrating ephemeral calls and pause/resume functionality
 * @param {object} input - Input parameters
 * @param {string} [input.message] - Optional message to include in response
 * @param {boolean} [input.callNested] - Whether to call a nested task
 * @returns {object} Result with nested call response if requested
 */
module.exports = async function execute(input, { tools }) {
  console.log("Starting test-ephemeral task with input:", JSON.stringify(input));
  
  // Execute different flows based on input
  if (input.callNested) {
    console.log("Calling nested task...");
    try {
      // This call should pause the current execution, save state, and resume later
      const nestedResult = await tools.tasks.execute("test-ephemeral", { 
        message: \`Nested call from \${input.message || "parent"}\`,
        callNested: false // Prevent infinite recursion
      });
      
      console.log("Nested task completed with result:", JSON.stringify(nestedResult));
      
      return {
        success: true,
        message: input.message || "Task executed with nested call",
        input,
        nestedResult
      };
    } catch (error) {
      console.error("Error in nested call:", error);
      return {
        success: false,
        error: error.message || String(error),
        input
      };
    }
  } else {
    // Simple execution without nested calls
    console.log("Executing without nested calls");
    return {
      success: true,
      message: input.message || "Task executed successfully",
      timestamp: new Date().toISOString(),
      input
    };
  }
}; `;

const simpleTestCode = `/**
 * @task simple-test
 * @description A simple test task that echoes the input message
 * @param {object} input - Input parameters
 * @param {string} [input.message] - Message to echo back
 * @returns {object} Result with the echoed message
 */
module.exports = async function execute(input, { tools }) {
  console.log("Starting simple-test task with input:", JSON.stringify(input));
  
  const message = input?.message || "No message provided";
  console.log("Message received:", message);
  
  // Return a simple result
  return {
    success: true,
    message: message,
    timestamp: new Date().toISOString()
  };
}; `;

async function main() {
  // Publish both tasks
  const taskEphemeralSuccess = await publishTask(
    "test-ephemeral", 
    testEphemeralCode,
    "Test task demonstrating ephemeral calls and pause/resume functionality"
  );
  
  const simpleTestSuccess = await publishTask(
    "simple-test", 
    simpleTestCode,
    "A simple test task that echoes the input message"
  );
  
  if (taskEphemeralSuccess && simpleTestSuccess) {
    console.log("All tasks published successfully!");
  } else {
    console.error("Failed to publish one or more tasks");
    Deno.exit(1);
  }
}

// Run the main function
await main(); 