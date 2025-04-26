#!/usr/bin/env -S deno run --allow-env --allow-net

import { envVars } from "./env.ts";
import * as djwt from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const {
  SUPABASE_URL: _SUP_URL,
  SUPABASE_SERVICE_ROLE_KEY: _SUP_SVC_KEY, // Need service role key for keystore
  EXT_SUPABASE_URL,
  EXT_SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY, // Add Anon key
} = envVars;

// Use EXT vars if available, otherwise use local defaults
const SUPABASE_URL = EXT_SUPABASE_URL || _SUP_URL;
const SUPABASE_SERVICE_ROLE_KEY = EXT_SUPABASE_SERVICE_ROLE_KEY || _SUP_SVC_KEY;

const KEYSTORE_URL = `${SUPABASE_URL}/functions/v1/wrappedkeystore`;
const GAPI_KEY_NAME = "GAPI_KEY";
const GAPI_KEY_NAMESPACE = "global"; // Assuming global namespace
const GAPI_ADMIN_EMAIL_KEY_NAME = "GAPI_ADMIN_EMAIL"; // Define key name

const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const GOOGLE_ADMIN_API_ENDPOINT = "https://admin.googleapis.com/admin/directory/v1";

// --- Helper: Fetch GAPI Service Account Key from Keystore ---
async function getGapiServiceAccount() {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set in environment variables.");
  }
  if (!SUPABASE_ANON_KEY) {
    // Add check for Anon key
    console.warn("SUPABASE_ANON_KEY is not set in environment variables. Keystore call might fail.");
  }
  // Use the base URL, not the specific proxy path
  console.log(`[Direct Test] Calling Keystore function: ${KEYSTORE_URL}`);

  try {
    const response = await fetch(KEYSTORE_URL, { // POST to base URL
      method: 'POST', // Use POST
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': SUPABASE_ANON_KEY || '', // Add apikey header
        'Content-Type': 'application/json', // Specify JSON body
      },
      body: JSON.stringify({ // Send action and params in body
        action: 'getKey',
        namespace: GAPI_KEY_NAMESPACE,
        key: GAPI_KEY_NAME,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Keystore request failed with status ${response.status}: ${errorText}`);
    }

    const responseText = await response.text(); // Get raw text
    let intermediateResult;
    try {
      intermediateResult = JSON.parse(responseText); // First parse (handles potential double-encoding)
    } catch (parseError) {
       console.error("[Direct Test] Failed to parse Keystore response body (1st parse):", responseText); 
       throw new Error(`Failed to parse JSON response from Keystore (1st parse): ${parseError.message}`);
    }

    let serviceAccount;
    // Check if the first parse resulted in a string (double-encoded case)
    if (typeof intermediateResult === 'string') {
      try {
        serviceAccount = JSON.parse(intermediateResult); // Second parse
      } catch (parseError) {
        console.error("[Direct Test] Failed to parse Keystore response body (2nd parse):", intermediateResult);
        throw new Error(`Failed to parse JSON response from Keystore (2nd parse): ${parseError.message}`);
      }
    } else {
      // If the first parse resulted in an object, use it directly (single-encoded case)
      serviceAccount = intermediateResult;
    }

    // Add detailed logging before the check
    console.log(`[Debug] typeof serviceAccount (final): ${typeof serviceAccount}`);
    console.log(`[Debug] serviceAccount.hasOwnProperty('private_key'): ${serviceAccount ? serviceAccount.hasOwnProperty('private_key') : 'N/A'}`);
    console.log(`[Debug] serviceAccount.private_key value: ${serviceAccount ? serviceAccount.private_key : 'N/A'}`);
    console.log(`[Debug] Object.keys(serviceAccount): ${serviceAccount ? Object.keys(serviceAccount) : 'N/A'}`);

    // Simplify check: focus on object type and private_key existence
    if (typeof serviceAccount !== 'object' || !serviceAccount.private_key) {
       console.error("[Direct Test] Keystore response body (parsed):", serviceAccount); 
       // Updated error message for clarity
       throw new Error(`Keystore response was not a valid object or missing private_key.`);
    }

    console.log("[Direct Test] Successfully fetched and parsed service account data from Keystore.");
    return serviceAccount; // Return the parsed object directly

  } catch (error) {
    console.error("[Direct Test] Error fetching/parsing from Keystore:", error);
    // Remove the specific SyntaxError check here as it's handled above
    throw new Error(`Failed to retrieve/parse GAPI key from Keystore: ${error.message}`);
  }
}

// --- Helper: Fetch GAPI Admin Email from Keystore ---
async function getGapiAdminEmail() {
  if (!SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
    throw new Error("Supabase keys (Service Role, Anon) are not set.");
  }
  console.log(`[Direct Test] Calling Keystore function for Admin Email: ${KEYSTORE_URL}`);

  try {
    const response = await fetch(KEYSTORE_URL, { 
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        action: 'getKey',
        namespace: GAPI_KEY_NAMESPACE, // Assuming global namespace
        key: GAPI_ADMIN_EMAIL_KEY_NAME,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Keystore request for Admin Email failed with status ${response.status}: ${errorText}`);
    }

    const responseText = await response.text();
    let intermediateResult;
    try {
      intermediateResult = JSON.parse(responseText); // First parse
    } catch (parseError) {
      console.warn("[Direct Test] Failed to parse Admin Email response (1st parse), assuming raw string:", responseText);
      intermediateResult = responseText; // Assume raw string if first parse fails
    }

    let adminEmail;
    if (typeof intermediateResult === 'string') {
      try {
         // Attempt second parse ONLY if it looks like JSON, otherwise use the string directly
         if (intermediateResult.trim().startsWith('{') || intermediateResult.trim().startsWith('"')) {
             adminEmail = JSON.parse(intermediateResult);
         } else {
             adminEmail = intermediateResult; // Use the string directly
         }
         // If the result of second parse is still an object, something is wrong
         if (typeof adminEmail === 'object' && adminEmail !== null) {
            console.error("[Direct Test] Admin Email from keystore parsed into an object:", adminEmail);
            throw new Error("Expected admin email string from Keystore, got object.");
         }
      } catch (parseError) {
        console.warn("[Direct Test] Failed to parse Admin Email response (2nd parse), using result of 1st parse:", intermediateResult);
        adminEmail = intermediateResult; // Fallback to result of first parse
      }
    } else {
      adminEmail = intermediateResult; // Use result of first parse if it wasn't a string
    }
    
    // Final check: ensure we have a non-empty string
    if (typeof adminEmail !== 'string' || !adminEmail) {
        console.error("[Direct Test] Invalid Admin Email received from Keystore (type or empty):", adminEmail);
        throw new Error(`Invalid Admin Email received from Keystore: ${JSON.stringify(adminEmail)}`);
    }

    console.log("[Direct Test] Successfully fetched Admin Email from Keystore.");
    return adminEmail.trim(); // Trim whitespace

  } catch (error) {
    console.error("[Direct Test] Error fetching Admin Email from Keystore:", error);
    throw new Error(`Failed to retrieve/parse GAPI Admin Email from Keystore: ${error.message}`);
  }
}

