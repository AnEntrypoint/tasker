/**
 * Detect-Stuck-Tasks - Diagnostic tool to identify stuck tasks in the system
 * 
 * This script creates a lightweight test task and monitors it continuously
 * to detect if it gets stuck in the processing pipeline.
 */
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

// Number of milliseconds to wait between status checks
const POLL_INTERVAL = 1000;
// Maximum number of polling attempts before giving up
const MAX_POLL_ATTEMPTS = 20;

async function detectStuckTasks() {
  console.log("=== Stuck Task Detection Tool ===");
  
  try {
    // 1. Create a lightweight echo test task
    console.log("Step 1: Initializing lightweight echo test task...");
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
          testType: "echo"  // Using echo mode to avoid hitting Google APIs
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to create task: ${response.status}`);
    }

    const result = await response.json();
    if (!result.task_run_id) {
      throw new Error("No task run ID returned");
    }

    console.log(`Task initialized with ID: ${result.task_run_id}`);
    
    // 2. Poll the task status repeatedly to detect if it's stuck
    console.log("\nStep 2: Monitoring task status for signs of stalling...");
    let pollCount = 0;
    let lastStatus = null;
    let statusChangeTimes = [];
    
    while (pollCount < MAX_POLL_ATTEMPTS) {
      pollCount++;
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
      
      console.log(`\nPoll attempt ${pollCount}/${MAX_POLL_ATTEMPTS}...`);
      
      const statusResponse = await fetch(`http://127.0.0.1:8000/functions/v1/tasks/result/${result.task_run_id}`, {
        method: "GET",
        headers: { 
          'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
        }
      });
      
      if (!statusResponse.ok) {
        console.error(`  Error checking status: ${statusResponse.status}`);
        continue;
      }
      
      const statusResult = await statusResponse.json();
      const currentTime = new Date().toISOString();
      
      console.log(`  Current status: ${statusResult.status}`);
      
      // Track status changes
      if (lastStatus !== statusResult.status) {
        const changeInfo = {
          from: lastStatus,
          to: statusResult.status,
          time: currentTime
        };
        statusChangeTimes.push(changeInfo);
        console.log(`  Status changed from ${lastStatus || 'initial'} to ${statusResult.status}`);
        lastStatus = statusResult.status;
      }
      
      // If we get a final status, we can stop polling
      if (statusResult.status === 'completed' || statusResult.status === 'failed') {
        console.log("\nTask reached final state:", statusResult.status);
        console.log("Full result:", JSON.stringify(statusResult, null, 2));
        break;
      }
    }
    
    // 3. Analyze the results
    console.log("\nStep 3: Analysis");
    
    if (pollCount >= MAX_POLL_ATTEMPTS) {
      console.log("⚠️ Task appears to be STUCK - reached maximum poll attempts");
    } else if (lastStatus === 'completed') {
      console.log("✅ Task completed successfully");
    } else if (lastStatus === 'failed') {
      console.log("❌ Task failed");
    } else {
      console.log("⚠️ Task status is inconclusive:", lastStatus);
    }
    
    console.log("\nStatus change timeline:");
    statusChangeTimes.forEach((change, index) => {
      console.log(`${index+1}. ${change.from || 'initial'} → ${change.to} at ${change.time}`);
      
      if (index > 0) {
        const prevTime = new Date(statusChangeTimes[index-1].time).getTime();
        const currTime = new Date(change.time).getTime();
        const duration = (currTime - prevTime) / 1000;
        console.log(`   Duration in ${statusChangeTimes[index-1].to} state: ${duration.toFixed(2)} seconds`);
      }
    });
    
    console.log("\nDiagnosis:");
    if (statusChangeTimes.length <= 1) {
      console.log("- Task appears to be STUCK in initial state");
      console.log("- Likely issue: Stack processor not processing the task or VM state not being properly saved");
    } else if (!statusChangeTimes.some(change => change.to === 'completed')) {
      console.log("- Task state changes occur but never reaches 'completed' state");
      console.log("- Likely issue: Task getting stuck during execution or hitting unhandled errors");
    }
    
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : String(error));
  }
}

// Run the detection immediately
detectStuckTasks(); 