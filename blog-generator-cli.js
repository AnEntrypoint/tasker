#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read
/**
 * CLI script to execute the blog-generator task
 * 
 * Usage: deno run --allow-net --allow-env --allow-read blog-generator-cli.js <topic>
 */
import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

// Load environment variables
const env = config();

// Get the topic from command line arguments
const topic = Deno.args[0] || "Artificial Intelligence";

// Create Supabase client configuration
const supabaseUrl = env.SUPABASE_URL || "http://127.0.0.1:8000";
const supabaseKey = env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

/**
 * Execute a task directly via the tasks endpoint
 */
async function executeTask(taskId, input) {
  console.log(`Executing task ${taskId} directly...`);
  await new Promise(resolve => setTimeout(resolve, 3000)); // Add 3-second delay

  const response = await fetch(`${supabaseUrl}/functions/v1/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${supabaseKey}`,
      'apikey': supabaseKey
    },
    body: JSON.stringify({
      name: taskId,
      input: input
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to execute task: ${errorText}`);
  }
  
  const result = await response.json();
  console.log(`Task ${taskId} executed successfully`);
  
  return result;
}

/**
 * Main function
 */
async function main() {
  try {
    console.log(`=== Generating Blog About: ${topic} ===`);
    
    // Execute the blog-generator task
    const blogInput = { topic };
    console.log(`Generating blog about: ${blogInput.topic}`);
    
    // Execute the blog-generator task
    console.log('\nExecuting blog-generator task...');
    const startTime = Date.now();
    const blogResult = await executeTask('blog-generator', blogInput);
    const endTime = Date.now();
    console.log(`Task execution time: ${(endTime - startTime) / 1000} seconds`);
    
    // Handle the ephemeral response
    if (blogResult && blogResult.success === true && blogResult.taskRunId) {
      console.log(`\nTask successfully queued.`);
      console.log(`Status: ${blogResult.status}`);
      console.log(`Task Run ID: ${blogResult.taskRunId}`);
      console.log(`Message: ${blogResult.message || 'Check task_runs table for completion status and result.'}`);
    } else if (blogResult && blogResult.success === false) {
        console.error(`\nTask execution failed: ${blogResult.error || 'Unknown error'}`);
    } else {
      console.log('\nUnexpected or non-ephemeral response format:', JSON.stringify(blogResult, null, 2));
    }
    
    console.log('\n=== Blog Generation Request Completed ===');
    await new Promise(resolve => setTimeout(resolve, 15000)); // Add 3-second delay
  } catch (error) {
    console.error('Error executing task:', error);
  }
}

// Run the main function
await main();
