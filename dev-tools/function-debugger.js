#!/usr/bin/env node

/**
 * Edge Function Debugger
 * 
 * Debugging tools for inspecting edge function state, logs, and responses.
 * Usage: npm run debug:function -- --function wrappedgapi --action logs
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const DEFAULT_BASE_URL = 'http://127.0.0.1:54321';
const DEFAULT_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

// Available debug actions
const DEBUG_ACTIONS = {
  'logs': 'Show recent logs from the function',
  'state': 'Show current function state and health',
  'database': 'Show database state (stack_runs, task_runs)',
  'clear-db': 'Clear database tables (stack_runs, task_runs)',
  'inspect': 'Interactive inspection of function responses',
  'trace': 'Enable detailed tracing for next function call'
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }
  
  const options = {
    functionName: null,
    action: null,
    baseUrl: process.env.SUPABASE_URL || DEFAULT_BASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || DEFAULT_SERVICE_KEY,
    verbose: false,
    output: null,
    limit: 50
  };
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--function' && args[i + 1]) {
      options.functionName = args[i + 1];
      i++;
    } else if (args[i] === '--action' && args[i + 1]) {
      options.action = args[i + 1];
      i++;
    } else if (args[i] === '--url' && args[i + 1]) {
      options.baseUrl = args[i + 1];
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      options.output = args[i + 1];
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      options.limit = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--verbose') {
      options.verbose = true;
    }
  }
  
  return options;
}

function showHelp() {
  console.log(`
Edge Function Debugger

Usage: npm run debug:function -- [options]

Options:
  --function <name>    Function to debug
  --action <action>    Debug action to perform
  --url <url>          Base URL (default: ${DEFAULT_BASE_URL})
  --output <file>      Save output to file
  --limit <number>     Limit results (default: 50)
  --verbose            Enable verbose logging
  --help, -h           Show this help

Available actions:
${Object.entries(DEBUG_ACTIONS).map(([action, desc]) => `  ${action.padEnd(12)} ${desc}`).join('\n')}

Examples:
  npm run debug:function -- --action database
  npm run debug:function -- --function wrappedgapi --action state
  npm run debug:function -- --action logs --limit 100
  npm run debug:function -- --action clear-db
`);
}

// Function debugger class
class FunctionDebugger {
  constructor(options) {
    this.options = options;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.functionsUrl = `${this.baseUrl}/functions/v1`;
  }

  async runAction() {
    const { action } = this.options;
    
    console.log(`🔍 Running debug action: ${action}`);
    
    switch (action) {
      case 'logs':
        await this.showLogs();
        break;
      case 'state':
        await this.showState();
        break;
      case 'database':
        await this.showDatabase();
        break;
      case 'clear-db':
        await this.clearDatabase();
        break;
      case 'inspect':
        await this.inspectFunction();
        break;
      case 'trace':
        await this.enableTracing();
        break;
      default:
        console.error(`❌ Unknown action: ${action}`);
        console.log('Available actions:', Object.keys(DEBUG_ACTIONS).join(', '));
        process.exit(1);
    }
  }

  async showLogs() {
    console.log('📋 Recent function logs:');
    
    // For now, we'll show logs from the database
    // In a real implementation, you might want to integrate with Supabase logs API
    try {
      const response = await this.queryDatabase(`
        SELECT 
          sr.id,
          sr.service_name,
          sr.method_name,
          sr.status,
          sr.created_at,
          sr.completed_at,
          sr.error_message,
          tr.task_name
        FROM stack_runs sr
        LEFT JOIN task_runs tr ON sr.task_run_id = tr.id
        ORDER BY sr.created_at DESC
        LIMIT ${this.options.limit}
      `);
      
      if (response.length === 0) {
        console.log('No recent logs found');
        return;
      }
      
      for (const log of response) {
        const duration = log.completed_at ? 
          new Date(log.completed_at) - new Date(log.created_at) : 
          'pending';
        
        console.log(`
📝 Stack Run ${log.id}
   Service: ${log.service_name}
   Method: ${log.method_name}
   Task: ${log.task_name || 'N/A'}
   Status: ${log.status}
   Duration: ${duration}ms
   Created: ${log.created_at}
   ${log.error_message ? `Error: ${log.error_message}` : ''}
        `.trim());
      }
      
    } catch (error) {
      console.error('❌ Failed to fetch logs:', error.message);
    }
  }

  async showState() {
    const { functionName } = this.options;
    
    if (!functionName) {
      console.error('❌ Function name required for state inspection');
      process.exit(1);
    }
    
    console.log(`🔍 Function state: ${functionName}`);
    
    try {
      // Test function health
      const healthUrl = `${this.functionsUrl}/${functionName}`;
      const startTime = Date.now();
      
      const response = await fetch(healthUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.options.serviceKey}`
        }
      });
      
      const duration = Date.now() - startTime;
      const responseText = await response.text();
      
      console.log(`📊 Health Check:`);
      console.log(`   Status: ${response.status} ${response.statusText}`);
      console.log(`   Response Time: ${duration}ms`);
      console.log(`   Response: ${responseText.substring(0, 200)}${responseText.length > 200 ? '...' : ''}`);
      
      // Show recent activity for this function
      const activity = await this.queryDatabase(`
        SELECT COUNT(*) as total_calls,
               COUNT(CASE WHEN status = 'completed' THEN 1 END) as successful_calls,
               COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_calls,
               AVG(CASE WHEN completed_at IS NOT NULL THEN 
                 EXTRACT(EPOCH FROM (completed_at::timestamp - created_at::timestamp)) * 1000 
               END) as avg_duration_ms
        FROM stack_runs 
        WHERE service_name = '${functionName}'
        AND created_at > NOW() - INTERVAL '1 hour'
      `);
      
      if (activity.length > 0) {
        const stats = activity[0];
        console.log(`📈 Recent Activity (last hour):`);
        console.log(`   Total Calls: ${stats.total_calls}`);
        console.log(`   Successful: ${stats.successful_calls}`);
        console.log(`   Failed: ${stats.failed_calls}`);
        console.log(`   Avg Duration: ${Math.round(stats.avg_duration_ms || 0)}ms`);
      }
      
    } catch (error) {
      console.error('❌ Failed to check function state:', error.message);
    }
  }

  async showDatabase() {
    console.log('🗄️  Database state:');

    try {
      // Recent task runs
      const taskRuns = await this.queryDatabase('task_runs', 10);

      console.log('📋 Recent Task Runs:');
      if (taskRuns.length === 0) {
        console.log('   No task runs found');
      } else {
        for (const row of taskRuns) {
          console.log(`   ${row.id}: ${row.task_name} - ${row.status} (${row.created_at})`);
        }
      }

      // Recent stack runs
      const stackRuns = await this.queryDatabase('stack_runs', 10);

      console.log('\n🔧 Recent Stack Runs:');
      if (stackRuns.length === 0) {
        console.log('   No stack runs found');
      } else {
        for (const row of stackRuns) {
          console.log(`   ${row.id}: ${row.service_name}.${row.method_name} - ${row.status} (${row.created_at})`);
        }
      }

    } catch (error) {
      console.error('❌ Failed to query database:', error.message);
    }
  }

  async clearDatabase() {
    console.log('🧹 Clearing database tables...');

    try {
      await this.deleteFromTable('stack_runs');
      const stackCount = await this.countTable('stack_runs');

      await this.deleteFromTable('task_runs');
      const taskCount = await this.countTable('task_runs');

      console.log(`✅ Cleared database:`);
      console.log(`   Stack runs remaining: ${stackCount}`);
      console.log(`   Task runs remaining: ${taskCount}`);

    } catch (error) {
      console.error('❌ Failed to clear database:', error.message);
    }
  }

  async inspectFunction() {
    const { functionName } = this.options;
    
    if (!functionName) {
      console.error('❌ Function name required for inspection');
      process.exit(1);
    }
    
    console.log(`🔍 Inspecting function: ${functionName}`);
    console.log('Enter JSON payload to send (or "quit" to exit):');
    
    // Simple interactive mode
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async (data) => {
      const input = data.toString().trim();
      
      if (input === 'quit') {
        process.exit(0);
      }
      
      try {
        const payload = JSON.parse(input);
        await this.sendTestRequest(functionName, payload);
      } catch (error) {
        console.error('❌ Invalid JSON or request failed:', error.message);
      }
      
      console.log('\nEnter next payload (or "quit" to exit):');
    });
  }

  async enableTracing() {
    console.log('🔍 Tracing mode enabled for next function calls');
    console.log('This would enable detailed logging in the functions...');
    // Implementation would depend on how you want to implement tracing
  }

  async sendTestRequest(functionName, payload) {
    const url = `${this.functionsUrl}/${functionName}`;
    
    try {
      const startTime = Date.now();
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.options.serviceKey}`
        },
        body: JSON.stringify(payload)
      });
      
      const duration = Date.now() - startTime;
      const responseText = await response.text();
      
      console.log(`📊 Response (${duration}ms):`);
      console.log(`   Status: ${response.status}`);
      
      try {
        const jsonResponse = JSON.parse(responseText);
        console.log('   Body:', JSON.stringify(jsonResponse, null, 2));
      } catch (e) {
        console.log('   Body:', responseText);
      }
      
    } catch (error) {
      console.error('❌ Request failed:', error.message);
    }
  }

  async queryDatabase(tableName = 'task_runs', limit = 5) {
    const response = await fetch(`${this.functionsUrl}/wrappedsupabase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.options.serviceKey}`
      },
      body: JSON.stringify({
        chain: [
          { property: 'from', args: [tableName] },
          { property: 'select', args: ['*'] },
          { property: 'order', args: ['created_at', { ascending: false }] },
          { property: 'limit', args: [limit] }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Database query failed: ${response.status}`);
    }

    const result = await response.json();
    return result.data || [];
  }

  async deleteFromTable(tableName) {
    const response = await fetch(`${this.functionsUrl}/wrappedsupabase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.options.serviceKey}`
      },
      body: JSON.stringify({
        chain: [
          { property: 'from', args: [tableName] },
          { property: 'delete', args: [] }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Database delete failed: ${response.status}`);
    }

    const result = await response.json();
    return result;
  }

  async countTable(tableName) {
    const response = await fetch(`${this.functionsUrl}/wrappedsupabase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.options.serviceKey}`
      },
      body: JSON.stringify({
        chain: [
          { property: 'from', args: [tableName] },
          { property: 'select', args: ['*', { count: 'exact' }] }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Database count failed: ${response.status}`);
    }

    const result = await response.json();
    return result.count || 0;
  }
}

// Main execution
async function main() {
  const options = parseArgs();
  
  if (!options.action) {
    console.error('❌ Action is required. Use --action <action>');
    console.error('Available actions:', Object.keys(DEBUG_ACTIONS).join(', '));
    process.exit(1);
  }
  
  const functionDebugger = new FunctionDebugger(options);
  await functionDebugger.runAction();
}

// Run main function if this file is executed directly
main().catch(console.error);
