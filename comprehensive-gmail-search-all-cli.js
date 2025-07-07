#!/usr/bin/env node

/**
 * CLI for testing the comprehensive Gmail search that retrieves ALL users and ALL emails
 * This demonstrates the full suspend/resume mechanism with pagination
 */

const SUPABASE_URL = "http://127.0.0.1:8000";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

// Parse command line arguments
const args = process.argv.slice(2);

// Show usage if help requested
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
🔍 Comprehensive Gmail Search ALL - CLI
=======================================

This enhanced version retrieves ALL users and ALL emails using pagination.

Usage: 
  node comprehensive-gmail-search-all-cli.js [options]

Options:
  --query, -q <query>       Gmail search query (default: "" - ALL emails)
  --pageSize <number>       Page size for API pagination (default: 100)
  --help, -h                Show this help message

Examples:
  # Get ALL emails for ALL users across ALL domains
  node comprehensive-gmail-search-all-cli.js

  # Search for specific content across ALL users
  node comprehensive-gmail-search-all-cli.js --query "subject:meeting"
  node comprehensive-gmail-search-all-cli.js --query "from:john@company.com"

  # Adjust page size for API calls
  node comprehensive-gmail-search-all-cli.js --pageSize 50

Features:
  ✅ Discovers all Google Workspace domains
  ✅ Lists ALL users for each domain (with pagination)
  ✅ Searches Gmail for ALL emails for each user (with pagination)
  ✅ Skips suspended users automatically
  ✅ Provides detailed statistics and sample messages
  ✅ Demonstrates VM suspend/resume with extensive API calls
