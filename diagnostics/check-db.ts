// Tool to check task/stack runs in the database
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

async function checkDatabase() {
  console.log('Checking database for task and stack runs...');
  
  try {
    // Query task_runs table
    const taskRunsResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedsupabase", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
      },
      body: JSON.stringify({
        chain: [
          { type: "call", property: "from", args: ["task_runs"] },
          { type: "call", property: "select", args: ["*"] },
          { type: "call", property: "order", args: ["created_at", { ascending: false }] },
          { type: "call", property: "limit", args: [10] }
        ]
      })
    });

    if (taskRunsResponse.ok) {
      const taskRunsResult = await taskRunsResponse.json();
      console.log("\nLatest task runs:");
      console.log(JSON.stringify(taskRunsResult.data, null, 2));
    } else {
      console.error(`Failed to query task_runs: ${taskRunsResponse.status}`);
    }
    
    // Query stack_runs table
    const stackRunsResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedsupabase", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
      },
      body: JSON.stringify({
        chain: [
          { type: "call", property: "from", args: ["stack_runs"] },
          { type: "call", property: "select", args: ["*"] },
          { type: "call", property: "order", args: ["created_at", { ascending: false }] },
          { type: "call", property: "limit", args: [10] }
        ]
      })
    });

    if (stackRunsResponse.ok) {
      const stackRunsResult = await stackRunsResponse.json();
      console.log("\nLatest stack runs:");
      console.log(JSON.stringify(stackRunsResult.data, null, 2));
    } else {
      console.error(`Failed to query stack_runs: ${stackRunsResponse.status}`);
    }
  } catch (error) {
    console.error(`Request error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Run the check
await checkDatabase(); 