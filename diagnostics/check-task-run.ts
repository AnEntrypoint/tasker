// Tool to check task run status
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

// Get task run ID from command line
const taskRunId = Deno.args[0];

if (!taskRunId) {
  console.error('Please provide a task run ID as an argument');
  console.error('Usage: deno run -A check-task-run.ts <task_run_id>');
  Deno.exit(1);
}

console.log(`Checking status for task run ID: ${taskRunId}`);

try {
  const response = await fetch(`http://127.0.0.1:8000/functions/v1/tasks/status?id=${taskRunId}`, {
    method: "GET",
    headers: { 
      'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
    }
  });
  
  if (response.ok) {
    const result = await response.json();
    console.log("\nTask status:", result.status);
    
    if (result.status === 'completed' && result.result) {
      console.log("\n✅ Task completed successfully!");
      console.log(JSON.stringify(result.result, null, 2));
      
      if (result.result.checkpoints) {
        console.log("\nCheckpoints:");
        result.result.checkpoints.forEach((checkpoint: any, i: number) => {
          console.log(`  ${i+1}. ${checkpoint.step}: ${checkpoint.timestamp}`);
          
          // If we have enough checkpoints to analyze timing
          if (i > 0) {
            const prevTime = new Date(result.result.checkpoints[i-1].timestamp).getTime();
            const currTime = new Date(checkpoint.timestamp).getTime();
            const duration = (currTime - prevTime) / 1000;
            console.log(`     Duration: ${duration.toFixed(2)} seconds`);
          }
        });
      }
    } else if (result.status === 'failed') {
      console.log("\n❌ Task failed:");
      console.log(JSON.stringify(result.error || 'Unknown error', null, 2));
    } else {
      console.log("\nTask is still processing or in another state.");
      console.log(JSON.stringify(result, null, 2));
    }
  } else {
    console.error(`Failed: ${response.status}`);
    const errorText = await response.text();
    console.error('Error:', errorText);
  }
} catch (error) {
  console.error(`Request error: ${error instanceof Error ? error.message : String(error)}`);
} 