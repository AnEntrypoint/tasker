import { config } from "https://deno.land/x/dotenv/mod.ts";

// Load environment variables
const env = config();

// Get the Supabase URL from environment variables
const SUPABASE_URL = env.SUPABASE_URL || "http://127.0.0.1:8000";
const GAPI_WRAPPER_URL = `${SUPABASE_URL}/functions/v1/wrappedgapi`;

console.log('Using Supabase URL:', SUPABASE_URL);
console.log('GAPI Wrapper URL:', GAPI_WRAPPER_URL);

// Simple direct fetch to the API to test basic connectivity
async function testGapiConnectivity() {
  console.log('\nTesting direct connectivity to wrappedgapi...');
  
  try {
    // Send a simple OPTIONS request to test CORS and basic connectivity
    const optionsResponse = await fetch(GAPI_WRAPPER_URL, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'http://localhost:3000', // Simulate a CORS request
        'Access-Control-Request-Method': 'POST'
      }
    });
    
    console.log('OPTIONS response status:', optionsResponse.status);
    console.log('OPTIONS response headers:', Object.fromEntries(optionsResponse.headers.entries()));
    
    // Try a POST request with a simple payload to test basic functionality
    const postResponse = await fetch(GAPI_WRAPPER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_ANON_KEY,
        'X-Debug-Mode': 'true'
      },
      body: JSON.stringify({
        method: 'echo', // Simple method that should just echo back
        args: [{
          message: 'Hello from test-gapi-simple.ts',
          timestamp: new Date().toISOString()
        }]
      })
    });
    
    console.log('POST response status:', postResponse.status);
    
    if (postResponse.ok) {
      const data = await postResponse.json();
      console.log('POST response data:', JSON.stringify(data, null, 2));
    } else {
      console.error('POST response error:', await postResponse.text());
    }
    
  } catch (error) {
    console.error('Error testing GAPI connectivity:', error);
  }
}

// Run test with some delay to ensure services are up
await new Promise(resolve => setTimeout(resolve, 2000));
await testGapiConnectivity(); 