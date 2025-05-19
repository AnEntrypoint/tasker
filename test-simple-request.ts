// Ultra-simple direct API call with pre-calculated access token
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

/**
 * Test direct API connection without any middleware using pre-calculated access token
 */
async function testWithAccessToken() {
  console.log('Testing with direct API call');
  
  try {
    // First get access token from the wrappedgapi service
    console.log('Getting access token through the Edge Function...');
    const tokenResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedgapi", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        method: "getAccessToken",
        args: []
      }),
      signal: AbortSignal.timeout(20000)
    });
    
    if (!tokenResponse.ok) {
      throw new Error(`Failed to get access token: ${tokenResponse.status}`);
    }
    
    const tokenData = await tokenResponse.json();
    console.log('Access token retrieved');
    
    // Now make a direct API call to Google
    console.log('Making direct API call to Google Domains API...');
    console.time('api-call');
    
    // Hard-coded values for simplicity
    const adminEmail = "admin@coas.co.za";
    const domainsUrl = `https://admin.googleapis.com/admin/directory/v1/customer/${encodeURIComponent(adminEmail)}/domains`;
    
    const response = await fetch(domainsUrl, {
      headers: {
        'Authorization': `Bearer ${tokenData.accessToken}`,
        'Accept': 'application/json'
      }
    });
    console.timeEnd('api-call');
    
    if (response.ok) {
      const result = await response.json();
      console.log('\nSUCCESS! Domains retrieved:');
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Failed: ${response.status}`);
      const errorText = await response.text();
      console.error('Error details:', errorText);
    }
    
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Unknown error: ${String(error)}`);
    }
  }
}

testWithAccessToken(); 