#!/usr/bin/env node

/**
 * Comprehensive Gmail Search CLI
 * 
 * This CLI submits a comprehensive Gmail search task and exits immediately.
 * The task will continue executing automatically using the suspend/resume mechanism.
 */

// Use node's built-in fetch (available in Node 18+)

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  
  // Show help if requested
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }
  
  const options = {
    gmailSearchQuery: '',
    maxResultsPerUser: 10,
    maxUsersPerDomain: 98, // Google API limit safe default
    noWait: false
  };
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--gmailSearchQuery' && args[i + 1]) {
      options.gmailSearchQuery = args[i + 1];
      i++;
    } else if (args[i] === '--maxResultsPerUser' && args[i + 1]) {
      options.maxResultsPerUser = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--maxUsersPerDomain' && args[i + 1]) {
      options.maxUsersPerDomain = parseInt(args[i + 1]);
      if (options.maxUsersPerDomain > 500) {
        console.warn('⚠️  Warning: maxUsersPerDomain > 500 may hit Google API limits');
      }
      i++;
    } else if (args[i] === '--noWait') {
      options.noWait = true;
    } else if (args[i].startsWith('--')) {
      console.error(`❌ Unknown option: ${args[i]}`);
      console.error('Use --help for available options');
      process.exit(1);
    }
  }
  
  return options;
}

// Show help information
function showHelp() {
  console.log(`
📧 Comprehensive Gmail Search CLI
=================================

USAGE:
  node comprehensive-gmail-search-cli.js [OPTIONS]

OPTIONS:
  --gmailSearchQuery <query>     Gmail search query (default: empty - searches all)
  --maxResultsPerUser <number>   Max results per user (default: 10)
  --maxUsersPerDomain <number>   Max users per domain (default: 98, max: 500)
  --noWait                       Skip service availability check
  --help, -h                     Show this help message

EXAMPLES:
  # Search all emails for all users (default limits)
  node comprehensive-gmail-search-cli.js

  # Search for specific content
  node comprehensive-gmail-search-cli.js --gmailSearchQuery "subject:meeting"
  
  # Large search across many users
  node comprehensive-gmail-search-cli.js --maxUsersPerDomain 98 --maxResultsPerUser 300

  # Quick test with minimal data
  node comprehensive-gmail-search-cli.js --maxUsersPerDomain 2 --maxResultsPerUser 1

REQUIREMENTS:
  • Supabase must be running: npm run serve
  • Google API credentials must be configured in keystore
  • Run from the project root directory

The task runs automatically in the background with suspend/resume capability.
Use Supabase Studio (http://127.0.0.1:54323) to monitor progress.
`);
}

/**
 * Main function to run the comprehensive Gmail search
 */
async function runComprehensiveGmailSearch() {
  try {
    const options = parseArgs();
    
    console.log('🚀 Comprehensive Gmail Search CLI');
    console.log('=================================');
    console.log(`📧 Search Query: "${options.gmailSearchQuery}"`);
    console.log(`👥 Max Users Per Domain: ${options.maxUsersPerDomain}`);
    console.log(`📋 Max Results Per User: ${options.maxResultsPerUser}`);
    console.log(`🌐 Target: All Google Workspace domains`);
    console.log('');

    if (!options.noWait) {
      // Service availability check with retry logic (wait up to 30 seconds for server startup)
      console.log('⏳ Checking service availability...');
      
      let healthCheck;
      let retryCount = 0;
      const maxRetries = 30; // 30 seconds total
      
      while (retryCount < maxRetries) {
        try {
          healthCheck = await fetch(`${SUPABASE_URL}/functions/v1/tasks`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
            }
          });
          
          if (healthCheck.ok || healthCheck.status === 405) {
            console.log('✅ Supabase services are available');
            break;
          }
        } catch (error) {
          // Server not ready yet, continue retrying
        }
        
        retryCount++;
        if (retryCount < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        }
      }
      
      if (retryCount >= maxRetries) {
        throw new Error('Services not available after 30 seconds');
      }
    }

    // Submit the task
    console.log('📤 Submitting comprehensive Gmail search task...');
    
    // Fire and forget - don't wait for response
    fetch(`${SUPABASE_URL}/functions/v1/tasks/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        taskName: 'comprehensive-gmail-search',
        input: {
          gmailSearchQuery: options.gmailSearchQuery,
          maxResultsPerUser: options.maxResultsPerUser,
          maxUsersPerDomain: options.maxUsersPerDomain
        }
      })
    }).then(response => {
      if (response.ok) {
        response.json().then(result => {
          console.log(`✅ Task submitted! ID: ${result.taskRunId}`);
        });
      }
    }).catch(error => {
      console.error('❌ Submission error:', error.message);
    });
    
    // Generate a placeholder task ID based on timestamp
    const taskRunId = `pending-${Date.now()}`;
    
    console.log('✅ Task submission initiated!');
    console.log('🔄 Task will process automatically in background');
    console.log('');
    console.log('💡 Use "npm run debug:db" to monitor progress');
    console.log('✅ CLI completed - exiting immediately!');
    
    // Exit immediately after successful task submission
    process.exit(0);
    
  } catch (error) {
    console.log('');
    
    if (error.name === 'AbortError') {
      console.error('⏱️ TASK SUBMISSION TIMEOUT');
      console.error('==========================');
      console.error('Task submission timed out after 5 seconds.');
      console.error('This likely means the system is under heavy processing load.');
      console.error('');
      console.error('✅ The task may have still been submitted successfully.');
      console.error('🔍 Check recent tasks with: node debug-task.js <latest_task_id>');
      console.error('📊 Or check overall status with: node trigger-processing.js');
    } else {
      console.error('❌ COMPREHENSIVE SEARCH FAILED');
      console.error('==============================');
      console.error(error.message);
      
      console.error('');
      console.error('🚨 Common issues:');
      console.error('   • Supabase not running: npm run serve');
      console.error('   • Wrong directory: ensure you\'re in the tasker project root');
      console.error('   • Network issues: check your internet connection');
      console.error('   • Missing credentials: configure Google API keys in keystore');
      console.error('');
      console.error('💡 Quick start:');
      console.error('   1. npm run serve  # Start Supabase services');
      console.error('   2. node comprehensive-gmail-search-cli.js --help  # See options');
    }
    
    process.exit(1);
  }
}

// Run the comprehensive Gmail search
runComprehensiveGmailSearch();