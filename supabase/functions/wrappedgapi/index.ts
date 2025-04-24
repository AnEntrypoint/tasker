// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

import { serve } from 'https://deno.land/std@0.131.0/http/server.ts'
import { corsHeaders } from '../quickjs/cors.ts'
import { createServiceProxy } from 'npm:sdk-http-wrapper@1.0.9/client'
// --- Use official googleapis Node library via npm specifier ---
import { google } from 'npm:googleapis@^133' 
// Import OAuth2Client type from the core auth library
import type { OAuth2Client } from 'npm:google-auth-library@^9'; 
import { processSdkRequest } from "npm:sdk-http-wrapper@1.0.9/server"; // Import the server part

console.log("[WrappedGAPI] Function initialized (using npm:googleapis and sdk-http-wrapper).");

// --- Keystore Proxy Setup ---
function getSupabaseUrl() {
  const isLocal = Deno.env.get('SUPABASE_EDGE_RUNTIME_IS_LOCAL') === 'true';
  const defaultUrl = Deno.env.get('SUPABASE_URL') ?? 'http://localhost:8000';
  if (isLocal) {
    console.log('[WrappedGAPI Helper] Detected local env, using Kong URL.');
    return 'http://kong:8000';
  }
  console.log('[WrappedGAPI Helper] Detected non-local env, using SUPABASE_URL.');
  return defaultUrl;
}

const supabaseUrl = getSupabaseUrl();

console.log(`[WrappedGAPI] Initializing keystore proxy targeting: ${supabaseUrl}/functions/v1/wrappedkeystore`);
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
// Cache Auth clients per scope set
const authClients: Record<string, OAuth2Client> = {}; 

