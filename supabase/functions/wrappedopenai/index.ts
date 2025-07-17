import OpenAI from 'npm:openai';
import { serve } from "https://deno.land/std@0.131.0/http/server.ts";
import { corsHeaders } from '../quickjs/cors.ts';
// Use the wrapper client to interact with keystore
import { createServiceProxy } from 'npm:sdk-http-wrapper@1.0.10/client';

// Helper to determine Kong URL for local dev
function getSupabaseUrl() {
  const isLocal = Deno.env.get('SUPABASE_EDGE_RUNTIME_IS_LOCAL') === 'true';
  const defaultUrl = Deno.env.get('SUPABASE_URL') ?? 'http://localhost:8000'; // Fallback needed
  if (isLocal) {
    console.log('[WrappedOpenAI Helper] Detected local env, using Kong URL.');
    return 'http://kong:8000';
  }
  console.log('[WrappedOpenAI Helper] Detected non-local env, using SUPABASE_URL.');
  return defaultUrl;
}

const supabaseUrl = getSupabaseUrl();

// Initialize keystore proxy
console.log(`[WrappedOpenAI] Initializing keystore proxy targeting: ${supabaseUrl}/functions/v1/wrappedkeystore`);
const keystore = createServiceProxy('keystore', {
  baseUrl: `${supabaseUrl}/functions/v1/wrappedkeystore`,
  headers: {
    'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
    'apikey': Deno.env.get('SUPABASE_ANON_KEY') // Include anon key if needed by RLS
  }
});

let openaiClient: OpenAI | null = null;
let apiKey: string | null = null;

