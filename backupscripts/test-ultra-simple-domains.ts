// Ultra-simple direct domains list test with minimal overhead
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

/**
 * Extremely simplified test that makes a direct call to the domains.list endpoint
 * with the corrected admin email and minimal processing to avoid CPU limits
 */
async function testUltraSimpleDomains() {
  console.log('Starting ultra-simple domains test...');
  
  try {
    // Make the call with minimal options and the shortest path
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
          { type: "get", property: "domains" },
          { type: "call", property: "list", args: [{ customer: "my_customer", maxResults: 5 }] }
        ]
      }),
      signal: AbortSignal.timeout(60000) // 60-second timeout
    });

    if (response.ok) {
      const result = await response.json();
      console.log("Success! Domains found:", result.domains?.length || 0);
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Failed: ${response.status}`);
      const errorText = await response.text();
      console.error('Error:', errorText);
    }
  } catch (error) {
    console.error(`Request error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Run the test immediately
testUltraSimpleDomains(); 