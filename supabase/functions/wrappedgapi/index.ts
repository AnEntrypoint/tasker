// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

import { serve } from 'https://deno.land/std@0.131.0/http/server.ts'
import { corsHeaders } from '../quickjs/cors.ts'
import { createServiceProxy } from 'npm:sdk-http-wrapper@1.0.10/client'
// --- Use official googleapis Node library via npm specifier ---
import { google } from 'npm:googleapis@^133' 
// Import OAuth2Client type from the core auth library
import type { OAuth2Client } from 'npm:google-auth-library@^9'; 
import { processSdkRequest } from "npm:sdk-http-wrapper@1.0.10/server"; // Import the server part

console.log("[WrappedGAPI] Function initialized (using npm:googleapis and sdk-http-wrapper).");

// --- Keystore Proxy Setup ---
function getSupabaseUrl() {
  const isLocal = Deno.env.get('SUPABASE_EDGE_RUNTIME_IS_LOCAL') === 'true';
  const defaultUrl = Deno.env.get('SUPABASE_URL') ?? 'http://localhost:8000';
  if (isLocal) {
    return 'http://kong:8000';
  }
  return defaultUrl;
}

const supabaseUrl = getSupabaseUrl();

//console.log(`[WrappedGAPI] Initializing keystore proxy targeting: ${supabaseUrl}/functions/v1/wrappedkeystore`);
const keystore = createServiceProxy('keystore', {
  baseUrl: `${supabaseUrl}/functions/v1/wrappedkeystore`,
      headers: {
    'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
    'apikey': Deno.env.get('SUPABASE_ANON_KEY')
  }
});
// --- End Keystore Proxy Setup ---

// --- Auth Logic using googleapis library ---
interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

let cachedCreds: ServiceAccountCredentials | null = null;
// Cache Auth clients per scope set AND impersonated user
const authClients: Record<string, OAuth2Client> = {}; 

