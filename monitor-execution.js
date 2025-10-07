#!/usr/bin/env node

import http from 'http';

/**
 * Monitor task execution status directly from database
 */

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

async function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          resolve({ status: res.statusCode, data: jsonData });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function monitorExecution() {
  console.log('👀 Monitoring task execution status...');

  try {
    // Check task runs
    console.log('\n📋 Task Runs:');
    const taskResponse = await makeRequest(
      `${SUPABASE_URL}/rest/v1/task_runs?select=id,status,result,error,created_at,updated_at&order=created_at.desc`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

    if (taskResponse.status === 200) {
      const taskRuns = taskResponse.data;
      console.log(`Found ${taskRuns.length} task runs:`);
      taskRuns.forEach(task => {
        console.log(`  📝 Task ${task.id}: ${task.status} (created: ${task.created_at})`);
        if (task.error) {
          console.log(`     ❌ Error: ${task.error}`);
        }
        if (task.result) {
          const result = JSON.parse(task.result);
          console.log(`     ✅ Result: ${JSON.stringify(result, null, 2).substring(0, 200)}...`);
        }
      });
    }

    // Check stack runs
    console.log('\n📚 Stack Runs:');
    const stackResponse = await makeRequest(
      `${SUPABASE_URL}/rest/v1/stack_runs?select=id,parent_task_run_id,service_name,method_name,status,result,error,created_at&order=created_at.desc`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

    if (stackResponse.status === 200) {
      const stackRuns = stackResponse.data;
      console.log(`Found ${stackRuns.length} stack runs:`);
      stackRuns.forEach(stack => {
        console.log(`  🔗 Stack ${stack.id}: ${stack.service_name}.${stack.method_name} = ${stack.status} (task: ${stack.parent_task_run_id})`);
        if (stack.error) {
          console.log(`     ❌ Error: ${stack.error}`);
        }
        if (stack.result) {
          console.log(`     ✅ Result: ${JSON.stringify(stack.result).substring(0, 100)}...`);
        }
      });
    }

    // Check if there are any suspended tasks
    console.log('\n⏸️ Suspended Tasks:');
    const suspendedResponse = await makeRequest(
      `${SUPABASE_URL}/rest/v1/task_runs?status=eq.suspended_waiting_child&select=id,waiting_on_stack_run_id,created_at`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

    if (suspendedResponse.status === 200 && suspendedResponse.data.length > 0) {
      suspendedResponse.data.forEach(task => {
        console.log(`  ⏸️ Task ${task.id} waiting on stack run ${task.waiting_on_stack_run_id}`);
      });
    } else {
      console.log('  No suspended tasks found');
    }

  } catch (error) {
    console.error('❌ Monitoring failed:', error.message);
  }
}

monitorExecution();