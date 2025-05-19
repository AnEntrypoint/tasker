// Direct customer test using the optimized direct endpoint
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

/**
 * This test uses the ultra-optimized direct customers.get implementation
 * that bypasses the SDK wrapper system to reduce overhead
 */
async function testDirectCustomer() {
  console.log('Testing optimized direct customer API approach...');
  
  try {
    console.time('direct-customer');
    const response = await fetch("http://127.0.0.1:8000/functions/v1/wrappedgapi", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        chain: [
          { type: "get", property: "admin" },
          { type: "get", property: "customers" },
          { type: "call", property: "get", args: [{ customerKey: "admin@coas.co.za" }] }
        ]
      }),
      signal: AbortSignal.timeout(30000)
    });
    console.timeEnd('direct-customer');

    if (response.ok) {
      const result = await response.json();
      console.log('SUCCESS! Customer info retrieved successfully');
      console.log('Customer Details:');
      console.log(`  ID: ${result.id}`);
      console.log(`  Name: ${result.customerDomain}`);
      console.log(`  Creation Time: ${result.creationTime}`);
      console.log(`  Customer Type: ${result.customerType}`);
    } else {
      console.error(`Failed with status: ${response.status}`);
      try {
        const errorText = await response.text();
        console.error('Error details:', errorText);
      } catch (e) {
        console.error('Could not read error details');
      }
    }
  } catch (error) {
    console.error(`Request error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Run the test immediately
testDirectCustomer(); 