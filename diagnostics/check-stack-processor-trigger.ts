/**
 * Check Stack Processor Trigger
 * 
 * This tool tests if the database trigger for stack_runs is working properly
 * by inserting a test record and monitoring if it gets processed.
 */
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

// Configuration
const POLL_INTERVAL = 1000; // ms
const MAX_POLL_ATTEMPTS = 15;

async function testStackProcessorTrigger() {
  console.log("=== Stack Processor Trigger Test ===\n");
  const stackRunId = crypto.randomUUID();
  
  try {
    // 1. Insert a test record directly into the stack_runs table
    console.log(`Step 1: Inserting test stack run with ID: ${stackRunId}`);
    
    const insertResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedsupabase", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
      },
      body: JSON.stringify({
        chain: [
          { type: "call", property: "from", args: ["stack_runs"] },
          { type: "call", property: "insert", args: [{
            id: stackRunId,
            service_name: "test_service",
            method_name: "echo",
            args: ["trigger_test"],
            status: "pending",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }] }
        ]
      })
    });
    
    if (!insertResponse.ok) {
      const errorText = await insertResponse.text();
      console.error("Failed to insert test record:", errorText);
      
      // Check if the table exists
      console.log("\nChecking if stack_runs table exists...");
      const tablesResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedsupabase", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
        },
        body: JSON.stringify({
          chain: [
            { type: "call", property: "rpc", args: ["list_tables", {}] }
          ]
        })
      });
      
      if (tablesResponse.ok) {
        const tablesResult = await tablesResponse.json();
        console.log("Available tables:", tablesResult.data);
      }
      
      throw new Error(`Insert failed with status ${insertResponse.status}`);
    }
    
    const insertResult = await insertResponse.json();
    console.log("Insert result:", insertResult);
    
    // 2. Poll the stack_runs table to see if the status changes
    console.log("\nStep 2: Monitoring stack run status for changes...");
    
    let pollCount = 0;
    let lastStatus = "pending";
    let statusChangeTimes = [];
    let processed = false;
    
    while (pollCount < MAX_POLL_ATTEMPTS) {
      pollCount++;
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
      
      console.log(`\nPoll attempt ${pollCount}/${MAX_POLL_ATTEMPTS}...`);
      
      const statusResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedsupabase", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
        },
        body: JSON.stringify({
          chain: [
            { type: "call", property: "from", args: ["stack_runs"] },
            { type: "call", property: "select", args: ["*"] },
            { type: "call", property: "eq", args: ["id", stackRunId] }
          ]
        })
      });
      
      if (!statusResponse.ok) {
        console.error(`Error checking status: ${statusResponse.status}`);
        continue;
      }
      
      const statusResult = await statusResponse.json();
      
      if (!statusResult.data || statusResult.data.length === 0) {
        console.log("No data found for stack run ID");
        continue;
      }
      
      const stackRun = statusResult.data[0];
      const currentTime = new Date().toISOString();
      
      console.log(`  Current status: ${stackRun.status}`);
      
      // Track status changes
      if (lastStatus !== stackRun.status) {
        const changeInfo = {
          from: lastStatus,
          to: stackRun.status,
          time: currentTime
        };
        statusChangeTimes.push(changeInfo);
        console.log(`  Status changed from ${lastStatus} to ${stackRun.status}`);
        lastStatus = stackRun.status;
      }
      
      // If the status is not "pending" anymore, we know the trigger ran
      if (stackRun.status !== "pending") {
        processed = true;
        console.log("\nStack run was processed by the trigger!");
        break;
      }
    }
    
    // 3. Check for direct trigger invocation in logs
    console.log("\nStep 3: Analysis");
    
    if (processed) {
      console.log("✅ Stack processor trigger appears to be working");
      console.log("The test record was picked up and its status was changed");
    } else {
      console.log("❌ Stack processor trigger appears to be NOT working");
      console.log("The test record remained in 'pending' status");
      
      console.log("\nPossible issues:");
      console.log("1. The trigger is not properly installed on the stack_runs table");
      console.log("2. The stack-processor function is not responding to trigger events");
      console.log("3. Database permissions are preventing the trigger from functioning");
      
      console.log("\nTrying direct invocation of stack processor...");
      
      const directResponse = await fetch("http://127.0.0.1:8000/functions/v1/stack-processor", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
        },
        body: JSON.stringify({
          action: "process"
        })
      });
      
      if (directResponse.ok) {
        const directResult = await directResponse.json();
        console.log("Direct invocation result:", directResult);
      } else {
        console.error(`Direct invocation failed: ${directResponse.status}`);
      }
    }
    
    // 4. Display status change timeline
    if (statusChangeTimes.length > 0) {
      console.log("\nStatus change timeline:");
      statusChangeTimes.forEach((change, index) => {
        console.log(`${index+1}. ${change.from} → ${change.to} at ${change.time}`);
        
        if (index > 0) {
          const prevTime = new Date(statusChangeTimes[index-1].time).getTime();
          const currTime = new Date(change.time).getTime();
          const duration = (currTime - prevTime) / 1000;
          console.log(`   Duration in ${statusChangeTimes[index-1].to} state: ${duration.toFixed(2)} seconds`);
        }
      });
    }
    
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : String(error));
  }
}

// Run the test immediately
testStackProcessorTrigger(); 