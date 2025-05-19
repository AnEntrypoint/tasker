// Updated test script that works with the fixed wrappedgapi service
import { config } from 'https://deno.land/x/dotenv/mod.ts';

console.log('\n=== GAPI Connection Test ===\n');
console.log('This script tests Google API connectivity with detailed error reporting.');

// First, check URLs for better diagnostics
const urls = [
  'http://127.0.0.1:8000/functions/v1/wrappedgapi/health',
  'http://localhost:8000/functions/v1/wrappedgapi/health',
  'https://www.googleapis.com/discovery/v1/apis',
];

console.log('\nTesting basic connectivity...');
for (const url of urls) {
  try {
    console.log(`Checking ${url}...`);
    const res = await fetch(url, {signal: AbortSignal.timeout(5000)});
    console.log(`  Status: ${res.status} ${res.statusText}`);
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`  Failed: ${errorMsg}`);
  }
}

console.log('\nTesting credential check...');
const env = config();
try {
  const url = 'http://127.0.0.1:8000/functions/v1/wrappedgapi';
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      method: 'checkCredentials',
      args: []
    }),
    signal: AbortSignal.timeout(10000)
  });
  
  if (res.ok) {
    const data = await res.json();
    console.log('\nCredential check successful:');
    console.log(`  Admin email: ${data.adminEmail || 'Not found'}`);
    console.log(`  Client email: ${data.clientEmail || 'Not found'}`);
    console.log(`  GAPI_KEY found: ${data.gapiKeyExists || false}`);
    console.log(`  Credentials valid: ${data.credentialsOk || false}`);
  } else {
    console.log(`Credential check failed with status ${res.status}`);
    try {
      const text = await res.text();
      console.log(`Error: ${text}`);
    } catch {
      console.log('Could not read error details');
    }
  }
} catch (error: unknown) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  console.log(`Credential check error: ${errorMsg}`);
}

console.log('\n=== Diagnosis ===\n');
console.log('1. If health check fails: Your Supabase Edge Functions may not be running.');
console.log('   Solution: Run "supabase functions serve --no-verify-jwt" in a separate terminal.');
console.log('\n2. If Google APIs connectivity fails: Check your network or proxy settings.');
console.log('   Solution: Ensure your network allows outbound HTTPS connections to Google APIs.');
console.log('\n3. If credential check fails: Your GAPI credentials may be invalid or missing.');
console.log('   Solution: Check that GAPI_KEY and GAPI_ADMIN_EMAIL are set properly in the keystore.');
console.log('\n4. If API calls timeout: The Google API authentication process may be slow or failing.');
console.log('   Solution: Verify credentials are correct and that your service account has proper permissions.');
console.log('\nFor further debugging, check the Edge Function logs by running:');
console.log('supabase functions logs wrappedgapi'); 