// Test for GAPI domains using suspend-resume mechanism
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

async function testGapiDomainsSuspendResume() {
  // Add delay to let the server start
  await new Promise(resolve => setTimeout(resolve, 3000));
  console.log('Testing GAPI domains list via suspend-resume mechanism');
  
  try {
    console.log('Sending request to tasks/execute endpoint...');

    // Execute our GAPI domains task via the tasks/execute endpoint
    const response = await fetch("http://127.0.0.1:8000/functions/v1/tasks/execute", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
      },
      body: JSON.stringify({
        taskName: "test-gapi-domains-service",
        taskInput: { verbose: true }
      })
    });
    
    console.log(`Response status: ${response.status}`);
    const rawResponse = await response.text();
    console.log(`Raw response: ${rawResponse}`);
    
    const responseData = JSON.parse(rawResponse);
    console.log('Parsed response:', responseData);
    
    // Extract task run ID
    const taskRunId = responseData.taskRunId;
    console.log(`Task execution started with task run ID: ${taskRunId}`);
    
    if (!taskRunId) {
      throw new Error("No task run ID received");
    }

    console.log("Waiting for task to complete...");
    
    // Poll for result
    let taskCompleted = false;
    let taskResult = null;
    
    while (!taskCompleted) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds between polls
      
      const statusResponse = await fetch(`http://127.0.0.1:8000/functions/v1/tasks/status?id=${taskRunId}`, {
        headers: { 'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key' }
      });
      
      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        
        if (statusData.status === 'completed' || statusData.status === 'failed') {
          taskCompleted = true;
          taskResult = statusData;
          console.log("\nTask result:", statusData.status);
          
          if (statusData.status === 'completed' && statusData.result) {
            console.log("\nTask completed successfully!");
            
            // Display the domains list
            if (statusData.result.domains) {
              console.log("\nDomains retrieved:");
              console.log("----------------");
              statusData.result.domains.forEach((domain: any, index: number) => {
                console.log(`${index + 1}. ${domain.domainName} (Primary: ${domain.isPrimary ? 'Yes' : 'No'}, Verified: ${domain.verified ? 'Yes' : 'No'})`);
              });
              console.log(`\nTotal domains: ${statusData.result.domainCount || statusData.result.domains.length}`);
            } else {
              console.log("\nNo domains found in result");
            }
            
            // Display checkpoints to verify suspension and resumption happened
            if (statusData.result?.checkpoints) {
              console.log("\nCheckpoints showing suspension and resumption:");
              statusData.result.checkpoints.forEach((checkpoint: any, index: number) => {
                console.log(`  ${index + 1}. ${checkpoint.step}: ${checkpoint.timestamp}${
                  checkpoint.serviceResult !== undefined ? ` (service result successful: ${checkpoint.serviceResult})` : ''
                }${
                  checkpoint.error ? ` (error: ${checkpoint.error})` : ''
                }`);
              });
              
              // Calculate suspension duration if we have timestamps
              const timestamps = statusData.result.checkpoints.map((c: any) => new Date(c.timestamp).getTime());
              if (timestamps.length >= 2) {
                const suspensionDuration = timestamps[1] - timestamps[0];
                console.log(`\nSuspension duration: ${suspensionDuration}ms`);
              }
            } else {
              console.log("\nNo checkpoints found in result, suspension/resumption data unavailable");
            }
          } else {
            console.log("\nTask failed!");
            console.log(JSON.stringify(statusData.error, null, 2));
          }
        } else {
          console.log(`Task status: ${statusData.status} - continuing to poll...`);
        }
      } else {
        console.log(`Error checking status: ${statusResponse.status}`)