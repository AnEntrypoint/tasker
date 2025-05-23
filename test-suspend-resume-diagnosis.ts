// Test script to diagnose GAPI suspend/resume issues
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

async function diagnoseSuspendResume() {
  console.log('Starting suspend/resume diagnosis test');
  
  try {
    console.log('FINDING ISSUE: QuickJS is returning direct Google API response');
    console.log('instead of the expected task result structure with checkpoints.');
    console.log('\nPossible causes:');
    console.log('1. The VM state is not properly preserved during suspend/resume');
    console.log('2. The task result is being overwritten with the API response');
    console.log('3. The QuickJS executor is not properly handling promise resolution');
    
    console.log('\nLet\'s check the task runs table to see what\'s being stored...');
    
    // Create a Supabase client to directly query the database
    const SUPABASE_URL = "http://127.0.0.1:8000";
    const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY || "";
    
    if (!SUPABASE_ANON_KEY) {
      throw new Error('SUPABASE_ANON_KEY is not defined in environment variables');
    }
    
    // Call the test-gapi-domains-service task and get the result
    console.log('\nExecuting test-gapi-domains-service task...');
    
    const response = await fetch("http://127.0.0.1:8000/functions/v1/tasks/execute", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        taskName: "test-gapi-domains-service",
        taskInput: {
          verbose: true,
          maxUsersPerDomain: 10
        }
      })
    });
    
    const responseData = await response.json();
    console.log(`Response status: ${response.status}`);
    
    // Extract task run ID from response
    const taskRunId = responseData.taskRunId;
    if (!taskRunId) {
      throw new Error('No task run ID in response');
    }
    
    console.log(`Task execution started with task run ID: ${taskRunId}`);
    console.log('Waiting for task to complete...');
    
    // Poll until the task completes
    let taskCompleted = false;
    let statusData = null;
    let pollCount = 0;
    
    while (!taskCompleted && pollCount < 30) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      pollCount++;
      
      const statusResponse = await fetch(`http://127.0.0.1:8000/functions/v1/tasks/status?id=${taskRunId}`, {
        headers: { 'apikey': SUPABASE_ANON_KEY }
      });
      
      if (!statusResponse.ok) {
        console.error(`Error checking task status: ${statusResponse.status}`);
        continue;
      }
      
      statusData = await statusResponse.json();
      console.log(`Poll #${pollCount} - Task status: ${statusData.status}`);
      
      if (statusData.status === 'completed' || statusData.status === 'failed') {
        taskCompleted = true;
        console.log(`Task completed ${statusData.status === 'completed' ? 'successfully' : 'with errors'}!`);
      }
    }
    
    if (!taskCompleted) {
      throw new Error('Task did not complete within the polling time limit');
    }
    
    // Check the task result
    console.log('\nExamining the task result...');
    
    if (statusData?.result) {
      const resultType = typeof statusData.result;
      console.log(`Result type: ${resultType}`);
      
      if (resultType === 'object') {
        console.log('Result keys:', Object.keys(statusData.result));
        
        // Check if it's a direct Google API response
        if (statusData.result.kind && statusData.result.kind.includes('directory#domains')) {
          console.log('\nDIAGNOSIS: The result is a direct Google API response.');
          console.log('This confirms that the suspend/resume mechanism is not preserving the task state.');
          console.log('When the VM resumes, it\'s returning the direct API response instead of continuing execution.');
          
          console.log('\nRECOMMENDATION:');
          console.log('1. Check the __callHostTool__ implementation in QuickJS.');
          console.log('2. Ensure the VM state is properly saved before suspension.');
          console.log('3. Verify that promise resolution is correctly handled after resumption.');
        } else if (statusData.result.checkpoints) {
          console.log('\nGood news! The result contains checkpoints, which means the task state was preserved.');
          console.log('Checkpoints:', statusData.result.checkpoints);
        }
      }
    } else {
      console.log('No result found in the task response');
    }
    
    console.log('\nDiagnosis complete.');
  } catch (error) {
    console.error('Error during diagnosis:', error);
  }
}

// Run the diagnosis
diagnoseSuspendResume(); 