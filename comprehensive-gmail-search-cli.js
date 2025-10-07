#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

/**
 * CLI for comprehensive Gmail search task
 *
 * This CLI submits a Gmail search task to the task execution system and monitors progress.
 * The task will automatically suspend/resume on each external API call without any
 * additional logic required in the task code.
 */

// Parse command line arguments
const args = process.argv.slice(2);
const parsedArgs = {
  gmailSearchQuery: "",
  maxUsersPerDomain: 98,
  maxResultsPerUser: 10,
  help: false
};

// Parse arguments
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') {
    parsedArgs.help = true;
  } else if (arg === '--query' || arg === '-q') {
    parsedArgs.gmailSearchQuery = args[++i] || "";
  } else if (arg === '--maxUsersPerDomain') {
    parsedArgs.maxUsersPerDomain = parseInt(args[++i]) || 98;
  } else if (arg === '--maxResultsPerUser') {
    parsedArgs.maxResultsPerUser = parseInt(args[++i]) || 10;
  }
}

if (parsedArgs.help) {
  console.log(`
Comprehensive Gmail Search CLI

Usage:
  node comprehensive-gmail-search-cli.js [options]

Options:
  --query, -q <query>              Gmail search query (default: all emails)
  --maxUsersPerDomain <number>     Maximum users per domain (default: 98, max: 500)
  --maxResultsPerUser <number>     Maximum results per user (default: 10, max: 100)
  --help, -h                       Show this help message

Examples:
  node comprehensive-gmail-search-cli.js
  node comprehensive-gmail-search-cli.js --query "from:example.com" --maxResultsPerUser 5
  node comprehensive-gmail-search-cli.js --maxUsersPerDomain 50 --maxResultsPerUser 20

Description:
  This CLI submits a comprehensive Gmail search task that:
  1. Discovers all Google Workspace domains
  2. Lists users in each domain
  3. Searches Gmail for each user
  4. Retrieves message details
  5. Returns aggregated results

  The task uses automatic suspend/resume execution - each external API call
  automatically suspends the task, processes the call, and resumes with results.
  This enables infinite-length tasks without timeouts.
`);
  process.exit(0);
}

// Validate environment variables
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

console.log('🚀 Starting Comprehensive Gmail Search');
console.log('📧 Query:', parsedArgs.gmailSearchQuery || '(all emails)');
console.log('👥 Max Users Per Domain:', parsedArgs.maxUsersPerDomain);
console.log('📋 Max Results Per User:', parsedArgs.maxResultsPerUser);
console.log('');

// Create Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function submitTask() {
  try {
    console.log('📤 Submitting Gmail search task...');

    // Submit the task
    const { data, error } = await supabase.functions.invoke('tasks/execute', {
      method: 'POST',
      body: {
        task_identifier: 'comprehensive-gmail-search',
        input: parsedArgs
      }
    });

    if (error) {
      console.error('❌ Error submitting task:', error);
      throw error;
    }

    if (!data || !data.success) {
      console.error('❌ Task submission failed:', data);
      throw new Error('Task submission failed');
    }

    const taskRunId = data.data?.result?.taskRunId;
    console.log('✅ Task submitted successfully');
    console.log('🆔 Task Run ID:', taskRunId);
    console.log('');

    // Monitor task progress
    await monitorTask(taskRunId);

  } catch (error) {
    console.error('❌ Failed to submit task:', error.message);
    process.exit(1);
  }
}