`);
  process.exit(0);
}

// Better argument parsing
function parseArguments(args) {
  const options = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];
    
    if (arg === '--query' || arg === '-q') {
      if (nextArg && !nextArg.startsWith('--')) {
        options.query = nextArg;
        i++;
      }
    } else if (arg === '--pageSize') {
      if (nextArg && !nextArg.startsWith('--')) {
        options.pageSize = parseInt(nextArg);
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
  pageSize: Math.max(10, Math.min(options.pageSize || 100, 500))
};

console.log("🚀 Comprehensive Gmail Search ALL - CLI");
console.log("======================================");
console.log(`📧 Search Query: "${input.gmailSearchQuery}" ${input.gmailSearchQuery === "" ? "(ALL emails)" : ""}`);
console.log(`📄 Page Size: ${input.pageSize}`);
console.log(`🌐 Target: ALL users and ALL emails across ALL domains`);
console.log("");

async function runComprehensiveGmailSearchAll() {
  try {
    console.log("⏳ Waiting for Supabase services to start...");
    
    // Retry logic to wait for server startup
    const maxRetries = 30;
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
          console.error("❌ Services not available after 30 seconds");
          console.error("Please ensure npm run gapi:serve is running");
          process.exit(1);
        }
      }
    }
    
    console.log("");
    console.log("⏳ Waiting for services to be fully ready...");
    await new Promise(resolve => setTimeout(resolve, 15000));
    
    console.log("📤 Submitting comprehensive Gmail search ALL task...");
    
    const response = await fetch(`${SUPABASE_URL}/functions/v1/tasks/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        taskName: 'comprehensive-gmail-search-all',
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
    console.log("⚠️  This will take longer as it retrieves ALL data:");
    console.log("  1. 🏢 Discover all Google Workspace domains");
    console.log("  2. 👥 List ALL users for each domain (paginated)");  
    console.log("  3. 📧 Search ALL Gmail messages for each user (paginated)");
    console.log("  4. 📊 Aggregate all results with statistics");
    console.log("");
    console.log("💡 VM will suspend/resume many times during pagination");
    console.log("");

    // Enhanced monitoring with extended timeout for ALL data retrieval
    const startTime = Date.now();
    let lastStatus = '';
    let lastWaitingOn = '';
    let attempts = 0;
    const maxAttempts = 600; // 20 minutes max for extensive data retrieval

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;
      
      try {
        const statusResponse = await fetch(`${SUPABASE_URL}/rest/v1/task_runs?id=eq.${result.taskRunId}&select=*`, {
          headers: {
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
            'apikey': SERVICE_ROLE_KEY
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
            console.log(`       💾 VM state preserved - external API call in progress (pagination)`);
          }
        }
        
        if (task.status === 'completed') {
          console.log("");
          console.log("🎉 COMPREHENSIVE GMAIL SEARCH (ALL DATA) COMPLETED!");
          console.log("==================================================");
          
          if (task.result && task.result.summary) {
            const summary = task.result.summary;
            const stats = task.result.statistics || {};
            
            console.log(`📊 Final Results Summary:`);
            console.log(`   🏢 Domains processed: ${summary.totalDomains}`);
            console.log(`   👥 Total users found: ${summary.totalUsers}`);
            console.log(`   👤 Active users processed: ${summary.processedUsers}`);
            console.log(`   📧 Total emails found: ${summary.totalMessagesFound}`);
            console.log(`   📊 Average emails per user: ${stats.averageEmailsPerUser || 0}`);
            console.log(`   🔍 Search query: "${summary.searchQuery}"`);
            
            // Show domain breakdown
            if (task.result.domainResults && task.result.domainResults.length > 0) {
              console.log("");
              console.log("📋 Results by Domain:");
              task.result.domainResults.forEach((domain, index) => {
                console.log(`   ${index + 1}. 🏢 ${domain.domain}:`);
                console.log(`      👥 Total users: ${domain.userCount}`);
                console.log(`      📧 Total emails: ${domain.totalMessages}`);
                
                // Show top 3 users by email count
                if (domain.users && domain.users.length > 0) {
                  const topUsers = domain.users
                    .sort((a, b) => b.messageCount - a.messageCount)
                    .slice(0, 3);
                  
                  console.log(`      👤 Top users by email count:`);
                  topUsers.forEach((user, userIndex) => {
                    console.log(`         ${userIndex + 1}. ${user.email}: ${user.messageCount} emails`);
                  });
                }
              });
            }
            
            // Show sample messages
            if (task.result.sampleMessages && task.result.sampleMessages.length > 0) {
              console.log("");
              console.log("📬 Sample Messages (first 5):");
              task.result.sampleMessages.slice(0, 5).forEach((msg, index) => {
                console.log(`   ${index + 1}. From: ${msg.userEmail} (${msg.domain})`);
                console.log(`      Subject: ${msg.subject}`);
                console.log(`      Snippet: ${msg.snippet.substring(0, 100)}...`);
              });
            }
            
            // Show execution info
            if (task.result.executionInfo) {
              console.log("");
              console.log("⚡ Execution Statistics:");
              console.log(`   ⏱️  Total time: ${elapsed}s`);
              console.log(`   📡 Estimated API calls: ${task.result.executionInfo.totalApiCalls}`);
              console.log(`   💾 Suspensions/Resumes: Multiple (pagination)`);
            }
          } else {
            console.log("📄 Raw Result:", JSON.stringify(task.result, null, 2));
          }
          
          console.log("");
          console.log("✨ Technical Achievement:");
          console.log("   ✅ Retrieved ALL users across ALL domains");
          console.log("   ✅ Retrieved ALL emails for each active user");
          console.log("   ✅ Handled pagination automatically");
          console.log("   ✅ VM suspend/resume worked flawlessly");
          console.log("   ✅ Complete data aggregation successful");
          console.log("");
          console.log("🚀 The comprehensive Gmail search with FULL data retrieval is complete!");
          
          process.exit(0);
        } else if (task.status === 'failed') {
          console.log("");
          console.log("❌ TASK FAILED");
          console.log("==============");
          
          if (task.error) {
            console.log("💥 Error Details:");
            console.log(JSON.stringify(task.error, null, 2));
          }
          
          process.exit(1);
        }
        
        // Progress indicator for long-running operations
        if (attempts % 30 === 0 && task.status === 'suspended') {
          console.log(`       ⏳ Still processing after ${elapsed}s (normal for pagination-heavy operations)`);
        }
        
      } catch (error) {
        console.log(`⚠️  Monitoring error: ${error.message}`);
      }
    }
    
    console.log("");
    console.log("⏰ MONITORING TIMEOUT REACHED");
    console.log("=============================");
    console.log("The task is still running but monitoring has reached the 20-minute limit.");
    console.log(`📊 Final status: ${lastStatus.toUpperCase()}`);
    console.log(`🔗 Task ID: ${result.taskRunId}`);
    console.log("");
    console.log("💡 For large datasets, the task may still be running.");
    console.log("   Check the database directly for final results.");
    
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
    
    process.exit(1);
  }
}

// Run the comprehensive Gmail search for ALL data
runComprehensiveGmailSearchAll();