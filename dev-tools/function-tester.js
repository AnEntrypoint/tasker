#!/usr/bin/env node

/**
 * Edge Function Tester
 * 
 * Directly tests individual Supabase Edge Functions with real payloads.
 * Usage: npm run test:function -- --function wrappedgapi --test echo
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const DEFAULT_BASE_URL = 'http://127.0.0.1:54321/functions/v1';
const DEFAULT_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

// Test definitions for each function
const TEST_DEFINITIONS = {
  wrappedgapi: {
    echo: {
      description: 'Test echo functionality',
      payload: {
        method: 'echo',
        args: [{ message: 'Hello from tester!' }]
      }
    },
    'test-domains': {
      description: 'Test Google Admin SDK domains list',
      payload: {
        chain: [
          { type: "get", property: "admin" },
          { type: "get", property: "domains" },
          { type: "call", property: "list", args: [{ customer: "my_customer" }] }
        ]
      }
    }
  },
  wrappedkeystore: {
    'get-key': {
      description: 'Test getting a key from keystore',
      payload: {
        action: 'getKey',
        namespace: 'global',
        key: 'GAPI_KEY'
      }
    },
    'list-keys': {
      description: 'Test listing all keys',
      payload: {
        action: 'listKeys',
        namespace: 'global'
      }
    },
    'list-namespaces': {
      description: 'Test listing all namespaces',
      payload: {
        action: 'listNamespaces'
      }
    }
  },
  wrappedsupabase: {
    'test-connection': {
      description: 'Test Supabase connection',
      payload: {
        chain: [
          { property: 'from', args: ['task_functions'] },
          { property: 'select', args: ['*'] },
          { property: 'limit', args: [1] }
        ]
      }
    }
  },
  'deno-executor': {
    'simple-test': {
      description: 'Test Deno execution with simple task',
      payload: {
        taskName: 'simple-test',
        taskRunId: 'test-run-' + Date.now(),
        stackRunId: 'stack-run-' + Date.now()
      }
    }
  },
  'simple-stack-processor': {
    'test-boot': {
      description: 'Test simple stack processor boot',
      payload: {
        trigger: 'process-next'
      }
    }
  }
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
    testName: null,
    baseUrl: process.env.SUPABASE_URL || DEFAULT_BASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || DEFAULT_SERVICE_KEY,
    verbose: false,
    customPayload: null,
    listTests: false
  };
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--function' && args[i + 1]) {
      options.functionName = args[i + 1];
      i++;
    } else if (args[i] === '--test' && args[i + 1]) {
      options.testName = args[i + 1];
      i++;
    } else if (args[i] === '--url' && args[i + 1]) {
      options.baseUrl = args[i + 1];
      i++;
    } else if (args[i] === '--payload' && args[i + 1]) {
      try {
        options.customPayload = JSON.parse(args[i + 1]);
      } catch (e) {
        console.error('❌ Invalid JSON payload:', e.message);
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--payload-file' && args[i + 1]) {
      try {
        const payloadFile = args[i + 1];
        if (!existsSync(payloadFile)) {
          console.error(`❌ Payload file not found: ${payloadFile}`);
          process.exit(1);
        }
        options.customPayload = JSON.parse(readFileSync(payloadFile, 'utf8'));
      } catch (e) {
        console.error('❌ Error reading payload file:', e.message);
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--verbose') {
      options.verbose = true;
    } else if (args[i] === '--list-tests') {
      options.listTests = true;
    }
  }
  
  return options;
}

function showHelp() {
  console.log(`
Edge Function Tester

Usage: npm run test:function -- [options]

Options:
  --function <name>       Function to test (required unless --list-tests)
  --test <name>          Test to run (required unless --list-tests or --payload)
  --url <url>            Base URL (default: ${DEFAULT_BASE_URL})
  --payload <json>       Custom JSON payload
  --payload-file <file>  Load payload from file
  --verbose              Enable verbose logging
  --list-tests           List all available tests
  --help, -h             Show this help

Examples:
  npm run test:function -- --list-tests
  npm run test:function -- --function wrappedgapi --test echo
  npm run test:function -- --function wrappedgapi --test test-domains --verbose
  npm run test:function -- --function quickjs --payload '{"taskCode":"module.exports = async function() { return {test: true}; }"}'
`);
}

function listTests() {
  console.log('📋 Available tests:\n');
  
  for (const [functionName, tests] of Object.entries(TEST_DEFINITIONS)) {
    console.log(`🔧 ${functionName}:`);
    for (const [testName, testDef] of Object.entries(tests)) {
      console.log(`  • ${testName} - ${testDef.description}`);
    }
    console.log();
  }
}

// Function tester class
class FunctionTester {
  constructor(options) {
    this.options = options;
    this.baseUrl = options.baseUrl.replace(/\/functions\/v1$/, '') + '/functions/v1';
  }

  async runTest() {
    const { functionName, testName, customPayload, verbose } = this.options;
    
    console.log(`🧪 Testing function: ${functionName}`);
    
    let payload;
    let testDescription;
    
    if (customPayload) {
      payload = customPayload;
      testDescription = 'Custom payload';
    } else {
      const functionTests = TEST_DEFINITIONS[functionName];
      if (!functionTests) {
        console.error(`❌ No tests defined for function: ${functionName}`);
        console.log('Available functions:', Object.keys(TEST_DEFINITIONS).join(', '));
        process.exit(1);
      }
      
      const testDef = functionTests[testName];
      if (!testDef) {
        console.error(`❌ Test not found: ${testName}`);
        console.log('Available tests for', functionName + ':', Object.keys(functionTests).join(', '));
        process.exit(1);
      }
      
      payload = testDef.payload;
      testDescription = testDef.description;
    }
    
    console.log(`📝 Test: ${testDescription}`);
    
    if (verbose) {
      console.log('📤 Request payload:');
      console.log(JSON.stringify(payload, null, 2));
    }
    
    const url = `${this.baseUrl}/${functionName}`;
    console.log(`🌐 URL: ${url}`);
    
    const startTime = Date.now();
    
    try {
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
      
      console.log(`⏱️  Duration: ${duration}ms`);
      console.log(`📊 Status: ${response.status} ${response.statusText}`);
      
      if (verbose) {
        console.log('📥 Response headers:');
        for (const [key, value] of response.headers.entries()) {
          console.log(`  ${key}: ${value}`);
        }
      }
      
      console.log('📥 Response body:');
      try {
        const jsonResponse = JSON.parse(responseText);
        console.log(JSON.stringify(jsonResponse, null, 2));
      } catch (e) {
        console.log(responseText);
      }
      
      if (response.ok) {
        console.log('✅ Test passed!');
      } else {
        console.log('❌ Test failed!');
        process.exit(1);
      }
      
    } catch (error) {
      console.error('❌ Request failed:', error.message);
      process.exit(1);
    }
  }
}

// Main execution
async function main() {
  const options = parseArgs();
  
  if (options.listTests) {
    listTests();
    return;
  }
  
  if (!options.functionName) {
    console.error('❌ Function name is required. Use --function <name>');
    console.error('Use --list-tests to see available functions and tests');
    process.exit(1);
  }
  
  if (!options.testName && !options.customPayload) {
    console.error('❌ Test name or custom payload is required.');
    console.error('Use --test <name> or --payload <json>');
    console.error(`Use --list-tests to see available tests for ${options.functionName}`);
    process.exit(1);
  }
  
  const tester = new FunctionTester(options);
  await tester.runTest();
}

// Run main function if this file is executed directly
main().catch(console.error);
