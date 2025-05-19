// Ultra-minimal Google API test 
import { config } from 'https://deno.land/x/dotenv/mod.ts';
import { JWT } from "npm:google-auth-library@9.4.1";
const env = config();

// Hard-coded values to minimize overhead
const ADMIN_EMAIL = "admin@coas.co.za";

// This test directly uses the Google API credentials without any wrapping
// to determine if the issue is with the Edge Function or credentials/permissions
async function testDirectMinimal() {
  console.log('Testing direct Google API access without Edge Functions');
  
  // 1. First get credentials from keystore
  console.log('Retrieving credentials from keystore...');
  try {
    const keystoreUrl = `${env.SUPABASE_URL || 'http://127.0.0.1:8000'}/functions/v1/wrappedkeystore`;
    const credResponse = await fetch(keystoreUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        method: "getKey",
        args: ["global", "GAPI_KEY"]
      })
    });
    
    if (!credResponse.ok) {
      throw new Error(`Failed to get credentials: ${credResponse.status}`);
    }
    
    const credString = await credResponse.text();
    const creds = JSON.parse(credString);
    console.log('Credentials retrieved successfully');
    
    // 2. Create JWT client
    console.log('Creating JWT client...');
    const jwtClient = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: [
        'https://www.googleapis.com/auth/admin.directory.domain.readonly',
        'https://www.googleapis.com/auth/admin.directory.customer.readonly'
      ],
      subject: ADMIN_EMAIL
    });
    
    // 3. Authorize (this is the part that might be slow/CPU-intensive)
    console.log('Authorizing with Google (this might take a moment)...');
    console.time('auth');
    await jwtClient.authorize();
    console.timeEnd('auth');
    console.log('Successfully authenticated with Google!');
    
    // 4. Make direct API call 
    console.log('\nMaking API call to customer info endpoint...');
    console.time('api-call');
    const customerUrl = `https://admin.googleapis.com/admin/directory/v1/customers/my_customer`;
    const response = await fetch(customerUrl, {
      headers: {
        'Authorization': `Bearer ${jwtClient.credentials.access_token}`,
        'Accept': 'application/json'
      }
    });
    console.timeEnd('api-call');
    
    if (response.ok) {
      const result = await response.json();
      console.log('\nSUCCESS! Customer info:');
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Failed: ${response.status}`);
      const errorText = await response.text();
      console.error('Error details:', errorText);
    }
    
  } catch (error) {
    console.error(`Error: ${error.message}`);
    if (error.stack) console.error(error.stack);
  }
}

testDirectMinimal(); 