import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";
import { config } from "https://deno.land/x/dotenv/mod.ts";

// Load environment variables
const env = config();

// Get the Supabase URL from environment variables
const SUPABASE_URL = env.SUPABASE_URL || "http://localhost:8000";
const KEYSTORE_WRAPPER_URL = `${SUPABASE_URL}/functions/v1/wrappedkeystore`;

console.log('Using Supabase URL:', SUPABASE_URL);

// Create keystore service proxy
const keystore = createServiceProxy('keystore', {
  baseUrl: KEYSTORE_WRAPPER_URL,
  headers: {
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
    'apikey': env.SUPABASE_ANON_KEY
  }
});

async function testGapiCredentials() {
  console.log('=== Testing GAPI Credentials in Keystore ===');
  
  try {
    console.log('\n1. Testing keystore server time (sanity check)...');
    const time = await keystore.getServerTime();
    console.log('Server time:', time);
    
    console.log('\n2. Checking for GAPI_KEY in global namespace...');
    const gapiKeyExists = await keystore.hasKey('global', 'GAPI_KEY');
    console.log('GAPI_KEY exists:', gapiKeyExists);
    
    if (gapiKeyExists) {
      console.log('\n3. Getting GAPI_KEY (partial display for security)...');
      const gapiKey = await keystore.getKey('global', 'GAPI_KEY');
      
      // Only show first few characters for security
      if (gapiKey && typeof gapiKey === 'string') {
        const isTruncated = gapiKey.length > 20;
        const displayKey = gapiKey.substring(0, 20) + (isTruncated ? '...' : '');
        console.log(`GAPI_KEY retrieved (${gapiKey.length} chars): ${displayKey}`);
        
        try {
          // Try to parse as JSON to validate format
          const parsed = JSON.parse(gapiKey);
          console.log('GAPI_KEY is valid JSON with keys:', Object.keys(parsed).join(', '));
          
          // Check for required fields for Google service account credentials
          const hasClientEmail = 'client_email' in parsed;
          const hasPrivateKey = 'private_key' in parsed;
          
          console.log('Has client_email:', hasClientEmail);
          console.log('Has private_key:', hasPrivateKey);
          
          if (hasClientEmail) {
            console.log('client_email:', parsed.client_email);
          }
        } catch (e: unknown) {
          console.error('GAPI_KEY is not valid JSON:', (e as Error).message);
        }
      } else {
        console.log('GAPI_KEY retrieved but has unexpected format:', typeof gapiKey);
      }
    }
    
    console.log('\n4. Checking for GAPI_ADMIN_EMAIL in global namespace...');
    const adminEmailExists = await keystore.hasKey('global', 'GAPI_ADMIN_EMAIL');
    console.log('GAPI_ADMIN_EMAIL exists:', adminEmailExists);
    
    if (adminEmailExists) {
      console.log('\n5. Getting GAPI_ADMIN_EMAIL...');
      const adminEmail = await keystore.getKey('global', 'GAPI_ADMIN_EMAIL');
      console.log('GAPI_ADMIN_EMAIL:', adminEmail);
    }
    
  } catch (error) {
    console.error('Error testing GAPI credentials in keystore:', error);
  }
}

// Run test with initial delay to ensure service is ready
await new Promise((resolve) => setTimeout(resolve, 2000));
await testGapiCredentials(); 