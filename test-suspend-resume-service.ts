// Test for GAPI domains using suspend-resume mechanism
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

async function testGapiDomainsSuspendResume() {
  // Add delay to let the server start - increased to 10 seconds as requested
  console.log('Waiting for server to start...');
  await new Promise(resolve => setTimeout(resolve, 10000));
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
        taskInput: {
          verbose: true, // Set to true to get more detailed logging
          maxUsersPerDomain: 10 // Request more users per domain
        }
      })
    });

    const responseData = await response.json();
    console.log(`Response status: ${response.status}`);
    console.log(`Raw response: ${JSON.stringify(responseData, null, 2)}`);

    // Extract task run ID from response
    const taskRunId = responseData.taskRunId;
    if (!taskRunId) {
      throw new Error('No task run ID in response');
    }

    console.log(`Task execution started with task run ID: ${taskRunId}`);
    console.log('Waiting for task to complete...');

    // Poll the task status endpoint until the task completes
    let taskCompleted = false;
    let taskResult = null;
    let statusData = null;
    let pollCount = 0;
    const maxPolls = 30; // Set a maximum number of polls (150 seconds total)
    
    while (!taskCompleted && pollCount < maxPolls) {
      // Wait 5 seconds between polls
      await new Promise(resolve => setTimeout(resolve, 5000));
      pollCount++;

      // Check task status
      const statusResponse = await fetch(`http://127.0.0.1:8000/functions/v1/tasks/status?id=${taskRunId}`, {
        headers: {
          'apikey': env.SUPABASE_ANON_KEY || 'your-anon-key'
        }
      });

      if (!statusResponse.ok) {
        console.error(`Error checking task status: ${statusResponse.status}`);
        continue;
      }

      statusData = await statusResponse.json();
      console.log(`\nPoll #${pollCount} - Task status: ${statusData.status}`);

      if (statusData.status === 'completed' || statusData.status === 'failed') {
        taskCompleted = true;
        taskResult = statusData.result;
        console.log(`\nTask completed ${statusData.status === 'completed' ? 'successfully' : 'with errors'}!`);
        
        // If failed, show the error
        if (statusData.status === 'failed' && statusData.error) {
          console.error(`Error: ${statusData.error}`);
        }
      }
    }

    if (!taskCompleted) {
      throw new Error(`Task did not complete after ${maxPolls} polls (${maxPolls * 5} seconds)`);
    }

    // Log the entire status response and task result for debugging
    console.log('\nFull status response:');
    console.log(JSON.stringify(statusData, null, 2));
    
    console.log('\nRaw task result:');
    console.log(JSON.stringify(taskResult, null, 2));

    // Handle case where the result is a direct Google API response
    if (taskResult && taskResult.kind && taskResult.kind.includes('directory#domains') && taskResult.domains) {
      console.log('\nDetected direct Google API response as the result.');
      console.log('Processing domains from Google API response...');
      
      // Convert the direct API response to our expected format
      const domains = taskResult.domains.map((domain: any) => ({
        domainName: domain.domainName,
        verified: domain.verified,
        isPrimary: domain.isPrimary,
        users: []
      }));
      
      // Display domains information
      console.log('\nDomains retrieved:');
      console.log('=================');
      domains.forEach((domain: any, index: number) => {
        console.log(`${index + 1}. ${domain.domainName} (Primary: ${domain.isPrimary ? 'Yes' : 'No'}, Verified: ${domain.verified ? 'Yes' : 'No'})`);
      });
      
      console.log(`\nTotal domains: ${domains.length}`);
      
      // Final status report for direct API response
      console.log('\n✅ The GAPI domains functionality is working!');
      console.log(`Successfully retrieved ${domains.length} domains directly from the API`);
      console.log('\n⚠️ NOTE: The task returned the direct API response instead of our task result structure.');
      console.log('This indicates that the suspend/resume mechanism is not fully working as expected.');
      console.log('The task is executing, but our task result structure with checkpoints is not being returned.');
      
      return;
    }

    // Display domain information from the result
    if (taskResult && taskResult.domains) {
      console.log('\nDomains retrieved:');
      console.log('=================');
      taskResult.domains.forEach((domain: any, index: number) => {
        console.log(`${index + 1}. ${domain.domainName} (Primary: ${domain.isPrimary ? 'Yes' : 'No'}, Verified: ${domain.verified ? 'Yes' : 'No'})`);
        
        // Show users if available
        if (domain.users && domain.users.length > 0) {
          console.log(`   Users for ${domain.domainName}:`);
          console.log(`   ----------------------------`);
          domain.users.forEach((user: any, userIndex: number) => {
            console.log(`   - ${userIndex + 1}. ${user.email} (${user.name}) ${user.isAdmin ? '[Admin]' : ''} ${user.suspended ? '[Suspended]' : ''}`);
          });
          console.log(`   Total users for domain: ${domain.userCount}`);
        } else if (domain.userCount === 0) {
          console.log(`   No users found for this domain`);
        }
      });
      console.log(`\nTotal domains: ${taskResult.domainCount || taskResult.domains.length}`);
      
      // Show total user count if available
      if (taskResult.totalUserCount !== undefined) {
        console.log(`Total users: ${taskResult.totalUserCount}`);
      }
    } else if (taskResult && taskResult.error) {
      console.error(`\nTask completed with error: ${taskResult.error}`);
      if (taskResult.stack) {
        console.error(`Stack trace: ${taskResult.stack}`);
      }
    } else {
      console.error('\nNo domains found in result or unexpected result format');
    }

    // Extract and display checkpoints, checking various possible locations
    let checkpoints = null;
    
    // Try multiple possible locations for checkpoints
    if (taskResult?.checkpoints) {
      checkpoints = taskResult.checkpoints;
    } else if (taskResult?.result?.checkpoints) {
      checkpoints = taskResult.result.checkpoints;
    } else if (taskResult?.debug?.checkpoints) {
      checkpoints = taskResult.debug.checkpoints;
    }
    
    if (checkpoints && Array.isArray(checkpoints) && checkpoints.length > 0) {
      console.log('\nSuspension/Resumption Checkpoints:');
      console.log('================================');
      checkpoints.forEach((checkpoint: any, index: number) => {
        console.log(`${index + 1}. ${checkpoint.step} at ${checkpoint.timestamp}`);
        if (checkpoint.serviceResult !== undefined) {
          console.log(`   Service result received: ${checkpoint.serviceResult ? 'Yes' : 'No'}`);
        }
        if (checkpoint.error) {
          console.log(`   Error: ${checkpoint.error}`);
        }
      });
      
      // Show elapsed time if possible
      if (checkpoints.length >= 2) {
        const start = new Date(checkpoints[0].timestamp).getTime();
        const end = new Date(checkpoints[checkpoints.length - 1].timestamp).getTime();
        const elapsedSeconds = ((end - start) / 1000).toFixed(2);
        console.log(`\nTotal execution time: ${elapsedSeconds} seconds`);
      }
    } else if (taskResult?.timestamps) {
      // If we have timestamps but no checkpoints
      console.log('\nTask Timing Information:');
      console.log('=======================');
      console.log(`Start: ${taskResult.timestamps.start}`);
      console.log(`End: ${taskResult.timestamps.end}`);
      console.log(`Elapsed: ${taskResult.timestamps.elapsed / 1000} seconds`);
    } else {
      console.log('\nNo checkpoints or timing information found in the result.');
      
      // Try to extract them from deep nested objects
      const findCheckpoints = (obj: any, path = ''): any => {
        if (!obj || typeof obj !== 'object') return null;
        
        // Check if current object has a checkpoints array
        if (Array.isArray(obj.checkpoints) && obj.checkpoints.length > 0) {
          console.log(`Found checkpoints at path: ${path}.checkpoints`);
          return obj.checkpoints;
        }
        
        // Search in nested properties
        for (const key in obj) {
          if (typeof obj[key] === 'object' && obj[key] !== null) {
            const found = findCheckpoints(obj[key], `${path}.${key}`);
            if (found) return found;
          }
        }
        
        return null;
      };
      
      const deepCheckpoints = findCheckpoints(taskResult);
      if (deepCheckpoints) {
        console.log('\nFound deeply nested checkpoints:');
        console.log(JSON.stringify(deepCheckpoints, null, 2));
      }
    }

    // Show debug information if available
    if (taskResult && taskResult.debug) {
      console.log('\nDebug Information:');
      console.log('=================');
      
      if (taskResult.debug.taskVersion) {
        console.log(`Task version: ${taskResult.debug.taskVersion}`);
      }
      
      if (taskResult.debug.includeUsers !== undefined) {
        console.log(`includeUsers setting: ${taskResult.debug.includeUsers}`);
      }
      
      if (taskResult.debug.maxUsersPerDomain !== undefined) {
        console.log(`maxUsersPerDomain setting: ${taskResult.debug.maxUsersPerDomain}`);
      }
      
      // Display domainsResult info if available
      if (taskResult.debug.domainsResult) {
        console.log('\nDomains API result info:');
        const domainsInfo = taskResult.debug.domainsResult;
        console.log(`  Found ${domainsInfo.count || (domainsInfo.domains?.length || 0)} domains in API response`);
      }
      
      // Display usersResult info if available
      if (taskResult.debug.usersResult) {
        console.log('\nUsers API result info:');
        const usersInfo = taskResult.debug.usersResult;
        console.log(`  Found ${usersInfo.count || (usersInfo.users?.length || 0)} users in API response`);
      }
    }

    // Final status report
    if (taskResult && taskResult.domains && taskResult.domains.length > 0) {
      console.log('\n✅ The GAPI domains suspend/resume functionality is working properly!');
      console.log(`Successfully retrieved ${taskResult.domains.length} domains`);
      
      // Check if users were retrieved for the first domain
      const firstDomain = taskResult.domains[0];
      if (firstDomain.users && firstDomain.users.length > 0) {
        console.log(`✅ The GAPI users suspend/resume functionality is working properly!`);
        console.log(`Successfully retrieved ${firstDomain.users.length} users for ${firstDomain.domainName}`);
      } else {
        console.log(`❌ Failed to retrieve users for ${firstDomain.domainName}`);
        
        // Additional debugging for user retrieval issue
        if (taskResult.userError) {
          console.log(`User retrieval error: ${taskResult.userError}`);
        } else if (firstDomain.userError) {
          console.log(`User retrieval error: ${firstDomain.userError}`);
        }
      }
    } else {
      console.log('\n❌ The GAPI domains suspend/resume functionality is NOT working properly!');
      console.log('No domains were retrieved.');
    }
  } catch (error) {
    console.error('Error in test:', error);
  }
}

// Run the test
testGapiDomainsSuspendResume(); 