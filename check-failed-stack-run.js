// Check the failed stack run to see what error occurred
const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

async function checkFailedStackRun() {
  try {
    console.log('🔍 Checking failed stack run details...');
    
    // Get the latest completed task
    const taskRunsResponse = await fetch(`${SUPABASE_URL}/functions/v1/wrappedsupabase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        chain: [
          { property: "from", args: ["task_runs"] },
          { property: "select", args: ["id"] },
          { property: "eq", args: ["status", "completed"] },
          { property: "order", args: ["created_at", { ascending: false }] },
          { property: "limit", args: [1] }
        ]
      })
    });

    if (!taskRunsResponse.ok) {
      console.error('❌ Failed to fetch task runs:', taskRunsResponse.status);
      return;
    }

    const taskRuns = await taskRunsResponse.json();
    
    if (!taskRuns.data || taskRuns.data.length === 0) {
      console.log('❌ No completed task runs found');
      return;
    }

    const latestTaskId = taskRuns.data[0].id;
    console.log(`\n📝 Checking failed stack runs for task ${latestTaskId}:`);
    
    // Get failed stack runs for this task
    const stackRunsResponse = await fetch(`${SUPABASE_URL}/functions/v1/wrappedsupabase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        chain: [
          { property: "from", args: ["stack_runs"] },
          { property: "select", args: ["*"] },
          { property: "eq", args: ["parent_task_run_id", latestTaskId] },
          { property: "eq", args: ["status", "failed"] },
          { property: "order", args: ["created_at", { ascending: true }] }
        ]
      })
    });

    if (!stackRunsResponse.ok) {
      console.error('❌ Failed to fetch stack runs:', stackRunsResponse.status);
      return;
    }

    const stackRuns = await stackRunsResponse.json();
    
    if (!stackRuns.data || stackRuns.data.length === 0) {
      console.log('✅ No failed stack runs found');
      return;
    }

    console.log(`\n❌ Found ${stackRuns.data.length} failed stack runs:`);
    console.log('=====================================');
    
    for (const stackRun of stackRuns.data) {
      console.log(`\n❌ Failed Stack Run ${stackRun.id}:`);
      console.log(`   Service: ${stackRun.service_name}`);
      console.log(`   Method: ${stackRun.method_name}`);
      console.log(`   Created: ${stackRun.created_at}`);
      console.log(`   Updated: ${stackRun.updated_at}`);
      
      if (stackRun.input_data) {
        console.log(`   📥 Input: ${stackRun.input_data}`);
      }
      
      if (stackRun.error_message) {
        console.log(`   🚨 Error Message: ${stackRun.error_message}`);
      }
      
      if (stackRun.result_data) {
        console.log(`   📤 Result Data: ${stackRun.result_data}`);
      }
      
      // Try to parse the error for more details
      if (stackRun.error_message) {
        try {
          const errorObj = JSON.parse(stackRun.error_message);
          console.log(`   📋 Parsed Error Details:`);
          if (errorObj.error) {
            console.log(`      Code: ${errorObj.error.code || 'Unknown'}`);
            console.log(`      Message: ${errorObj.error.message || 'Unknown'}`);
            console.log(`      Status: ${errorObj.error.status || 'Unknown'}`);
          }
        } catch (e) {
          // Error message is not JSON, just display as is
          console.log(`   📋 Error Details: ${stackRun.error_message}`);
        }
      }
    }
    
    // Also check if there are any pending stack runs that might be stuck
    console.log('\n🔍 Checking for pending stack runs...');
    
    const pendingStackRunsResponse = await fetch(`${SUPABASE_URL}/functions/v1/wrappedsupabase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        chain: [
          { property: "from", args: ["stack_runs"] },
          { property: "select", args: ["*"] },
          { property: "eq", args: ["parent_task_run_id", latestTaskId] },
          { property: "eq", args: ["status", "pending"] },
          { property: "order", args: ["created_at", { ascending: true }] }
        ]
      })
    });

    if (pendingStackRunsResponse.ok) {
      const pendingStackRuns = await pendingStackRunsResponse.json();
      
      if (pendingStackRuns.data && pendingStackRuns.data.length > 0) {
        console.log(`⏳ Found ${pendingStackRuns.data.length} pending stack runs (might be stuck):`);
        for (const stackRun of pendingStackRuns.data) {
          console.log(`   - ${stackRun.service_name}.${stackRun.method_name} (created: ${stackRun.created_at})`);
        }
      } else {
        console.log('✅ No pending stack runs found');
      }
    }
    
  } catch (error) {
    console.error('❌ Error checking failed stack runs:', error.message);
  }
}

checkFailedStackRun();
