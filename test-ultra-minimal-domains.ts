// Ultra-minimal domains test for the final implementation
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

async function testUltraMinimalDomains() {
  console.log('Testing ultra-minimal domains implementation...');
  
  try {
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

    if (response.ok) {
      const result = await response.json();
      console.log('SUCCESS!');
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Failed: ${response.status}`);
      try {
        const errorText = await response.text();
        console.error('Error details:', errorText);
      } catch (e) {
        console.error('Could not read error details');
      }
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

testUltraMinimalDomains(); 