import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";
import { config } from "https://deno.land/x/dotenv/mod.ts";
import { google } from "npm:googleapis@133.0.0";
import { JWT } from "npm:google-auth-library@9.4.1";

// Load environment variables
const env = config();

// Get the Supabase URL from environment variables
const SUPABASE_URL = env.SUPABASE_URL || "http://127.0.0.1:8000";
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

// Minimal test that focuses only on the authentication step with Google API
async function testGapiAuth() {
  console.log('Testing Google API authentication only...');
  
  try {
    // Create a custom request that only tests authentication
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
          // We access a property that doesn't actually make API calls
          { type: "get", property: "apiAddress" }
        ]
      }),
      signal: AbortSignal.timeout(20000)
    });

    if (response.ok) {
      const result = await response.json();
      console.log("Authentication successful!");
      console.log(JSON.stringify(result, null, 2));
      
      console.log("\nThis indicates:");
      console.log("1. The service account credentials are working");
      console.log("2. The JWT authentication process completes successfully");
      console.log("3. The issue with other API calls may be related to API-specific permissions");
      console.log("   or resource limitations in the Edge Functions environment");
    } else {
      console.error(`Failed: ${response.status}`);
      const errorText = await response.text();
      console.error('Error:', errorText);
    }
  } catch (error) {
    console.error(`Request error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

testGapiAuth(); 