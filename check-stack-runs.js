// Check detailed stack runs to see where Gmail search is failing
const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

async function checkStackRuns() {
  try {
    console.log('🔍 Analyzing stack runs for latest task...');
    
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
    console.log(`\n📝 Analyzing stack runs for task ${latestTaskId}:`);
    
    // Get all stack runs for this task
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
      console.log('❌ No stack runs found for this task');
      return;
    }

    console.log(`\n🔧 Found ${stackRuns.data.length} stack runs:`);
    console.log('=================================');
    
    let domainListCalls = 0;
    let userListCalls = 0;
    let gmailMessageListCalls = 0;
    let gmailMessageGetCalls = 0;
    let failedCalls = 0;
    
    for (const stackRun of stackRuns.data) {
      const apiCall = `${stackRun.service_name}.${stackRun.method_name}`;
      const status = stackRun.status;
      const statusIcon = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏳';
      
      console.log(`${statusIcon} ${apiCall} (${status})`);
      
      if (stackRun.input_data) {
        try {
          const input = JSON.parse(stackRun.input_data);
          if (input.length > 0 && input[0]) {
            const params = input[0];
            if (params.customer) {
              console.log(`   📋 Customer: ${params.customer}`);
            }
            if (params.domain) {
              console.log(`   🏢 Domain: ${params.domain}`);
            }
            if (params.userId) {
              console.log(`   👤 User: ${params.userId}`);
            }
            if (params.q) {
              console.log(`   🔍 Query: ${params.q}`);
            }
            if (params.id) {
              console.log(`   📧 Message ID: ${params.id}`);
            }
          }
        } catch (e) {
          // Ignore JSON parse errors
        }
      }
      
      if (stackRun.error_message) {
        console.log(`   ❌ Error: ${stackRun.error_message}`);
      }
      
      if (stackRun.result_data) {
        const resultPreview = stackRun.result_data.substring(0, 100);
        console.log(`   📤 Result: ${resultPreview}...`);
      }
      
      console.log(`   ⏰ ${stackRun.created_at} → ${stackRun.updated_at || 'pending'}`);
      console.log('');
      
      // Count API call types
      if (apiCall.includes('admin.domains.list')) domainListCalls++;
      else if (apiCall.includes('admin.users.list')) userListCalls++;
      else if (apiCall.includes('gmail.users.messages.list')) gmailMessageListCalls++;
      else if (apiCall.includes('gmail.users.messages.get')) gmailMessageGetCalls++;
      
      if (status === 'failed') failedCalls++;
    }
    
    console.log('📊 EXECUTION SUMMARY:');
    console.log('====================');
    console.log(`🏢 Domain discovery calls: ${domainListCalls}`);
    console.log(`👥 User enumeration calls: ${userListCalls}`);
    console.log(`📧 Gmail message list calls: ${gmailMessageListCalls}`);
    console.log(`📄 Gmail message detail calls: ${gmailMessageGetCalls}`);
    console.log(`❌ Failed calls: ${failedCalls}`);
    
    console.log('\n🔍 WORKFLOW ANALYSIS:');
    console.log('=====================');
    
    if (domainListCalls === 0) {
      console.log('❌ CRITICAL: No domain discovery attempted');
    } else if (domainListCalls > 0) {
      console.log('✅ Domain discovery executed');
    }
    
    if (userListCalls === 0) {
      console.log('❌ CRITICAL: No user enumeration attempted');
    } else if (userListCalls > 0) {
      console.log('✅ User enumeration executed');
    }
    
    if (gmailMessageListCalls === 0) {
      console.log('❌ CRITICAL: No Gmail message search attempted - THIS IS THE PROBLEM!');
    } else if (gmailMessageListCalls > 0) {
      console.log('✅ Gmail message search executed');
    }
    
    if (gmailMessageGetCalls === 0) {
      console.log('❌ CRITICAL: No Gmail message details retrieved');
    } else if (gmailMessageGetCalls > 0) {
      console.log('✅ Gmail message details retrieved');
    }
    
    if (gmailMessageListCalls === 0) {
      console.log('\n🚨 ROOT CAUSE: Task is stopping after user enumeration and not proceeding to Gmail search phase!');
    }
    
  } catch (error) {
    console.error('❌ Error checking stack runs:', error.message);
  }
}

checkStackRuns();