async function monitorTask(taskRunId) {
  console.log('👀 Monitoring task progress...');
  console.log('   The task will automatically suspend/resume on each external call');
  console.log('   This enables processing large workloads without timeouts');
  console.log('');

  let lastStatus = '';
  let checkCount = 0;
  const maxChecks = 1200; // 10 minutes with 0.5s intervals
  const checkInterval = 500; // 0.5 seconds

  const checkStatus = async () => {
    try {
      checkCount++;

      // Get task status
      const { data: taskData, error: taskError } = await supabase
        .from('task_runs')
        .select('*')
        .eq('id', taskRunId)
        .single();

      if (taskError) {
        console.error('❌ Error checking task status:', taskError);
        return;
      }

      if (!taskData) {
        console.error('❌ Task not found');
        return;
      }

      const currentStatus = taskData.status;

      // Only log when status changes or every 30 seconds
      if (currentStatus !== lastStatus || checkCount % 60 === 0) {
        console.log(`📊 Task Status: ${currentStatus} (${new Date().toISOString()})`);

        if (taskData.result) {
          const result = JSON.parse(taskData.result);
          if (result.summary) {
            console.log(`   📈 Progress: ${result.summary.totalDomains || 0} domains, ${result.summary.totalUsers || 0} users, ${result.summary.totalMessagesFound || 0} messages`);
          }
        }

        lastStatus = currentStatus;
      }

      if (currentStatus === 'completed') {
        console.log('');
        console.log('🎉 Task completed successfully!');

        if (taskData.result) {
          const result = JSON.parse(taskData.result);

          console.log('');
          console.log('📊 Final Results:');
          console.log('   🏢 Total Domains:', result.summary?.totalDomains || 0);
          console.log('   👥 Total Users:', result.summary?.totalUsers || 0);
          console.log('   📧 Total Messages Found:', result.summary?.totalMessagesFound || 0);
          console.log('   🔍 Search Query:', `"${result.summary?.searchQuery || ''}"`);

          if (result.executionInfo) {
            console.log('   📡 Total API Calls:', result.executionInfo.totalApiCalls);
            console.log('   ⏱️ Completed At:', result.executionInfo.completedAt);
          }

          // Show sample messages
          if (result.sampleMessages && result.sampleMessages.length > 0) {
            console.log('');
            console.log('📧 Sample Messages:');
            result.sampleMessages.slice(0, 3).forEach((msg, i) => {
              console.log(`   ${i + 1}. ${msg.subject || 'No subject'}`);
              console.log(`      From: ${msg.from || 'Unknown'}`);
              console.log(`      Date: ${msg.date || 'Unknown'}`);
              console.log(`      User: ${msg.userEmail}`);
              if (msg.snippet) {
                console.log(`      Snippet: ${msg.snippet.substring(0, 100)}...`);
              }
              console.log('');
            });
          }

          // Show domain breakdown
          if (result.domainResults && result.domainResults.length > 0) {
            console.log('🏢 Domain Breakdown:');
            result.domainResults.forEach(domain => {
              console.log(`   ${domain.domain}: ${domain.userCount} users, ${domain.totalMessages} messages`);
            });
          }
        }

        console.log('');
        console.log('✅ Gmail search completed successfully!');
        console.log('   The task used automatic suspend/resume to process all external API calls');
        console.log('   Each call created a child stack run and resumed the parent with results');
        return;
      }

      if (currentStatus === 'failed') {
        console.error('❌ Task failed');
        if (taskData.error) {
          console.error('   Error:', taskData.error);
        }
        return;
      }

      // Check stack runs to see suspend/resume activity
      if (checkCount % 120 === 0) { // Every minute
        const { data: stackData } = await supabase
          .from('stack_runs')
          .select('status, count')
          .eq('task_run_id', taskRunId);

        if (stackData && stackData.length > 0) {
          const statusCounts = stackData.reduce((acc, run) => {
            acc[run.status] = (acc[run.status] || 0) + 1;
            return acc;
          }, {});

          console.log(`   🔄 Stack Activity: ${JSON.stringify(statusCounts)}`);
        }
      }

      // Continue monitoring
      if (checkCount < maxChecks) {
        setTimeout(checkStatus, checkInterval);
      } else {
        console.log('');
        console.log('⏰ Monitoring timeout reached (10 minutes)');
        console.log('   The task is still running and will continue processing');
        console.log('   You can check the results later in the database');
      }

    } catch (error) {
      console.error('❌ Error monitoring task:', error.message);
    }
  };

  // Start monitoring
  setTimeout(checkStatus, 1000); // Start after 1 second
}

// Start the task submission
submitTask().catch(console.error);