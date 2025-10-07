#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

/**
 * Test script to execute comprehensive Gmail search through proper task execution flow
 */

// Configuration
const SUPABASE_URL = 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

async function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const http = require('http');
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

async function testProperTaskExecution() {
  console.log('🚀 Testing proper task execution flow...');

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Step 1: Create task run
    console.log('📝 Creating task run...');
    const { data: taskRun, error: taskRunError } = await supabase
      .from('task_runs')
      .insert({
        task_function_id: 1, // comprehensive-gmail-search has id 1
        task_name: 'comprehensive-gmail-search',
        status: 'pending',
        input: {
          gmailSearchQuery: "",
          maxResultsPerUser: 1,
          maxUsersPerDomain: 1
        }
      })
      .select()
      .single();

    if (taskRunError) {
      console.error('❌ Failed to create task run:', taskRunError);
      throw taskRunError;
    }

    console.log('✅ Task run created:', taskRun.id);

    // Step 2: Create stack run for task execution
    console.log('📚 Creating stack run...');
    const { data: stackRun, error: stackRunError } = await supabase
      .from('stack_runs')
      .insert({
        parent_task_run_id: taskRun.id,
        service_name: 'deno-executor',
        method_name: 'execute',
        args: [{
          taskName: 'comprehensive-gmail-search',
          input: {
            gmailSearchQuery: "",
            maxResultsPerUser: 1,
            maxUsersPerDomain: 1
          }
        }],
        status: 'pending'
      })
      .select()
      .single();

    if (stackRunError) {
      console.error('❌ Failed to create stack run:', stackRunError);
      throw stackRunError;
    }

    console.log('✅ Stack run created:', stackRun.id);

    // Step 3: Trigger stack processor
    console.log('⚡ Triggering stack processor...');

    const processorResponse = await makeRequest('http://127.0.0.1:54321/functions/v1/simple-stack-processor', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ trigger: 'process-next' })
    });

    if (processorResponse.status === 200) {
      console.log('✅ Stack processor triggered successfully');
    } else {
      console.error('❌ Failed to trigger stack processor:', processorResponse);
      throw new Error('Stack processor trigger failed');
    }

    // Step 4: Monitor execution
    console.log('👀 Monitoring task execution...');
    await monitorTaskExecution(taskRun.id, stackRun.id);

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

async function monitorTaskExecution(taskRunId, stackRunId) {
  let checkCount = 0;
  const maxChecks = 60; // Check for up to 5 minutes

  while (checkCount < maxChecks) {
    // Check task run status
    const taskResponse = await makeRequest(
      `${SUPABASE_URL}/rest/v1/task_runs?id=eq.${taskRunId}&select=status,result,error,updated_at`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

    if (taskResponse.status === 200 && taskResponse.data.length > 0) {
      const taskRun = taskResponse.data[0];
      console.log(`📊 Task Status: ${taskRun.status} (check ${checkCount + 1})`);

      if (taskRun.status === 'completed') {
        console.log('🎉 Task completed successfully!');
        if (taskRun.result) {
          const result = JSON.parse(taskRun.result);
          console.log('📊 Results:', JSON.stringify(result, null, 2));
        }
        return;
      } else if (taskRun.status === 'failed') {
        console.error('❌ Task failed:', taskRun.error);
        throw new Error(taskRun.error);
      }
    }

    // Check stack runs for suspend/resume activity
    const stackResponse = await makeRequest(
      `${SUPABASE_URL}/rest/v1/stack_runs?parent_task_run_id=eq.${taskRunId}&select=status,service_name,method_name,created_at&order=created_at.desc`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

    if (stackResponse.status === 200) {
      const stackRuns = stackResponse.data;
      const statusCounts = stackRuns.reduce((acc, run) => {
        acc[run.status] = (acc[run.status] || 0) + 1;
        return acc;
      }, {});

      if (Object.keys(statusCounts).length > 1 || statusCounts.pending > 1) {
        console.log(`   🔄 Stack Activity: ${JSON.stringify(statusCounts)} total runs: ${stackRuns.length}`);
      }
    }

    checkCount++;
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
  }

  throw new Error('Task execution monitoring timeout');
}

testProperTaskExecution().catch(console.error);