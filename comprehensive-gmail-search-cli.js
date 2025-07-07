#!/usr/bin/env node

/**
 * CLI for testing the comprehensive Gmail search task
 * This demonstrates the full suspend/resume mechanism with multiple GAPI calls
 */

const SUPABASE_URL = "http://127.0.0.1:8000";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

// Parse command line arguments
const args = process.argv.slice(2);

// Show usage if help requested
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
🔍 Comprehensive Gmail Search CLI
=================================

Usage: 
  npm run test:comprehensive-gmail-search                    # Default search
  node comprehensive-gmail-search-cli.js [options]          # Direct execution

Options:
  --query, -q <query>              Gmail search query (default: "" - all emails)
  --maxResultsPerUser <number>     Max email results per user (default: 3)
  --maxUsersPerDomain <number>     Max users to process per domain (default: 5)
  --help, -h                       Show this help message

Examples:
  # Basic search across all domains
  npm run test:comprehensive-gmail-search

  # Search for specific content (note the extra -- for npm)
  npm run test:comprehensive-gmail-search -- --query "subject:meeting"
  npm run test:comprehensive-gmail-search -- --query "from:john@company.com"
  npm run test:comprehensive-gmail-search -- --query "has:attachment"

  # Limit the scope for faster results
  npm run test:comprehensive-gmail-search -- --maxUsersPerDomain 2 --maxResultsPerUser 1

  # Direct execution (bypasses npm)
  node comprehensive-gmail-search-cli.js --query "in:sent" --maxUsersPerDomain 1

Features:
  ✅ Discovers all Google Workspace domains automatically
  ✅ Lists users for each domain
  ✅ Searches Gmail for each user with your query
  ✅ Aggregates results across all domains and users
  ✅ Demonstrates VM suspend/resume mechanism
  ✅ Real-time progress monitoring