// Fetches and parses credentials (remains the same)
async function getCredentialsFromKeystore(): Promise<ServiceAccountCredentials> {
  if (cachedCreds) return cachedCreds;
  try {
    // console.log("[WrappedGAPI] Attempting to fetch GAPI Service Account JSON from keystore (key: GAPI_KEY)..."); // REPETITIVE
    const jsonString: string | null | undefined = await keystore.getKey('global', 'GAPI_KEY');
    
    if (!jsonString) {
      console.error("[WrappedGAPI] GAPI_KEY (Service Account JSON) not found in keystore.");
      throw new Error('GAPI_KEY (Service Account JSON) not found in keystore.');
    }

    //console.log("[WrappedGAPI] Parsing service account JSON...");
    const creds: ServiceAccountCredentials = JSON.parse(jsonString);

    if (!creds.client_email || !creds.private_key) {
        throw new Error('Service account JSON is missing required fields (client_email, private_key).');
    }
    
    cachedCreds = creds;
    // console.log(`[WrappedGAPI] Successfully parsed credentials for ${cachedCreds.client_email}.`); // REPETITIVE
    return cachedCreds;
  } catch (error) {
    console.error("[WrappedGAPI] Error fetching/parsing GAPI credentials from keystore:", error);
    cachedCreds = null; 
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve/parse GAPI credentials from keystore: ${errorMessage}`);
  }
}

// Modified function to get an authenticated JWT client for specific scopes AND user
async function getAuthClient(scope: string | string[], userEmailToImpersonate: string | null): Promise<OAuth2Client> {
    // console.log(`[WrappedGAPI getAuthClient] START - Scopes: ${JSON.stringify(scope)}, User: ${userEmailToImpersonate || 'none'}`); // VERBOSE
    const scopesArray = Array.isArray(scope) ? scope.sort() : [scope];
    const scopeKey = scopesArray.join(',');
    const cacheKey = `${scopeKey}::user:${userEmailToImpersonate || 'none'}`; 
    // console.log(`[WrappedGAPI getAuthClient] Cache key: ${cacheKey}`); // VERBOSE
    
    if (authClients[cacheKey]) {
        // console.log(`[WrappedGAPI getAuthClient] Reusing cached Auth client for key: ${cacheKey}`); // VERBOSE
        return authClients[cacheKey];
    }

    // console.log(`[WrappedGAPI getAuthClient] Creating NEW Auth client for key: ${cacheKey}`); // VERBOSE
    let credentials;
    try {
        credentials = await getCredentialsFromKeystore();
    } catch (credError) {
        console.error("[WrappedGAPI getAuthClient] FATAL: Failed to get credentials from keystore.", credError);
        throw credError; // Re-throw critical error
    }

    try {
        // console.log(`[WrappedGAPI getAuthClient] Instantiating JWT client. Impersonating: ${userEmailToImpersonate || 'Service Account Default'}`); // REPETITIVE
        const jwtClient = new google.auth.JWT(
            credentials.client_email,
            undefined,
            credentials.private_key,
            scopesArray,
            userEmailToImpersonate ?? undefined
        );
        
        // console.log(`[WrappedGAPI getAuthClient] Attempting to authorize JWT client for cache key: ${cacheKey}...`); // REPETITIVE
        // Add explicit try/catch around authorize
        try {
            await jwtClient.authorize(); 
            // console.log(`[WrappedGAPI getAuthClient] JWT Auth client AUTHORIZED successfully for cache key: ${cacheKey}`); // REPETITIVE
        } catch (authorizeError) {
            console.error(`[WrappedGAPI getAuthClient] FAILED to authorize JWT client for key ${cacheKey}:`, authorizeError);
            throw authorizeError; // Re-throw authorization error
        }

        authClients[cacheKey] = jwtClient as unknown as OAuth2Client;
        // console.log(`[WrappedGAPI getAuthClient] Storing and returning new auth client for key: ${cacheKey}`); // REPETITIVE
        return authClients[cacheKey];
    } catch (authError) {
        console.error("[WrappedGAPI getAuthClient] Overall error creating/authorizing JWT client:", authError);
        // Check if the error has a message property before accessing it
        const errorMessage = (authError instanceof Error) ? authError.message : String(authError);

        // Don't re-throw here if authorize already threw, but ensure an error is thrown
        if (!(errorMessage.includes("FAILED to authorize JWT client"))) {
           throw new Error(`Failed to create/authorize JWT client: ${errorMessage}`);
        }
        // If authorize already threw, the error has been logged and re-thrown
        throw authError; // Ensure error propagates
    }
}

// --- End Auth Logic ---

// --- REMOVED Global SDK Instances & Initialization ---
// const DEFAULT_ADMIN_SCOPES = [...]; // REMOVED
// let adminServiceInstance: any = null; // REMOVED
// let initializationError: Error | null = null; // REMOVED
// async function initializeAdminService() { ... } // REMOVED
// initializeAdminService(); // REMOVED
// --- End REMOVAL --- 

serve(async (req) => {
    console.log(req.url)
  if (req.method === 'OPTIONS') {
    console.log("[WrappedGAPI] Handling OPTIONS request.");
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const requestUrl = req.url; // Capture for logging
  //console.log(`[WrappedGAPI] Request received { url: "${requestUrl}", method: "${req.method}" }`);

  try {
    // --- REMOVED Initialization Check --- 
    // The check for adminServiceInstance and initializationError is no longer needed
    // --- End REMOVAL --- 

    const body = await req.json();
    // console.log(`[WrappedGAPI Handler] Received raw body:`, JSON.stringify(body)); // POTENTIALLY LARGE & VERBOSE - REMOVE

    // --- Extract chain, config, and final args --- 
    const serviceName = 'gapi'; // Assume 'gapi' namespace
    const chain = body?.chain;
    let config = body?.config || {}; // Extract config object - **Start with body.config**
    let finalCallArgs: any[] = [];

    if (chain && Array.isArray(chain) && chain.length > 0) {
        const lastStep = chain[chain.length - 1];
        if (lastStep && lastStep.type === 'call' && Array.isArray(lastStep.args)) {
            // Check if the *last* argument looks like our config object
            const potentialConfigArg = lastStep.args[lastStep.args.length - 1];
            if (
                lastStep.args.length > 0 && 
                typeof potentialConfigArg === 'object' && 
                potentialConfigArg !== null && 
                (
                    potentialConfigArg.hasOwnProperty('__impersonate') || 
                    Object.keys(potentialConfigArg).length > 0 // Or if it's just a non-empty object meant for config
                )
            ) {
                 // If the last arg is our config, separate it
                finalCallArgs = lastStep.args.slice(0, -1); // All args except the last one
                // Merge it with any config already present in body.config
                config = { ...config, ...potentialConfigArg }; 
            } else {
                // Otherwise, all args are actual API args
            finalCallArgs = lastStep.args;
            }
        }
    }
    // console.log(`[WrappedGAPI Handler] Extracted - Chain: ${JSON.stringify(chain)}, Config: ${JSON.stringify(config)}, Args: ${JSON.stringify(finalCallArgs)}`); // VERBOSE - REMOVE

    if (!chain || !Array.isArray(chain) || chain.length === 0) {
         console.error("[WrappedGAPI Handler] Invalid request format: 'chain' property missing, not an array, or empty.", body);
         throw new Error("Invalid request format: 'chain' property missing, not an array, or empty.");
    }
    // --- End Extraction ---

    // --- Dynamic Client/Service Creation --- 
    // ***MODIFIED: Get impersonation target from config, not args***
    const userIdToImpersonate = config.__impersonate || null; 
    const requiredScopes = getScopesForCall(chain); 
    //console.log(`[WrappedGAPI Handler] User to impersonate (from config.__impersonate): ${userIdToImpersonate || 'none'}`); // REMOVE
    //console.log(`[WrappedGAPI Handler] Determined required scopes: ${JSON.stringify(requiredScopes)}`); // REMOVE

    //console.log(`[WrappedGAPI Handler] Attempting to get auth client...`); // REMOVE
    const authClient = await getAuthClient(requiredScopes, userIdToImpersonate);
    // console.log(`[WrappedGAPI Handler] Successfully obtained auth client.`); // REPETITIVE - REMOVE

    const topLevelService = chain[0]?.property;
    // console.log(`[WrappedGAPI Handler] Determined topLevelService: ${topLevelService}`); // Less critical - REMOVE
    let googleApiServiceInstance: any;

    switch (topLevelService) {
        case 'gmail':
            // console.log("[WrappedGAPI] Creating Gmail service instance..."); // REPETITIVE
            googleApiServiceInstance = google.gmail({ version: 'v1', auth: authClient });
            break;
        case 'admin':
            // console.log("[WrappedGAPI] Creating Admin Directory service instance..."); // REPETITIVE
            googleApiServiceInstance = google.admin({ version: 'directory_v1', auth: authClient });
            break;
        // Add cases for other services like drive, calendar, etc. as needed
        default:
            console.error(`[WrappedGAPI] Unsupported top-level Google API service requested: ${topLevelService}`);
            throw new Error(`Unsupported Google API service: ${topLevelService}. Supported: gmail, admin`);
    }
    // console.log(`[WrappedGAPI Handler] Dynamically created Google API service instance for: ${topLevelService}. Instance keys: ${googleApiServiceInstance ? Object.keys(googleApiServiceInstance).join(', ') : 'null'}`); // Less critical - REMOVE
    // --- End Dynamic Client/Service Creation Logging ---

    const sdkConfig: Record<string, { instance: any }> = {
        [topLevelService]: { instance: googleApiServiceInstance } 
    };

    if (!sdkConfig[topLevelService]) { 
         console.error(`[WrappedGAPI Handler] Internal error: Dynamic SDK config creation failed for ${topLevelService}`);
         throw new Error(`Internal SDK configuration error for service: ${topLevelService}`);
    }

    const processSdkPayload = {
        service: topLevelService, 
        chain: chain.slice(1), 
        args: finalCallArgs 
    };
    // console.log(`[WrappedGAPI Handler] Calling processSdkRequest with dynamic payload:`, JSON.stringify(processSdkPayload)); // VERBOSE
    
    let result;
    try {
        result = await processSdkRequest(processSdkPayload, sdkConfig[topLevelService]);
        // console.log(`[WrappedGAPI Handler] processSdkRequest raw result: Status=${result?.status}, Body=${JSON.stringify(result?.body)}`); // VERY VERBOSE & LARGE
    } catch (sdkError) {
        console.error(`[WrappedGAPI Handler] ERROR during processSdkRequest call:`, sdkError);
        throw sdkError; // Re-throw
    }

    // --- Check for errors returned by processSdkRequest --- Enhanced Logging ---
    if (result.status >= 400) {
        console.error(`[WrappedGAPI Handler] processSdkRequest returned ERROR status ${result.status}. Body:`, JSON.stringify(result.body));
        // Throw an error object compatible with the outer catch block
        const errorDetails = typeof result.body === 'object' ? JSON.stringify(result.body) : String(result.body);
        throw { 
            status: result.status, 
            message: `SDK call failed with status ${result.status}`, 
            details: errorDetails // Include the original body as details
        };
    }
    // --- End error check ---

    // console.log(`[WrappedGAPI Handler] processSdkRequest completed successfully with status: ${result.status}`); // Less critical
    return new Response(JSON.stringify(result.body), { 
        status: result.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (error) {
    // --- Enhanced Outer Error Handling ---
    console.error(`[WrappedGAPI Handler] FATAL CATCH BLOCK processing request for ${requestUrl}:`, error);
    // Log specific properties if available
    let errorMessage = 'Internal Server Error';
    let errorDetails = undefined;
    let errorStatus = 500;
    let errorStack = undefined;

    if (error instanceof Error) {
        errorMessage = error.message;
        errorStack = error.stack;
    }
    if (typeof error === 'object' && error !== null) {
        errorStatus = (error as any).status ?? errorStatus;
        // Use specific message if available and not already set by Error instance
        if (typeof (error as any).message === 'string' && errorMessage === 'Internal Server Error') {
             errorMessage = (error as any).message;
        }
        errorDetails = (error as any).details ?? errorDetails;
    }
    
    console.error(`[WrappedGAPI Handler] Error Details: Status=${errorStatus}, Message=${errorMessage}, Details=${errorDetails}, Stack=${errorStack}`);

    const errorBody = { 
        success: false, 
        error: errorMessage, 
        details: errorDetails
    };

    return new Response(
      JSON.stringify(errorBody),
      { status: errorStatus, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    // --- End Enhanced Outer Error Handling ---
  }
});

console.log("[Host] WrappedGAPI server started (dynamic impersonation mode).");

/* 
NOTE: This function now uses the 'google_api' Deno library (deno.land/x/google_api) 
and the sdk-http-wrapper server.
It authenticates using a Service Account JSON stored in the keystore under 'GAPI_KEY'.
It dynamically creates authenticated clients and SDK instances per request, 
attempting impersonation based on the 'userId' parameter found in the request arguments.
Scope determination is currently basic and needs refinement.
*/

// --- Dynamically determine required scopes (Simplified example) ---
// TODO: Implement a more robust scope determination logic based on the API call chain
function getScopesForCall(chain: any[]): string[] {
    // Example: Check the first part of the chain (e.g., 'gmail', 'admin')
    const topLevelService = chain?.[0]?.property; 
    if (topLevelService === 'gmail') {
        // console.log("[WrappedGAPI Scope Helper] Detected 'gmail' call, using Gmail scopes."); // Less critical
        return [
            'https://www.googleapis.com/auth/gmail.readonly', // Common read scope
            'https://mail.google.com/' // Broad scope often needed for list/modify
        ];
    } else if (topLevelService === 'admin') {
        // console.log("[WrappedGAPI Scope Helper] Detected 'admin' call, using Admin Directory scopes."); // Less critical
        // Default Admin scopes (adjust if needed)
        return [
            'https://www.googleapis.com/auth/admin.directory.user.readonly',
            'https://www.googleapis.com/auth/admin.directory.domain.readonly',
            'https://www.googleapis.com/auth/admin.directory.customer.readonly'
        ];
    }
    // Add more conditions for other services (Drive, Calendar, etc.)
    // console.warn(`[WrappedGAPI Scope Helper] Unknown top-level service '${topLevelService}'. Falling back to default Admin scopes.`); // Less critical
    // Fallback scopes (consider if this is safe or should throw error)
    return ['https://www.googleapis.com/auth/admin.directory.user.readonly'];
}
