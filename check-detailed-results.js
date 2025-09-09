// Check detailed results of the latest task
const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

async function checkDetailedResults() {
  try {
    console.log('🔍 Getting detailed results from latest task...');
    
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
          { property: "select", args: ["*"] },
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

    const latestTask = taskRuns.data[0];
    console.log(`\n📝 Latest Completed Task (ID: ${latestTask.id}):`);
    console.log(`   Name: ${latestTask.task_name}`);
    console.log(`   Status: ${latestTask.status}`);
    console.log(`   Created: ${latestTask.created_at}`);
    console.log(`   Ended: ${latestTask.ended_at}`);
    
    if (latestTask.result) {
      console.log('\n📊 FULL RESULT ANALYSIS:');
      console.log('=========================');
      
      const result = latestTask.result;
      
      // Check if this is the expected Gmail search result format
      if (result.summary) {
        console.log('✅ Found summary section:');
        console.log(`   Total Domains: ${result.summary.totalDomains || 'N/A'}`);
        console.log(`   Total Users: ${result.summary.totalUsers || 'N/A'}`);
        console.log(`   Total Messages: ${result.summary.totalMessagesFound || 'N/A'}`);
        console.log(`   Search Query: "${result.summary.searchQuery || 'N/A'}"`);
      } else {
        console.log('❌ No summary section found');
      }
      
      if (result.domainResults) {
        console.log(`\n✅ Found domainResults: ${result.domainResults.length} domains`);
        for (const domain of result.domainResults) {
          console.log(`   🏢 Domain: ${domain.domain}`);
          console.log(`      Users: ${domain.users?.length || 0}`);
          console.log(`      Total Messages: ${domain.totalMessages || 0}`);
          
          if (domain.users && domain.users.length > 0) {
            console.log(`      Sample Users:`);
            for (const user of domain.users.slice(0, 2)) {
              console.log(`        - ${user.email}: ${user.messageCount || 0} messages`);
              if (user.messages && user.messages.length > 0) {
                console.log(`          Sample message: "${user.messages[0].subject || 'No subject'}"`);
              }
            }
          }
        }
      } else {
        console.log('❌ No domainResults section found');
      }
      
      if (result.sampleMessages) {
        console.log(`\n✅ Found sampleMessages: ${result.sampleMessages.length} messages`);
        for (const msg of result.sampleMessages.slice(0, 3)) {
          console.log(`   📧 Message:`);
          console.log(`      From: ${msg.from || 'Unknown'}`);
          console.log(`      Subject: ${msg.subject || 'No subject'}`);
          console.log(`      Date: ${msg.date || 'Unknown'}`);
          console.log(`      User: ${msg.userEmail || 'Unknown'}`);
          console.log(`      Domain: ${msg.domain || 'Unknown'}`);
        }
      } else {
        console.log('❌ No sampleMessages section found');
      }
      
      if (result.executionInfo) {
        console.log(`\n✅ Found executionInfo:`);
        console.log(`   Completed At: ${result.executionInfo.completedAt || 'N/A'}`);
        console.log(`   Total API Calls: ${result.executionInfo.totalApiCalls || 'N/A'}`);
        console.log(`   Description: ${result.executionInfo.description || 'N/A'}`);
      } else {
        console.log('❌ No executionInfo section found');
      }
      
      // Check if this looks like raw API response instead of processed result
      if (result.users && !result.summary) {
        console.log('\n⚠️  WARNING: Result appears to be raw API response, not processed Gmail search result');
        console.log(`   Raw users array length: ${result.users.length}`);
        if (result.users.length > 0) {
          console.log(`   Sample user: ${result.users[0].name?.fullName || result.users[0].primaryEmail || 'Unknown'}`);
        }
      }
      
      console.log('\n📄 Full Result (first 500 chars):');
      console.log(JSON.stringify(result, null, 2).substring(0, 500) + '...');
      
    } else {
      console.log('❌ No result found in task run');
    }
    
  } catch (error) {
    console.error('❌ Error checking detailed results:', error.message);
  }
}

checkDetailedResults();
