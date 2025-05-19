// Test GAPI health and token cache status
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

async function testGapiHealth() {
  console.log('Testing Google API health and token cache status\n');
  
  try {
    // Check health endpoint
    console.log('1. Checking health endpoint...');
    const healthResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedgapi/health", {
      method: "GET",
      headers: { 
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_ANON_KEY
      }
    });

    if (healthResponse.ok) {
      const health = await healthResponse.json();
      console.log(`Health status: ${health.status}`);
      console.log(`Cache size: ${health.cache_size}`);
      console.log(`Timestamp: ${health.timestamp}\n`);
    } else {
      console.error(`Failed to get health info: ${healthResponse.status}`);
    }

    // Check credentials
    console.log('2. Checking credentials...');
    const credsResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedgapi", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        method: "checkCredentials"
      })
    });

    if (credsResponse.ok) {
      const creds = await credsResponse.json();
      console.log(`Credentials status: ${creds.status}`);
      console.log(`Admin email: ${creds.adminEmail}`);
      console.log(`Service account: ${creds.clientEmail}\n`);
    } else {
      console.error(`Failed to check credentials: ${credsResponse.status}`);
    }

    // Check token info
    console.log('3. Checking token cache...');
    const tokenResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedgapi", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        method: "getTokenInfo"
      })
    });

    if (tokenResponse.ok) {
      const tokens = await tokenResponse.json();
      console.log(`Number of cached tokens: ${tokens.count}`);
      
      if (tokens.tokens?.length > 0) {
        console.log('\nToken details:');
        tokens.tokens.forEach((token: any, i: number) => {
          console.log(`Token ${i+1}:`);
          console.log(`- Scope: ${token.scope}`);
          console.log(`- Expires: ${token.expires}`);
          console.log(`- Valid: ${token.valid}`);
        });
      } else {
        console.log('No tokens in cache.');
      }
    } else {
      console.error(`Failed to get token info: ${tokenResponse.status}`);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

testGapiHealth(); 