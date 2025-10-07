#!/usr/bin/env node

import http from 'http';

/**
 * Check the actual database table structure by trying to query different columns
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

async function checkTableStructure() {
  console.log('🔍 Checking actual table structure...');

  try {
    // Try to query task_runs with different columns to see what's available
    console.log('📋 Checking task_runs table...');

    const commonColumns = ['id', 'task_function_id', 'task_name', 'status', 'result', 'error', 'created_at', 'updated_at'];

    for (const column of commonColumns) {
      const response = await makeRequest(
        `${SUPABASE_URL}/rest/v1/task_runs?select=${column}&limit=1`,
        {
          headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
          }
        }
      );

      if (response.status === 200) {
        console.log(`✅ Column '${column}' exists`);
      } else {
        console.log(`❌ Column '${column}' missing or error: ${response.status}`);
      }
    }

    // Check if input column exists
    console.log('\n🔍 Checking for input column...');
    const inputResponse = await makeRequest(
      `${SUPABASE_URL}/rest/v1/task_runs?select=input&limit=1`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

    if (inputResponse.status === 200) {
      console.log('✅ input column exists');
    } else {
      console.log('❌ input column missing');
    }

    // Check stack_runs table
    console.log('\n📋 Checking stack_runs table...');
    const stackColumns = ['id', 'parent_task_run_id', 'parent_stack_run_id', 'service_name', 'method_name', 'args', 'status', 'result', 'created_at'];

    for (const column of stackColumns) {
      const response = await makeRequest(
        `${SUPABASE_URL}/rest/v1/stack_runs?select=${column}&limit=1`,
        {
          headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
          }
        }
      );

      if (response.status === 200) {
        console.log(`✅ Column '${column}' exists`);
      } else {
        console.log(`❌ Column '${column}' missing or error: ${response.status}`);
      }
    }

    // Try to create a simple task run without input column
    console.log('\n🧪 Testing task run creation without input...');
    const testResponse = await makeRequest(
      `${SUPABASE_URL}/rest/v1/task_runs`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          task_function_id: 1,
          task_name: 'test-task',
          status: 'pending'
        })
      }
    );

    if (testResponse.status === 201) {
      console.log('✅ Basic task run creation successful');
      console.log('📊 Response:', testResponse.data);

      // Clean up the test task run
      if (testResponse.data && testResponse.data.id) {
        await makeRequest(
          `${SUPABASE_URL}/rest/v1/task_runs?id=eq.${testResponse.data.id}`,
          {
            method: 'DELETE',
            headers: {
              'apikey': SUPABASE_SERVICE_ROLE_KEY,
              'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
            }
          }
        );
        console.log('🧹 Test task run cleaned up');
      }
    } else {
      console.log('❌ Basic task run creation failed:', testResponse.status, testResponse.data);
    }

  } catch (error) {
    console.error('❌ Check failed:', error.message);
  }
}

checkTableStructure();