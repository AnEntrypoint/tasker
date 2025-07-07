// Script to run GAPI test and capture task run ID
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

async function runAndCaptureTaskId() {
  console.log('Starting GAPI test and capturing task run ID...');
  
  const testType = Deno.args[0] || "echo";
  console.log(`Test type: ${testType}`);
  
  try {
    // Execute our task directly via the tasks endpoint
    const response = await fetch("http://127.0.0.1:8000/functions/v1/tasks", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
      },
      body: JSON.stringify({
        task: "gapi-test-sleep-resume",
        input: { 
          verbose: true,
          testType
        }
      })
    });

    if (response.ok) {
      const result = await response.json();
      console.log("Task execution started with service:", result.service);
      console.log("Status:", result.status);
      
      if (result.task_run_id) {
        console.log("Task run ID:", result.task_run_id);
        console.log("\nTo check status, run:");
        console.log(`deno run -A check-task-run.ts ${result.task_run_id}`);
        
        // Create a tasks.json file to store task IDs
        try {
          let tasks = [];
          try {
            const existing = await Deno.readTextFile('tasks.json');
            tasks = JSON.parse(existing);
          } catch {
            // File doesn't exist yet, that's fine
          }
          
          tasks.push({
            id: result.task_run_id,
            type: testType,
            time: new Date().toISOString()
          });
          
          // Keep only the last 10 tasks
          if (tasks.length > 10) {
            tasks = tasks.slice(-10);
          }
          
          await Deno.writeTextFile('tasks.json', JSON.stringify(tasks, null, 2));
          console.log("Task ID saved to tasks.json");
        } catch (error) {
          console.error("Error saving task ID:", error);
        }
        
        // Wait for a moment to let the task start processing
        console.log("Waiting 3 seconds before checking status...");
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Check the result
        const resultResponse = await fetch(`http://127.0.0.1:8000/functions/v1/tasks/result/${result.task_run_id}`, {
          method: "GET",
          headers: { 
            'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
          }
        });
        
        if (resultResponse.ok) {
          const taskResult = await resultResponse.json();
          console.log("\nInitial task status:", taskResult.status);
          console.log(JSON.stringify(taskResult, null, 2));
        }
      }
    } else {
      console.error(`Failed: ${response.status}`);
      const errorText = await response.text();
      console.error('Error:', errorText);
    }
  } catch (error) {
    console.error(`Request error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Run immediately
runAndCaptureTaskId(); 