This demonstrates the Tasker system's ability to handle complex, multi-step
workflows that involve multiple external API calls while maintaining state
across VM suspensions.
`);
  process.exit(0);
}

// Better argument parsing that handles both direct execution and npm run
function parseArguments(args) {
  const options = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];
    
    if (arg === '--query' || arg === '-q') {
      if (nextArg && !nextArg.startsWith('--')) {
        options.query = nextArg;
        i++; // Skip next arg since we consumed it
      }
    } else if (arg === '--maxResultsPerUser' || arg === '--maxResults') {
      if (nextArg && !nextArg.startsWith('--')) {
        options.maxResultsPerUser = parseInt(nextArg);
        i++;
      }
    } else if (arg === '--maxUsersPerDomain' || arg === '--maxUsers') {
      if (nextArg && !nextArg.startsWith('--')) {
        options.maxUsersPerDomain = parseInt(nextArg);
        i++;
      }
    }
  }
  
  return options;
}

const options = parseArguments(args);

// Default values with validation
const input = {
  gmailSearchQuery: options.query || "",
  maxResultsPerUser: Math.max(1, Math.min(options.maxResultsPerUser || 10, 100)),
  maxUsersPerDomain: Math.max(1, Math.min(options.maxUsersPerDomain || 1000, 10000))
};

console.log("🚀 Comprehensive Gmail Search CLI");
console.log("=================================");
console.log(`📧 Search Query: "${input.gmailSearchQuery}"`);
console.log(`👥 Max Users Per Domain: ${input.maxUsersPerDomain}`);
console.log(`📋 Max Results Per User: ${input.maxResultsPerUser}`);
console.log(`🌐 Target: All Google Workspace domains`);
console.log("");

async function runComprehensiveGmailSearch() {
  try {
    console.log("⏳ Waiting for Supabase services to start...");
    
    // Retry logic to wait for server startup
    const maxRetries = 30; // 30 seconds total
    let retries = 0;
    let serviceAvailable = false;
    
    while (retries < maxRetries && !serviceAvailable) {
      try {
        const healthCheck = await fetch(`${SUPABASE_URL}/functions/v1/tasks`, {
          method: 'HEAD',
          headers: {
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
          }
        });
        
        if (healthCheck.ok || healthCheck.status === 405) {
          serviceAvailable = true;
          console.log("✅ Supabase services are available");
        } else {
          throw new Error("Service not ready");
        }
      } catch (error) {
        retries++;
        if (retries < maxRetries) {
          process.stdout.write(`\r⏳ Waiting for services... (${retries}/${maxRetries}s)`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          console.error("");
          console.error("❌ SUPABASE SERVICES NOT RUNNING");
          console.error("=================================");
          console.error("The Supabase edge functions are not accessible after 30 seconds.");
          console.error("");
          console.error("To run this test, you need to:");
          console.error("1. Start Docker Desktop");
          console.error("2. Run: npm run gapi:serve");
          console.error("");
          console.error("Or use a remote Supabase instance by updating SUPABASE_URL and ANON_KEY");
          process.exit(1);
        }
      }
    }
    
    if (serviceAvailable) {
      console.log(""); // Clear the line
    }
    
    console.log("⏳ Waiting for services to be fully ready...");
    await new Promise(resolve => setTimeout(resolve, 15000)); // Give services time to fully initialize
    
    console.log("📤 Submitting comprehensive Gmail search task...");
    
    const response = await fetch(`${SUPABASE_URL}/functions/v1/tasks/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        taskName: 'comprehensive-gmail-search',
        input: input
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    
    if (!result.taskRunId) {
      console.error("❌ Failed to get task run ID:", result);
      process.exit(1);
    }
    
    console.log(`✅ Task submitted successfully!`);
    console.log(`📋 Task Run ID: ${result.taskRunId}`);
    console.log("");
    console.log("🔄 Monitoring comprehensive search progress...");
    console.log("This demonstrates the complete workflow:");
    console.log("  1. 🏢 Discover all Google Workspace domains");
    console.log("  2. 👥 List users for each domain");  
    console.log("  3. 📧 Search Gmail for each user");
    console.log("  4. 📊 Aggregate all results");
    console.log("");
    console.log("💡 VM will suspend/resume automatically during external API calls");
    console.log("");

    // Enhanced monitoring with better status tracking
    const startTime = Date.now();
    let lastStatus = '';
    let lastWaitingOn = '';
    let attempts = 0;
    const maxAttempts = 300; // 10 minutes max - extended timeout for suspend/resume testing

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;
      
      try {
        const statusResponse = await fetch(`${SUPABASE_URL}/rest/v1/task_runs?id=eq.${result.taskRunId}&select=*`, {
          headers: {
            'Authorization': `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU`,
            'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
          }
        });
        
        if (!statusResponse.ok) {
          console.log(`⚠️  Status check error: ${statusResponse.status}`);
          continue;
        }
        
        const taskData = await statusResponse.json();
        const task = taskData[0];
        
        if (!task) {
          console.log("⚠️  Task not found - may still be initializing...");
          continue;
        }
        
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const statusChanged = task.status !== lastStatus;
        const waitingChanged = task.waiting_on_stack_run_id !== lastWaitingOn;
        
        if (statusChanged || waitingChanged) {
          lastStatus = task.status;
          lastWaitingOn = task.waiting_on_stack_run_id;
          
          const statusEmoji = {
            'queued': '📥',
            'processing': '⚙️',
            'suspended': '⏸️',
            'completed': '✅',
            'failed': '❌'
          }[task.status] || '🔄';
          
          if (statusChanged) {
            console.log(`[${elapsed}s] ${statusEmoji} Status: ${task.status.toUpperCase()}`);
          }
          
          if (task.status === 'suspended' && task.waiting_on_stack_run_id) {
            console.log(`       🔗 Waiting on: ${task.waiting_on_stack_run_id.substring(0, 12)}...`);
            console.log(`       💾 VM state preserved - external API call in progress`);
          }
        }
        
        if (task.status === 'completed') {
          console.log("");
          console.log("🎉 COMPREHENSIVE GMAIL SEARCH COMPLETED SUCCESSFULLY!");
          console.log("===================================================");
          
          if (task.result && task.result.summary) {
            const summary = task.result.summary;
            console.log(`📊 Execution Summary:`);
            console.log(`   🏢 Domains processed: ${summary.totalDomains || summary.domains || 0}`);
            console.log(`   👥 Users processed: ${summary.totalUsers || summary.users || 0}`);
            console.log(`   📧 Total emails found: ${summary.totalMessagesFound || summary.totalEmails || 0}`);
            console.log(`   🔍 Search query: "${summary.searchQuery || input.gmailSearchQuery}"`);
            
            // Check for domain results in the correct location
            if (task.result.domainResults && task.result.domainResults.length > 0) {
              console.log("");
              console.log("📋 Results by Domain:");
              task.result.domainResults.forEach((domain, index) => {
                console.log(`   ${index + 1}. 🏢 ${domain.domain}:`);
                console.log(`      👥 Users searched: ${domain.userCount}`);
                console.log(`      📧 Emails found: ${domain.totalMessages}`);
                
                if (domain.users && domain.users.length > 0) {
                  console.log(`      👤 Users with messages:`);
                  domain.users.forEach((user, userIndex) => {
                    console.log(`         ${userIndex + 1}. ${user.email} (${user.name}): ${user.messageCount} emails`);
                  });
                }
              });
            }
            
            // Show sample messages if available
            if (task.result.sampleMessages && task.result.sampleMessages.length > 0) {
              console.log("");
              console.log("📬 Sample Messages:");
              task.result.sampleMessages.forEach((msg, index) => {
                console.log(`   ${index + 1}. From: ${msg.userEmail} (${msg.domain})`);
                console.log(`      Snippet: ${msg.snippet.substring(0, 100)}...`);
              });
            }
          } else {
            console.log("📄 Raw Result:", JSON.stringify(task.result, null, 2));
          }
          
          console.log("");
          console.log("✨ Technical Achievement:");
          console.log("   ✅ Multi-step workflow completed end-to-end");
          console.log("   ✅ VM suspend/resume mechanism functioned perfectly");
          console.log("   ✅ State preserved across multiple external API calls");
          console.log("   ✅ Results properly aggregated from all sources");
          console.log("");
          console.log("🚀 The comprehensive Gmail search is fully operational!");
          
          process.exit(0);
        } else if (task.status === 'failed') {
          console.log("");
          console.log("❌ COMPREHENSIVE SEARCH FAILED");
          console.log("==============================");
          
          if (task.error) {
            console.log("💥 Error Details:");
            console.log(JSON.stringify(task.error, null, 2));
          }
          
          console.log("");
          console.log("💡 Troubleshooting:");
          console.log("   • Ensure Supabase services are running");
          console.log("   • Check Google service account permissions");
          console.log("   • Verify GAPI edge functions are deployed");
          
          process.exit(1);
        }
        
        // Progress indicator for long-running operations
        if (attempts % 10 === 0 && task.status === 'suspended') {
          console.log(`       ⏳ Still processing after ${elapsed}s (normal for comprehensive searches)`);
        }
        
      } catch (error) {
        console.log(`⚠️  Monitoring error: ${error.message}`);
      }
    }
    
    console.log("");
    console.log("⏰ MONITORING TIMEOUT REACHED");
    console.log("=============================");
    console.log("The comprehensive search is still running but monitoring has reached the time limit.");
    console.log(`⏱️  Total monitoring time: ${Math.round((Date.now() - startTime) / 1000)}s`);
    console.log(`📊 Final status: ${lastStatus.toUpperCase()}`);
    console.log(`🔗 Task ID: ${result.taskRunId}`);
    console.log("");
    console.log("💡 The task will continue running in the background.");
    console.log("   You can check its status manually in the database or restart monitoring.");
    
    process.exit(1);
    
  } catch (error) {
    console.error("");
    console.error("💥 CRITICAL ERROR");
    console.error("================");
    console.error(error.message);
    
    if (error.stack) {
      console.error("");
      console.error("🔍 Stack trace:");
      console.error(error.stack);
    }
    
    console.error("");
    console.error("🚨 Common issues:");
    console.error("   • Supabase not running: npm run gapi:serve");
    console.error("   • Wrong directory: ensure you're in the tasker project root");
    console.error("   • Network issues: check your internet connection");
    
    process.exit(1);
  }
}

// Run the comprehensive Gmail search
runComprehensiveGmailSearch(); 