// --- Helper: Get Google OAuth2 Access Token ---
async function getGoogleAccessToken(serviceAccount, adminEmail) {
  console.log(`[Direct Test] Generating JWT assertion for Google OAuth (impersonating ${adminEmail})...`);
  const scope = "https://www.googleapis.com/auth/admin.directory.domain.readonly";
  const audience = GOOGLE_TOKEN_URI;

  if (!serviceAccount.client_email || !serviceAccount.private_key) {
     throw new Error("Service account JSON is missing client_email or private_key");
  }
  // Add check for admin email needed for impersonation
  if (!adminEmail) {
    throw new Error("Admin email is required for impersonation but was not provided.");
  }

  try {
    // Import the PEM private key into a CryptoKey
    const pemHeader = "-----BEGIN PRIVATE KEY-----";
    const pemFooter = "-----END PRIVATE KEY-----";
    const pemContents = serviceAccount.private_key
        .replace(pemHeader, "")
        .replace(pemFooter, "")
        .replace(/\s/g, ""); // Remove newlines and spaces

    const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

    const privateCryptoKey = await crypto.subtle.importKey(
        "pkcs8",
        binaryDer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        true,
        ["sign"]
    );

    const assertion = await djwt.create(
      { alg: "RS256", typ: "JWT" }, // Header
      { // Payload
        iss: serviceAccount.client_email,
        scope: scope,
        aud: audience,
        exp: djwt.getNumericDate(60 * 60), // Expires in 1 hour
        iat: djwt.getNumericDate(0), // Issued now
        sub: adminEmail, // Use passed adminEmail parameter for impersonation
      },
      privateCryptoKey // Use the imported CryptoKey
    );

    console.log("[Direct Test] JWT assertion created. Requesting access token...");

    const response = await fetch(GOOGLE_TOKEN_URI, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: assertion,
      }),
    });

    const tokenData = await response.json();

    if (!response.ok) {
      throw new Error(`Failed to get access token: ${response.status} ${response.statusText} - ${JSON.stringify(tokenData)}`);
    }

    if (!tokenData.access_token) {
        throw new Error(`Access token not found in response: ${JSON.stringify(tokenData)}`);
    }

    console.log("[Direct Test] Access token obtained successfully.");
    return tokenData.access_token;

  } catch (error) {
     console.error("[Direct Test] Error getting access token:", error);
     throw new Error(`Failed to get Google access token: ${error.message}`);
  }
}

