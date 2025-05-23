// Simple test for the minimal suspend-resume task
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

async function testMinimalSuspendResume() {
  console.log('Testing minimal suspend-resume task');
  
  try {
    console.log('Sending request to execute minimal suspend-resume task...');
    
    const response = await fetch("http://127.0.0.1:8000/functions/v1/quickjs", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
      },
      body: JSON.stringify({
        taskName: "test-suspend-resume-minimal",
        taskInput: {
          query: "deno QuickJS suspend resume test",
          limit: 2
        },
        directExecution: true
      })
    });
    
    if (!response.ok) {
      throw new Error(`Error executing task: ${response.status} ${response.statusText}`);
    }
    
    const result = await response.json();
    console.log("Response status:", response.status);
    console.log("Response result:", JSON.stringify(result, null, 2));
    
    // Check if the execution was suspended
    if (result.status === 'suspended') {
      console.log(`Task execution suspended, stack run ID: ${result.stackRunId}`);
      
      // Poll the stack run until completion
      let completed = false;
      let attempts = 0;
      const maxAttempts = 10;
      
      while (!completed && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;
        
        console.log(`Checking stack run status (attempt ${attempts})...`);
        
        const statusResponse = await fetch(`http://127.0.0.1:8000/functions/v1/tasks/status?id=${result.stackRunId}`, {
          headers: {
            'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
          }
        });
        
        if (!statusResponse.ok) {
          console.error(`Error checking stack run status: ${statusResponse.status}`);
          continue;
        }
        
        const statusData = await statusResponse.json();
        console.log(`Stack run status: ${statusData.status}`);
        
        if (statusData.status === 'completed' || statusData.status === 'failed') {
          completed = true;
          console.log("Final result:", JSON.stringify(statusData.result, null, 2));
          
          // Check if checkpoints are present
          if (statusData.result?.checkpoints) {
            const checkpoints = statusData.result.checkpoints;
            console.log("\nCheckpoints:");
            checkpoints.forEach((cp: any, i: number) => {
              console.log(`${i+1}. ${cp.step} at ${cp.timestamp}`);
            });
            
            // Verify that we have all expected checkpoints
            const expectedSteps = ["start", "resumed", "complete"];
            const hasAllSteps = expectedSteps.every(step => 
              checkpoints.some((cp: any) => cp.step === step)
            );
            
            if (hasAllSteps) {
              console.log("\n✅ PASS: All expected checkpoints are present");
            } else {
              console.log("\n❌ FAIL: Some checkpoints are missing");
            }
          } else {
            console.log("\n❌ FAIL: No checkpoints in result");
          }
        }
      }
      
      if (!completed) {
        console.log("❌ FAIL: Stack run did not complete within the timeout period");
      }
    } else if (result.status === 'completed') {
      // Direct completion
      console.log("Task completed directly");
      
      // Check if checkpoints are present
      if (result.result?.checkpoints) {
        const checkpoints = result.result.checkpoints;
        console.log("\nCheckpoints:");
        checkpoints.forEach((cp: any, i: number) => {
          console.log(`${i+1}. ${cp.step} at ${cp.timestamp}`);
        });
        
        // Verify that we have all expected checkpoints
        const expectedSteps = ["start", "resumed", "complete"];
        const hasAllSteps = expectedSteps.every(step => 
          checkpoints.some((cp: any) => cp.step === step)
        );
        
        if (hasAllSteps) {
          console.log("\n✅ PASS: All expected checkpoints are present");
        } else {
          console.log("\n❌ FAIL: Some checkpoints are missing");
        }
      } else {
        console.log("\n❌ FAIL: No checkpoints in result");
      }
    } else {
      console.log("❌ FAIL: Unexpected response status:", result.status);
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run the test
testMinimalSuspendResume(); 