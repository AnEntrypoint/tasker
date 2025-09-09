// Check actual task execution results
const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

async function checkTaskResults() {
  try {
    console.log('🔍 Checking task execution results...');
    
    // Check recent task runs
    const taskRunsResponse = await fetch(`${SUPABASE_URL}/functions/v1/wrappedsupabase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        chain: [
          { property: "from", args: ["task_runs"] },
          { property: "select", args: ["*"] },
          { property: "order", args: ["created_at", { ascending: false }] },
          { property: "limit", args: [5] }
        ]
      })
    });

    if (!taskRunsResponse.ok) {
      console.error('❌ Failed to fetch task runs:', taskRunsResponse.status);
      return;
    }

    const taskRuns = await taskRunsResponse.json();
    console.log('📋 Recent Task Runs:');
    
    if (!taskRuns.data || taskRuns.data.length === 0) {
      console.log('   No task runs found');
      return;
    }

    for (const taskRun of taskRuns.data) {
      console.log(`\n📝 Task Run ${taskRun.id}:`);
      console.log(`   Name: ${taskRun.task_name}`);
      console.log(`   Status: ${taskRun.status}`);
      console.log(`   Created: ${taskRun.created_at}`);
      console.log(`   Updated: ${taskRun.updated_at}`);
      
      if (taskRun.ended_at) {
        console.log(`   Ended: ${taskRun.ended_at}`);
      }
      
      if (taskRun.error) {
        console.log(`   ❌ Error: ${JSON.stringify(taskRun.error)}`);
      }
      
      if (taskRun.result) {
        console.log(`   ✅ Result Preview: ${JSON.stringify(taskRun.result).substring(0, 200)}...`);
        
        // Check if result has the expected structure
        if (taskRun.result.summary) {
          console.log(`   📊 Summary:`);
          console.log(`      Domains: ${taskRun.result.summary.totalDomains || 0}`);
          console.log(`      Users: ${taskRun.result.summary.totalUsers || 0}`);
          console.log(`      Messages: ${taskRun.result.summary.totalMessagesFound || 0}`);
        }
        
        if (taskRun.result.domainResults && taskRun.result.domainResults.length > 0) {
          console.log(`   🏢 Domain Results: ${taskRun.result.domainResults.length} domains`);
          for (const domain of taskRun.result.domainResults.slice(0, 2)) {
            console.log(`      - ${domain.domain}: ${domain.users?.length || 0} users, ${domain.totalMessages || 0} messages`);
          }
        }
        
        if (taskRun.result.sampleMessages && taskRun.result.sampleMessages.length > 0) {
          console.log(`   📧 Sample Messages: ${taskRun.result.sampleMessages.length} messages`);
          for (const msg of taskRun.result.sampleMessages.slice(0, 2)) {
            console.log(`      - From: ${msg.from || 'Unknown'}`);
            console.log(`        Subject: ${msg.subject || 'No subject'}`);
          }
        }
      }
    }
    
    // Check stack runs for the most recent task
    if (taskRuns.data.length > 0) {
      const latestTask = taskRuns.data[0];
      console.log(`\n🔧 Checking stack runs for task ${latestTask.id}...`);
      
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
            { property: "eq", args: ["parent_task_run_id", latestTask.id] },
            { property: "order", args: ["created_at", { ascending: false }] },
            { property: "limit", args: [10] }
          ]
        })
      });

      if (stackRunsResponse.ok) {
        const stackRuns = await stackRunsResponse.json();
        if (stackRuns.data && stackRuns.data.length > 0) {
          console.log(`   Found ${stackRuns.data.length} stack runs:`);
          for (const stackRun of stackRuns.data.slice(0, 5)) {
            console.log(`   - ${stackRun.service_name}.${stackRun.method_name}: ${stackRun.status}`);
            if (stackRun.error_message) {
              console.log(`     Error: ${stackRun.error_message}`);
            }
          }
        } else {
          console.log('   No stack runs found for this task');
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Error checking task results:', error.message);
  }
}

checkTaskResults();