// Fetches and parses credentials (remains the same)
async function getCredentialsFromKeystore(): Promise<ServiceAccountCredentials> {
  if (cachedCreds) return cachedCreds;
  try {
    console.log("[WrappedGAPI] Attempting to fetch GAPI Service Account JSON from keystore (key: GAPI_KEY)...");
    const jsonString: string | null | undefined = await keystore.getKey('global', 'GAPI_KEY');
    
    if (!jsonString) {
      console.error("[WrappedGAPI] GAPI_KEY (Service Account JSON) not found in keystore.");
      throw new Error('GAPI_KEY (Service Account JSON) not found in keystore.');
    }

    console.log("[WrappedGAPI] Parsing service account JSON...");
    const creds: ServiceAccountCredentials = JSON.parse(jsonString);

    if (!creds.client_email || !creds.private_key) {
        throw new Error('Service account JSON is missing required fields (client_email, private_key).');
    }
    
    cachedCreds = creds;
    console.log(`[WrappedGAPI] Successfully parsed credentials for ${cachedCreds.client_email}.`);
    return cachedCreds;
  } catch (error) {
    console.error("[WrappedGAPI] Error fetching/parsing GAPI credentials from keystore:", error);
    cachedCreds = null; 
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve/parse GAPI credentials from keystore: ${errorMessage}`);
  }
}

// Function to get an authenticated JWT client for specific scopes
async function getAuthClient(scope: string | string[]): Promise<OAuth2Client> {
    const scopesArray = Array.isArray(scope) ? scope.sort() : [scope];
    const scopeKey = scopesArray.join(',');
    
    if (authClients[scopeKey]) {
        console.log(`[WrappedGAPI] Reusing cached Auth client for scope: ${scopeKey}`);
        return authClients[scopeKey];
    }

    console.log(`[WrappedGAPI] Creating new Auth client for scope: ${scopeKey}`);
    const credentials = await getCredentialsFromKeystore();

    // --- Fetch Admin Email for Impersonation ---
    let adminEmailToImpersonate: string | null = null;
    try {
        console.log("[WrappedGAPI] Attempting to fetch GAPI_ADMIN_EMAIL from keystore...");
        adminEmailToImpersonate = await keystore.getKey('global', 'GAPI_ADMIN_EMAIL');
        if (!adminEmailToImpersonate) {
            console.warn("[WrappedGAPI] GAPI_ADMIN_EMAIL key not found or is empty in keystore. Proceeding without impersonation subject.");
        } else {
            console.log(`[WrappedGAPI] Will impersonate user: ${adminEmailToImpersonate}`);
        }
    } catch (keyError) {
        console.error("[WrappedGAPI] Error fetching GAPI_ADMIN_EMAIL from keystore:", keyError);
        // Decide if this is fatal. For now, warn and proceed without impersonation.
        console.warn("[WrappedGAPI] Proceeding without impersonation subject due to keystore error.");
        adminEmailToImpersonate = null; 
    }
    // --- End Fetch Admin Email ---

    try {
        const jwtClient = new google.auth.JWT(
            credentials.client_email,
            undefined, // keyFile path - not used when key is provided directly
            credentials.private_key,
            scopesArray,
            adminEmailToImpersonate ?? undefined // Subject (pass undefined if null)
        );
        
        // Authorize the client (fetches the initial token)
        await jwtClient.authorize(); 
        console.log(`[WrappedGAPI] JWT Auth client created and authorized for scope: ${scopeKey}`);
        authClients[scopeKey] = jwtClient as unknown as OAuth2Client; // Cast needed due to type mismatch, ensure compatibility
        return authClients[scopeKey];
    } catch (authError) {
        console.error("[WrappedGAPI] Error creating/authorizing JWT client:", authError);
        throw new Error(`Failed to create/authorize JWT client: ${authError instanceof Error ? authError.message : String(authError)}`);
    }
}

// --- End Auth Logic ---

// --- Global SDK Instances & Initialization ---
const DEFAULT_ADMIN_SCOPES = [
    'https://www.googleapis.com/auth/admin.directory.user.readonly',
    'https://www.googleapis.com/auth/admin.directory.domain.readonly',
    'https://www.googleapis.com/auth/admin.directory.customer.readonly'
    // Add other commonly needed scopes here if necessary
];

let adminServiceInstance: any = null;
let initializationError: Error | null = null;

async function initializeAdminService() {
    if (adminServiceInstance || initializationError) return; // Already done or failed
    try {
        console.log("[WrappedGAPI] Initializing Admin SDK service instance...");
        const authClient = await getAuthClient(DEFAULT_ADMIN_SCOPES);
        adminServiceInstance = google.admin({ version: 'directory_v1', auth: authClient });
        console.log("[WrappedGAPI] Admin SDK service instance initialized successfully.");
        // --- Log the top-level keys of the initialized instance ---
        if (adminServiceInstance) {
            console.log("[WrappedGAPI] Keys on adminServiceInstance:", Object.keys(adminServiceInstance));
        } else {
            console.warn("[WrappedGAPI] adminServiceInstance is null/undefined after creation attempt.");
        }
        // --- End Logging ---
    } catch (error) {
        initializationError = error instanceof Error ? error : new Error(String(error));
        console.error("[WrappedGAPI] Failed to initialize Admin SDK service:", initializationError);
    }
}

// Initialize eagerly
initializeAdminService();

// --- End Initialization --- 

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    console.log("[WrappedGAPI] Handling OPTIONS request.");
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const requestUrl = req.url; // Capture for logging
  console.log(`[WrappedGAPI] Request received { url: "${requestUrl}", method: "${req.method}" }`);

  try {
    // --- Ensure Service is Initialized --- 
    if (!adminServiceInstance && !initializationError) {
        console.warn("[WrappedGAPI] Admin service not yet initialized, awaiting...");
        await initializeAdminService(); // Wait if initial call hasn't finished
    }
    // Throw if initialization failed
    if (initializationError) {
        console.error("[WrappedGAPI] Cannot handle request due to initialization failure:", initializationError.message);
        throw new Error(`GAPI Service Initialization Failed: ${initializationError.message}`);
    }
    // Throw if still not initialized after waiting (shouldn't happen if init didn't error)
    if (!adminServiceInstance) {
        console.error("[WrappedGAPI] Service instance is unexpectedly null after initialization attempt.");
        throw new Error("GAPI Service could not be initialized (instance is null).");
    }
    // --- End Initialization Check --- 

    const body = await req.json();
    // Log the raw received body
    console.log(`[WrappedGAPI] Received raw body:`, JSON.stringify(body));

    // --- Adapt to observed payload { chain: [...], config: {...} } ---
    const serviceName = 'gapi'; // Infer service name as client isn't sending it
    const chain = body?.chain;
    
    // Extract args for the FINAL call from the LAST element in the chain
    let finalCallArgs: any[] = [];
    if (chain && Array.isArray(chain) && chain.length > 0) {
        const lastStep = chain[chain.length - 1];
        if (lastStep && lastStep.type === 'call' && Array.isArray(lastStep.args)) {
            finalCallArgs = lastStep.args;
        }
    }

    console.log(`[WrappedGAPI] Extracted - Service (inferred): ${serviceName}, Chain: ${JSON.stringify(chain)}, Args (from last chain step): ${JSON.stringify(finalCallArgs)}`);

    // Validation based on observed payload
    if (!chain || !Array.isArray(chain)) {
         console.error("[WrappedGAPI] Invalid request format: 'chain' property missing or not an array.", body);
         throw new Error("Invalid request format: 'chain' property missing or not an array.");
    }
    // --- End Adaptation ---

    // Define the configuration for processSdkRequest
    const sdkConfig: Record<string, { instance: any }> = {
        'gapi': { instance: adminServiceInstance }
    };

    // Check if the requested service exists in our config
    if (!sdkConfig[serviceName]) { // Use inferred serviceName
         console.error(`[WrappedGAPI] Unsupported service configured/inferred: ${serviceName}`);
         throw new Error(`Unsupported service: ${serviceName}. Available: ${Object.keys(sdkConfig).join(', ')}`);
    }

    // --- Construct the payload expected by processSdkRequest ---
    const processSdkPayload = {
        service: serviceName,
        // Remove the first step (e.g., 'admin') from the chain 
        // as processSdkRequest starts from the instance provided in sdkConfig
        chain: chain.slice(1),
        args: finalCallArgs // Use the extracted args from the last chain step
    };
    console.log(`[WrappedGAPI] Calling processSdkRequest with constructed payload (modified chain):`, JSON.stringify(processSdkPayload));
    // --- End Constructed Payload ---

    let result = await processSdkRequest(processSdkPayload, sdkConfig[serviceName]);

    // --- Check for errors returned by processSdkRequest ---
    if (result.status >= 400) {
        console.error(`[WrappedGAPI] processSdkRequest returned error status ${result.status}. Body:`, result.body);
        // Throw an error object compatible with the outer catch block
        throw { 
            status: result.status, 
            message: `SDK call failed with status ${result.status}`, 
            details: result.body // Include the original body as details
        };
    }
    // --- End error check ---

    console.log(`[WrappedGAPI] processSdkRequest completed successfully with status: ${result.status}`);
    return new Response(JSON.stringify(result.body), { 
        status: result.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (error) {
    // Simplified Error Handling
    console.error(`[WrappedGAPI] Handler error processing request for ${requestUrl}:`, error);
    const status = (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') 
                   ? error.status 
                   : 500;
    const message = error instanceof Error ? error.message : String(error);

    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

console.log("[Host] WrappedGAPI server started (sdk-http-wrapper mode, simplified).");

/* 
NOTE: This function now uses the 'google_api' Deno library (deno.land/x/google_api) 
and the sdk-http-wrapper server.
It authenticates using a Service Account JSON stored in the keystore under 'GAPI_KEY'.
It initializes the Admin SDK service on startup.

Invocation requires using the sdk-http-wrapper client proxy, like in test-live-gapi.ts (after refactoring).
*/