// --- Helper: List G Suite Domains ---
async function listGSuiteDomains(accessToken) {
  const url = `${GOOGLE_ADMIN_API_ENDPOINT}/customer/my_customer/domains`;
  console.log(`[Direct Test] Calling Admin SDK Domains List: ${url}`);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const responseData = await response.json();

    if (!response.ok) {
        // Log more details on failure
        console.error(`[Direct Test] Domains.list API call failed with status ${response.status}.`);
        console.error("[Direct Test] Response Body:", JSON.stringify(responseData, null, 2));
        throw new Error(`Google Admin SDK API call failed: ${response.status} ${response.statusText}`);
    }

    console.log("[Direct Test] Successfully listed domains.");
    console.log("--- API Response ---");
    console.log(JSON.stringify(responseData, null, 2));
    console.log("--------------------");
    return responseData;

  } catch (error) {
     console.error("[Direct Test] Error calling Admin SDK:", error);
     throw new Error(`Failed to list G Suite domains: ${error.message}`);
  }
}

// --- Main Execution ---
(async () => {
  console.log("[Direct Test] Starting standalone GAPI user list test...");
  // Add a delay to allow the function server (started by concurrently) to initialize
  console.log("[Direct Test] Waiting 3 seconds for function server...");
  await new Promise(resolve => setTimeout(resolve, 3000)); 

  try {
    // Fetch secrets from Keystore first
    console.log("[Direct Test] Fetching secrets from Keystore...");
    const [serviceAccount, adminEmail] = await Promise.all([
        getGapiServiceAccount(),
        getGapiAdminEmail()
    ]);
    console.log("[Direct Test] Secrets fetched. Proceeding with token generation...");

    const accessToken = await getGoogleAccessToken(serviceAccount, adminEmail);
    await listGSuiteDomains(accessToken);
    console.log("[Direct Test] Test completed successfully.");
    Deno.exit(0);
  } catch (error) {
    console.error("\n--- [Direct Test] SCRIPT FAILED ---");
    console.error(error.message);
    if (error.cause) {
         console.error("Cause:", error.cause);
    }
    console.error("------------------------------");
    Deno.exit(1);
  }
})(); 
