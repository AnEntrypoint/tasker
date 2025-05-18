#!/usr/bin/env deno run --allow-read --allow-env --allow-net
import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";
import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

// Load environment variables
config({ export: true });

// Check for required environment variables
const SUPABASE_URL = Deno.env.get("EXT_SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("EXT_SUPABASE_ANON_KEY") || "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing required environment variables: EXT_SUPABASE_URL, EXT_SUPABASE_ANON_KEY");
  Deno.exit(1);
}

// Create a service proxy to the tasks service
const tasks = createServiceProxy('tasks', {
  baseUrl: `${SUPABASE_URL}/functions/v1/tasks`,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'apikey': SUPABASE_ANON_KEY
  }
});

/**
 * Test a specific promise pattern
 */
async function testPattern(pattern: string) {
  console.log(`\n=== Testing '${pattern}' promise pattern ===\n`);
  
  try {
    // Call the task with the specified pattern
    const result = await tasks.execute('promise-handling-example', { pattern });
    
    // Print the result
    console.log(`\nResult for '${pattern}' pattern:`);
    console.log(JSON.stringify(result, null, 2));
    
    return true;
  } catch (error: unknown) {
    console.error(`Error testing '${pattern}' pattern: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  // Arrays of promise patterns to test
  const patterns = ['sequential', 'parallel', 'error', 'chained'];
  
  // Test each pattern
  for (const pattern of patterns) {
    const success = await testPattern(pattern);
    if (!success) {
      console.error(`Failed to test '${pattern}' pattern`);
    }
  }
  
  console.log("\n=== All tests completed ===");
}

// Run the main function if this script is executed directly
if (import.meta.main) {
  main().catch(error => {
    console.error(`Unhandled error: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  });
} 