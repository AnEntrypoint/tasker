// Direct domains test using the new optimized endpoint
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

/**
 * This test uses the ultra-optimized direct domains.list implementation
 * that bypasses the SDK wrapper system to reduce overhead
 */
async function testDirectDomains() {
  console.log('Testing optimized direct domains API approach...');
  
  try {
    console.time('direct-domains');
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
          { type: "call", property: "list", args: [{ customer: "admin@coas.co.za" }] }
        ]
      }),
      signal: AbortSignal.timeout(30000)
    });
    console.timeEnd('direct-domains');

    if (response.ok) {
      const result = await response.json();
      console.log('SUCCESS! Domains retrieved successfully');
      console.log(`Found ${result.domains?.length || 0} domains:`);
      
      if (result.domains?.length) {
        result.domains.forEach((domain: any, i: number) => {
          console.log(`  ${i+1}. ${domain.domainName} (${domain.verified ? 'verified' : 'unverified'})`);
        });
      }
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
testDirectDomains(); 