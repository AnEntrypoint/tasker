import { config } from "https://deno.land/x/dotenv/mod.ts";
import { createServiceProxy } from 'npm:sdk-http-wrapper@1.0.10/client';

// Load environment variables
const env = config();

// Get the Supabase URL from environment variables
const SUPABASE_URL = env.SUPABASE_URL || "http://localhost:8000";
const GAPI_WRAPPER_URL = `${SUPABASE_URL}/functions/v1/wrappedgapi`;

console.log('Using Supabase URL:', SUPABASE_URL);
console.log('GAPI Wrapper URL:', GAPI_WRAPPER_URL);

// Create the GAPI service proxy with detailed debug info
const gapi = createServiceProxy('gapi', {
    baseUrl: GAPI_WRAPPER_URL,
    headers: {
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
      'apikey': env.SUPABASE_ANON_KEY,
      'X-Debug-Mode': 'true' // Request additional debugging info
    }
});

// Create keystore service proxy
const keystore = createServiceProxy('keystore', {
  baseUrl: `${SUPABASE_URL}/functions/v1/wrappedkeystore`,
  headers: {
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
    'apikey': env.SUPABASE_ANON_KEY
  }
});

let adminEmail: string | null = null;

async function checkKeystore() {
  console.log('\nChecking keystore for GAPI credentials...');
  
  try {
    // Check if GAPI credentials exist
    const adminEmailExists = await keystore.hasKey('global', 'GAPI_ADMIN_EMAIL');
    console.log('GAPI_ADMIN_EMAIL exists:', adminEmailExists);
    
    if (adminEmailExists) {
      adminEmail = await keystore.getKey('global', 'GAPI_ADMIN_EMAIL');
      console.log('GAPI_ADMIN_EMAIL value:', adminEmail);
    }
    
    const gapiKeyExists = await keystore.hasKey('global', 'GAPI_KEY');
    console.log('GAPI_KEY exists:', gapiKeyExists);
    
    // Explicitly check the credential structure
    if (gapiKeyExists) {
      try {
        const gapiKey = await keystore.getKey('global', 'GAPI_KEY');
        if (gapiKey) {
          const creds = JSON.parse(gapiKey);
          console.log('GAPI credentials are valid:');
          console.log('- client_email:', creds.client_email);
          console.log('- private_key exists:', !!creds.private_key);
        }
      } catch (e) {
        console.error('Error parsing GAPI_KEY:', e);
      }
    }
    
    return adminEmailExists && gapiKeyExists;
  } catch (error) {
    console.error('Error checking keystore:', error);
    return false;
  }
}

async function runUserTest() {
  console.log('\nTesting wrappedgapi via SDK Proxy (List Users)...');
  
  try {
    if (!adminEmail) {
      console.warn('No admin email available. Please make sure GAPI_ADMIN_EMAIL is set in the keystore.');
      return;
    }
    
    console.log('Calling gapi.admin.users.list via proxy...');
    console.log('Parameters:', { customer: adminEmail, maxResults: 5 });
    
    // Add timeout to avoid hanging
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Client-side timeout after 30 seconds')), 30000);
    });
    
    const resultPromise = gapi.admin.users.list({
        customer: adminEmail,
        maxResults: 5
    });
    
    const result = await Promise.race([resultPromise, timeoutPromise]);

    console.log('SDK Proxy response (users.list):');
    
    // Check the structure returned directly from the Google API
    if (result?.users && Array.isArray(result.users)) {
        if (result.users.length > 0) {
            console.log(`Successfully listed ${result.users.length} users.`);
            console.log(`First user email: ${result.users[0].primaryEmail}`); 
        } else {
            console.log('API call successful, but no users found in the domain.');
        }
    } else if (result?.kind === 'admin#directory#users') {
        // Handle case where kind exists but users array might be missing/empty
        console.log('API call successful, but no users array found or array is empty.');
        console.log('Full response data:', JSON.stringify(result, null, 2));
    } else {
        console.warn('API call successful, but unexpected data structure received.');
        console.log('Full response data:', JSON.stringify(result, null, 2));
    }

  } catch (error) {
    console.error('Error testing wrappedgapi (users.list) via SDK Proxy:', error);
    // sdk-http-wrapper throws errors directly, often including status and response body
    if (typeof error === 'object' && error !== null && 'response' in error && 
        typeof error.response === 'object' && error.response !== null && 'data' in error.response) {
        console.error('Error details from proxy:', JSON.stringify((error.response as any).data, null, 2));
    }
  }
}

async function runDomainTest() {
  console.log('\nTesting wrappedgapi via SDK Proxy (List Domains)...');

  try {
    if (!adminEmail) {
      console.warn('No admin email available. Please make sure GAPI_ADMIN_EMAIL is set in the keystore.');
      return;
    }
    
    console.log('Calling gapi.admin.domains.list via proxy...');
    console.log('Parameters:', { customer: adminEmail });
    
    // Add timeout to avoid hanging
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Client-side timeout after 30 seconds')), 30000);
    });
    
    const resultPromise = gapi.admin.domains.list({
        customer: adminEmail
    });
    
    const result = await Promise.race([resultPromise, timeoutPromise]);

    console.log('SDK Proxy response (domains.list):');

    if (result?.domains && Array.isArray(result.domains)) {
         if (result.domains.length > 0) {
            console.log(`Successfully listed ${result.domains.length} domain(s).`);
            console.log(`First domain: ${result.domains[0].domainName}`);
         } else {
             console.log('API call successful, but no domains found for this customer.');
         }
    } else if (result?.kind === 'admin#directory#domains') {
        console.log('API call successful, but no domains array found or array is empty.');
        console.log('Full response data:', JSON.stringify(result, null, 2));
    } else {
        console.warn('API call successful, but unexpected data structure received.');
        console.log('Full response data:', JSON.stringify(result, null, 2));
    }

  } catch (error) {
    console.error('Error testing wrappedgapi (domains.list) via SDK Proxy:', error);
    if (typeof error === 'object' && error !== null && 'response' in error && 
        typeof error.response === 'object' && error.response !== null && 'data' in error.response) {
        console.error('Error details from proxy:', JSON.stringify((error.response as any).data, null, 2));
    }
  }
}

async function checkGapiCredentials() {
  try {
    console.log('\nTesting wrappedgapi checkCredentials method...');
    const credentialsStatus = await gapi.checkCredentials();
    console.log('Credentials status:', JSON.stringify(credentialsStatus, null, 2));
    return credentialsStatus;
  } catch (error) {
    console.error('Error checking GAPI credentials:', error);
    return null;
  }
}

// Check credentials and run tests
(async () => {
  console.log('=== Google API Integration Test ===');
  
  // Add delay before tests to ensure Supabase function is ready
  await new Promise((resolve) => setTimeout(resolve, 3000));
  
  // Check keystore first
  const credentialsExist = await checkKeystore();
  
  if (!credentialsExist) {
    console.log('\n⚠️ Warning: GAPI credentials not found in keystore.');
    console.log('Please run set-gapi-credentials.ts first to set up credentials.');
    return; // Exit early if credentials don't exist
  }
  
  // Check credentials in GAPI service
  await checkGapiCredentials();
  
  // Run tests sequentially to avoid issues with concurrent API calls
  await runUserTest();
  await runDomainTest();
  
  console.log('\n=== Test Complete ===');
})(); 