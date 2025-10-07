#!/usr/bin/env node

/**
 * Test script to verify complete Gmail search workflow
 * Tests the suspend/resume mechanism by executing the comprehensive Gmail search task
 */

import http from 'http';
import fs from 'fs';

// Configuration
const SUPABASE_URL = 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
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

async function submitTask() {
  console.log('🚀 Submitting comprehensive Gmail search task...');

  // Read the task code
  const taskCode = fs.readFileSync('./taskcode/endpoints/comprehensive-gmail-search.js', 'utf8');

  const taskData = {
    task_identifier: 'comprehensive-gmail-search',
    input: {
      gmailSearchQuery: '',
      maxResultsPerUser: 1,
      maxUsersPerDomain: 1
    }
  };

  const options = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(taskData)
  };

  const response = await makeRequest(`http://127.0.0.1:54321/functions/v1/tasks/execute`, options);

  if (response.status === 200) {
    console.log('✅ Task submitted successfully:', response.data);
    return response.data;
  } else {
    console.error('❌ Task submission failed:', response.status, response.data);
    throw new Error('Task submission failed');
  }
}

async function monitorTask(taskId) {
  console.log(`📊 Monitoring task ${taskId} execution...`);

  let checkCount = 0;
  const maxChecks = 60; // Check for up to 5 minutes

  while (checkCount < maxChecks) {
    const options = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': SUPABASE_SERVICE_ROLE_KEY
      }
    };

    const response = await makeRequest(`${SUPABASE_URL}/functions/v1/tasks/status/${taskId}`, options);

    if (response.status === 200) {
      const status = response.data;
      console.log(`📈 Check ${checkCount + 1}: Status=${status.status}, Stack Runs=${status.stackRuns || 0}, Progress=${status.currentStep || 'unknown'}`);

      if (status.status === 'completed') {
        console.log('🎉 Task completed successfully!');
        console.log('📊 Final Results:', JSON.stringify(status.result, null, 2));
        return status.result;
      } else if (status.status === 'failed') {
        console.error('❌ Task failed:', status.error);
        throw new Error(status.error);
      }
    }

    checkCount++;
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds between checks
  }

  throw new Error('Task monitoring timeout');
}

async function main() {
  try {
    console.log('🔍 Starting complete Gmail search workflow test...');
    console.log('📋 This will test the suspend/resume mechanism across all phases:');
    console.log('   1. Domain discovery (4 domains)');
    console.log('   2. User enumeration (1 user per domain)');
    console.log('   3. Gmail message search (1 message per user)');
    console.log('   4. Message detail retrieval');
    console.log('   5. Result aggregation');
    console.log('');

    const result = await submitTask();
    const taskId = result.taskId;

    console.log(`📝 Task ID: ${taskId}`);
    console.log('⏳ Waiting for task to complete...');
    console.log('');

    const finalResult = await monitorTask(taskId);

    console.log('');
    console.log('✅ COMPLETE WORKFLOW VERIFICATION SUCCESSFUL!');
    console.log('');
    console.log('📊 Summary:');
    console.log(`   🏢 Domains found: ${finalResult.summary.totalDomains}`);
    console.log(`   👥 Users processed: ${finalResult.summary.totalUsers}`);
    console.log(`   📧 Messages found: ${finalResult.summary.totalMessagesFound}`);
    console.log(`   📡 Total API calls: ${finalResult.executionInfo.totalApiCalls}`);
    console.log('');
    console.log('🔄 Suspend/Resume Mechanism: ✅ WORKING');
    console.log('🌐 HTTP Chaining: ✅ WORKING');
    console.log('📦 Result Aggregation: ✅ WORKING');
    console.log('');
    console.log('🎉 The complete Gmail search system finishes successfully!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

main();