async function initializeOpenAIClient() {
  if (openaiClient) return openaiClient;
  try {
    console.log("[WrappedOpenAI] Attempting to fetch OpenAI API key from keystore...");
    apiKey = await keystore.getKey('global', 'OPENAI_API_KEY');
    
    if (!apiKey) {
      console.error("[WrappedOpenAI] Failed to retrieve OPENAI_API_KEY from keystore.");
      throw new Error('OpenAI API key not found in keystore.');
    }
    console.log(`[WrappedOpenAI] Retrieved API key (starts with: ${apiKey.substring(0, 5)}...). Initializing OpenAI client...`);
    
    openaiClient = new OpenAI({ apiKey });
    console.log("[WrappedOpenAI] OpenAI client initialized successfully.");
    return openaiClient;
  } catch (error) {
    console.error("[WrappedOpenAI] Error initializing OpenAI client:", error);
    openaiClient = null; // Reset on error
    // Fix Linter: Check error type
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to initialize OpenAI client: ${errorMessage}`);
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    console.log(`[WrappedOpenAI] Request received { url: "${req.url}", method: "${req.method}" }`);
    const client = await initializeOpenAIClient();
    if (!client) {
        // Error should have been thrown by initializeOpenAIClient
        return new Response(JSON.stringify({ error: "OpenAI client failed to initialize" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { chain, config } = await req.json(); // Assuming body is { chain, config } like sdk-proxy
    console.log("[WrappedOpenAI] Parsed request body:", { chain, config });

    if (!Array.isArray(chain) || chain.length === 0) {
      throw new Error('Invalid request format: missing or invalid chain');
    }

    // Extract the actual method call details from the chain
    // Example chain: [{ type: 'get', property: 'chat' }, { type: 'get', property: 'completions' }, { type: 'call', property: 'create', args: [...] }]
    let current: any = client;
    let callDetails: { property: string, args: any[] } | null = null;
    let lastAccessedProperty: string | null = null;

    for (const link of chain) {
      lastAccessedProperty = link.property; // Keep track of the property we are about to access/call
      if (link.type === 'get') {
        if (!current || typeof current[link.property] === 'undefined') {
           console.error(`[WrappedOpenAI DEBUG] Property '${link.property}' not found on current object:`, current);
           throw new Error(`Invalid chain: property '${link.property}' not found.`);
        }
        current = current[link.property];
        // --- Add Debug Logging Here --- 
        console.log(`[WrappedOpenAI DEBUG] Accessed property: ${link.property}`);
        console.log(`[WrappedOpenAI DEBUG]   -> typeof current is now: ${typeof current}`);
        try {
          if (current !== null && typeof current === 'object') {
            console.log(`[WrappedOpenAI DEBUG]   -> Object.keys(current): ${JSON.stringify(Object.keys(current))}`);
          }
        } catch (e) {
          // Fix Linter: Check error type
          const eMessage = e instanceof Error ? e.message : String(e);
          console.warn(`[WrappedOpenAI DEBUG]   -> Error getting keys for ${link.property}: ${eMessage}`);
        }
        // --- End Debug Logging --- 
      } else if (link.type === 'call') {
        console.log(`[WrappedOpenAI DEBUG] Preparing to call property: ${link.property} on current object (type: ${typeof current})`);
        if (typeof current[link.property] !== 'function') { // Check the specific property intended for calling
            console.error(`[WrappedOpenAI DEBUG] Property '${link.property}' is NOT a function on current object:`, current);
            // Add keys log here too for context
            try {
              if (current !== null && typeof current === 'object') {
                 console.error(`[WrappedOpenAI DEBUG]   -> Object.keys(current): ${JSON.stringify(Object.keys(current))}`);
              }
            } catch (e) { /* ignore */ }
            throw new Error(`Invalid chain: '${link.property}' is not a function.`);
        }
        callDetails = { property: link.property, args: link.args || [] };
        // Ensure 'this' context is set correctly for the function call itself
        // We apply the function later, so just store the function reference now.
        current = current[link.property]; 
        console.log(`[WrappedOpenAI DEBUG] Stored function reference for '${link.property}'`);
        break; // Stop processing chain once call function is identified
      } else {
         throw new Error(`Invalid chain link type: ${link.type}`);
      }
    }

    if (!callDetails || typeof current !== 'function') { // Now 'current' holds the function reference
        console.error(`[WrappedOpenAI DEBUG] Chain processing finished, but did not result in a function to call. Last accessed property: ${lastAccessedProperty}, Final current type: ${typeof current}`);
        throw new Error('Invalid request: chain did not end in a valid function call.');
    }
    
    // Bind 'this' before calling. The object to bind to is the one *before* the final function property was accessed.
    // We need to re-traverse to get the parent object. This is inefficient, consider redesign if complex.
    let parentObject: any = client;
    for (let i = 0; i < chain.length - 1; i++) {
      parentObject = parentObject[chain[i].property];
    }
    console.log(`[WrappedOpenAI DEBUG] Parent object for binding 'this' (type: ${typeof parentObject}):`, parentObject);
    const boundFunction = current.bind(parentObject);

    console.log(`[WrappedOpenAI] Attempting to call OpenAI SDK method: ${callDetails.property}`);
    console.log(`[WrappedOpenAI] With arguments:`, JSON.stringify(callDetails.args, null, 2));

    // Make the actual call using the bound function
    const result = await boundFunction(...callDetails.args);

    console.log(`[WrappedOpenAI] Successfully received result from OpenAI SDK method: ${callDetails.property}`);
    // DEBUG: Log the raw result structure
    console.log(`[WrappedOpenAI DEBUG] Raw OpenAI result:`, JSON.stringify(result, null, 2));

    // Return the result in the expected format
    console.log("[WrappedOpenAI] Sending successful response back to caller.");
    return new Response(JSON.stringify({ data: result }), { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
    });

  } catch (error) {
    console.error("[WrappedOpenAI] Error processing request:", error);
    // Fix Linter: Check error type before accessing properties
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const errorName = error instanceof Error ? error.name : "Error";
    const errorStack = error instanceof Error ? error.stack : undefined;

    // Log stack trace if available
    if (errorStack) {
       console.error("[WrappedOpenAI] Stack Trace:", errorStack);
    }
    console.error("[WrappedOpenAI] Sending error response back to caller.");
    return new Response(JSON.stringify({ error: { message: errorMessage, name: errorName } }), { 
        status: 500, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
});

console.log("[WrappedOpenAI] Function initialized and server started.");