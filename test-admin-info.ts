// Minimal test for admin customer info (much lighter than domains.list)
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

async function testCustomerInfo() {
  console.log('Testing Google Admin API customer info (minimal version)');
  
  // Use hardcoded admin email to reduce overhead
  const adminEmail = "admin@coas.co.za";
  
  try {
    // Direct API call with minimal processing
    console.time('customer-info');
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
          { type: "call", property: "get", args: [{ customerKey: adminEmail }] }
        ]
      }),
      signal: AbortSignal.timeout(15000)
    });
    console.timeEnd('customer-info');

    if (response.ok) {
      const result = await response.json();
      console.log("API call successful!");
      console.log(JSON.stringify(result, null, 2));
      
      console.log("\nIf this worked but domains.list doesn't:");
      console.log("- The customer.get API is likely less CPU-intensive than domains.list");
      console.log("- Try running with 'supabase functions serve --no-verify-jwt --env-file .env' for more resources");
      console.log("- The Edge Functions environment may have CPU limits affecting domains.list");
    } else {
      console.error(`Failed: ${response.status}`);
      const errorText = await response.text();
      console.error('Error:', errorText);
    }
  } catch (error) {
    console.error(`Request error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

testCustomerInfo(); 