import { createServiceProxy } from 'npm:sdk-http-wrapper@1.0.10/client';
import { config } from 'https://deno.land/x/dotenv/mod.ts';

// Load environment variables
const env = config();

async function testConnection(url: string): Promise<boolean> {
  try {
    console.log(`Testing connection to ${url}...`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    console.log(`Connection to ${url}: ${response.status} ${response.statusText}`);
    return response.ok;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Connection to ${url} failed:`, errorMessage);
    return false;
  }
}

// Define multiple possible Supabase URLs to try
const possibleUrls = [
  env.SUPABASE_URL,
  Deno.env.get("SUPABASE_URL"),
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://kong:8000"
];

// Try each URL until one works
async function findWorkingUrl(): Promise<string> {
  console.log("Detecting Supabase URL...");
  
  for (const url of possibleUrls) {
    if (!url) continue;
    
    // First try the wrappedgapi health endpoint
    const gapiHealthUrl = `${url}/functions/v1/wrappedgapi/health`;
    const gapiWorks = await testConnection(gapiHealthUrl);
    
    if (gapiWorks) {
      console.log(`Found working GAPI URL: ${url}`);
      return url;
    }
    
    // Fall back to keystore if available
    const keystoreUrl = `${url}/functions/v1/wrappedkeystore/health`;
    const keystoreWorks = await testConnection(keystoreUrl);
    
    if (keystoreWorks) {
      console.log(`Found working keystore URL: ${url}`);
      return url;
    }
  }
  
  console.error("Could not find a working Supabase URL!");
  // Default to localhost for now
  return "http://localhost:8000";
}

async function runTest() {
  try {
    const supabaseUrl = await findWorkingUrl();
    const gapiWrapperUrl = `${supabaseUrl}/functions/v1/wrappedgapi`;
    
    console.log('Starting GAPI connectivity test...');
    console.log('Using Supabase URL:', supabaseUrl);
    console.log('GAPI Wrapper URL:', gapiWrapperUrl);
    
    // Create the GAPI service proxy with proper auth
    const gapi = createServiceProxy('gapi', {
      baseUrl: gapiWrapperUrl,
      headers: {
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      }
    });
    
    // First, try a connection test with echo endpoint
    console.log('Testing basic connectivity with echo...');
    try {
      const echoResponse = await gapi.echo({message: "Hello GAPI!"});
      console.log('Echo response:', echoResponse);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Echo test failed:', errorMessage);
    }
    
    console.log('\nStep 1: Checking credentials...');
    const credentialStatus = await gapi.checkCredentials();
    console.log('Credential status:', JSON.stringify(credentialStatus, null, 2));

    if (!credentialStatus.credentialsOk) {
      console.error('❌ Google API credentials are not properly set up.');
      console.log('Please ensure GAPI_KEY and GAPI_ADMIN_EMAIL are set in the keystore.');
      return;
    }
    
    // First get the admin email to use as customer parameter
    const adminEmail = credentialStatus.adminEmail;
    console.log(`Using admin email as customer: ${adminEmail}`);
    
    console.log('\nStep 2: Testing users.list with real API...');
    console.time('users.list');
    const usersResult = await gapi.admin.users.list({
      customer: adminEmail,
      maxResults: 5
    });
    console.timeEnd('users.list');
    console.log('Users result:', JSON.stringify(usersResult, null, 2));
    
    console.log('\nStep 3: Testing domains.list with real API...');
    console.time('domains.list');
    const domainsResult = await gapi.admin.domains.list({
      customer: adminEmail
    });
    console.timeEnd('domains.list');
    console.log('Domains result:', JSON.stringify(domainsResult, null, 2));
    
    console.log('\nAll tests completed successfully! Real Google API connection confirmed.');
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : 'No stack trace available';
    console.error('Error during test:', errorMessage);
    console.error('Stack trace:', stack);
  }
}

runTest(); 