import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";
import { config } from "https://deno.land/x/dotenv/mod.ts";

// Load environment variables
const env = config();

// Get the Supabase URL from environment variables
const SUPABASE_URL = env.SUPABASE_URL || "http://127.0.0.1:8000";

console.log('=== Test Environment ===');
console.log('Using Supabase URL:', SUPABASE_URL);
console.log('SUPABASE_SERVICE_ROLE_KEY available:', !!env.SUPABASE_SERVICE_ROLE_KEY);
console.log('EXT_SUPABASE_SERVICE_ROLE_KEY available:', !!env.EXT_SUPABASE_SERVICE_ROLE_KEY);
console.log('SUPABASE_ANON_KEY available:', !!env.SUPABASE_ANON_KEY);

// Create keystore service proxy (using EXACT same config as test-live-keystore.ts)
const keystore = createServiceProxy('keystore', {
  baseUrl: `${SUPABASE_URL}/functions/v1/wrappedkeystore`,
  headers: {
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
    'apikey': env.SUPABASE_ANON_KEY
  }
});

// Create gapi service proxy using same config structure
const gapi = createServiceProxy('gapi', {
  baseUrl: `${SUPABASE_URL}/functions/v1/wrappedgapi`,
  headers: {
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
    'apikey': env.SUPABASE_ANON_KEY
  }
});

async function testKeystoreDirectly() {
  console.log('\n\n=== Testing Keystore Service Directly ===');
  
  try {
    // Test server time first (simple sanity check)
    console.log('\n1. Getting server time...');
    const time = await keystore.getServerTime();
    console.log('Server time:', time);
    
    // Check GAPI_ADMIN_EMAIL 
    console.log('\n2. Checking GAPI_ADMIN_EMAIL...');
    const adminEmailExists = await keystore.hasKey('global', 'GAPI_ADMIN_EMAIL');
    console.log('GAPI_ADMIN_EMAIL exists:', adminEmailExists);
    
    if (adminEmailExists) {
      const adminEmail = await keystore.getKey('global', 'GAPI_ADMIN_EMAIL');
      console.log('GAPI_ADMIN_EMAIL value:', adminEmail);
    }
    
    // Check GAPI_KEY
    console.log('\n3. Checking GAPI_KEY...');
    const gapiKeyExists = await keystore.hasKey('global', 'GAPI_KEY');
    console.log('GAPI_KEY exists:', gapiKeyExists);
    
    if (gapiKeyExists) {
      const gapiKey = await keystore.getKey('global', 'GAPI_KEY');
      if (gapiKey) {
        console.log('GAPI_KEY length:', gapiKey.length);
        
        try {
          // Verify it's valid JSON
          const credentials = JSON.parse(gapiKey);
          console.log('GAPI_KEY is valid JSON with fields:', Object.keys(credentials).join(', '));
          
          // Check if it has required service account fields
          if (credentials.client_email && credentials.private_key) {
            console.log('Service account email:', credentials.client_email);
            console.log('Private key starts with:', credentials.private_key.substring(0, 30) + '...');
          } else {
            console.error('GAPI_KEY is missing client_email or private_key fields');
          }
        } catch (e) {
          console.error('GAPI_KEY is not valid JSON:', e instanceof Error ? e.message : String(e));
        }
      } else {
        console.error('GAPI_KEY exists but returned null/undefined value');
      }
    }
    
    console.log('\nKeystore direct test completed successfully');
    
  } catch (error) {
    console.error('Error testing keystore directly:', error instanceof Error ? error.message : String(error));
    console.error('Error details:', error);
  }
}

async function testGapiEcho() {
  console.log('\n\n=== Testing GAPI Service Echo ===');
  
  try {
    // Test simple echo method (no Google API dependencies)
    console.log('\n1. Testing echo endpoint...');
    const echoResponse = await gapi.echo({ 
      message: 'Hello from test-keystore-gapi.ts',
      timestamp: new Date().toISOString()
    });
    
    console.log('Echo response:', echoResponse);
    console.log('Echo test completed successfully');
    
  } catch (error) {
    console.error('Error testing GAPI echo:', error instanceof Error ? error.message : String(error));
    console.error('Error details:', error);
  }
}

async function testGapiWithSimpleFunction() {
  console.log('\n\n=== Testing GAPI Service Keystore Access ===');
  
  try {
    // Test the checkCredentials function which should access the keystore
    console.log('\n1. Testing checkCredentials function...');
    const credentialStatus = await gapi.checkCredentials();
    
    console.log('Credential status:', credentialStatus);
    console.log('GAPI credential check completed');
    
  } catch (error) {
    console.error('Error testing GAPI credentials check:', error instanceof Error ? error.message : String(error));
    console.error('Error details:', error);
  }
}

// Run tests with delays between them
console.log('Starting tests...');
await new Promise(resolve => setTimeout(resolve, 1000));

await testKeystoreDirectly();
await new Promise(resolve => setTimeout(resolve, 1000));

await testGapiEcho();
await new Promise(resolve => setTimeout(resolve, 1000));

await testGapiWithSimpleFunction();
console.log('\nAll tests completed'); 