import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { processSdkRequest } from "npm:sdk-http-wrapper@1.0.10/server";
import { createClient } from "npm:@supabase/supabase-js";
// import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";
// config({ export: true, path: "../../.env" }); // Removed dotenv - use env vars directly

// Helper to determine the correct Supabase URL (local vs deployed)
function getSupabaseUrl(): string {
  // Try EXT_SUPABASE_URL first, then fall back to SUPABASE_URL
  const extSupabaseUrl = Deno.env.get('EXT_SUPABASE_URL');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');

  if (extSupabaseUrl) {
    console.log("[wrappedsupabase] Using EXT_SUPABASE_URL:", extSupabaseUrl);

    // Check if the EXT URL points to local development
    if (extSupabaseUrl.includes('localhost') || extSupabaseUrl.includes('127.0.0.1')) {
      return 'http://kong:8000';
    }

    // Otherwise, assume it's a deployed URL and use it directly
    return extSupabaseUrl;
  } else if (supabaseUrl) {
    console.log("[wrappedsupabase] Using SUPABASE_URL:", supabaseUrl);

    // Check if the URL points to local development
    if (supabaseUrl.includes('localhost') || supabaseUrl.includes('127.0.0.1')) {
      return 'http://kong:8000';
    }

    // Otherwise, assume it's a deployed URL and use it directly
    return supabaseUrl;
  } else {
    console.warn("[wrappedsupabase] Neither EXT_SUPABASE_URL nor SUPABASE_URL found in environment. Defaulting to http://127.0.0.1:8000");
    return 'http://127.0.0.1:8000'; // Default to local development
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-task-id, x-execution-id, x-request-id",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Credentials": "true"
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const path = new URL(req.url).pathname;

  try {
    if (req.method === "GET" && path === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: corsHeaders });
    }

    // --- Get Target URL and Auth Token FROM ENVIRONMENT ---
    const targetSupabaseUrl = getSupabaseUrl();

    // Try EXT_SUPABASE_SERVICE_ROLE_KEY first, then fall back to SUPABASE_SERVICE_ROLE_KEY
    const extServiceRoleKey = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY');
    const serviceRoleKey = extServiceRoleKey || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    // Log environment variables for debugging
    console.log("[wrappedsupabase] Environment variables:");
    console.log("[wrappedsupabase] targetSupabaseUrl:", targetSupabaseUrl);
    console.log("[wrappedsupabase] EXT_SUPABASE_URL:", Deno.env.get('EXT_SUPABASE_URL') || "undefined");
    console.log("[wrappedsupabase] SUPABASE_URL:", Deno.env.get('SUPABASE_URL') || "undefined");
    console.log("[wrappedsupabase] EXT_SUPABASE_SERVICE_ROLE_KEY:", extServiceRoleKey ? "[REDACTED]" : "undefined");
    console.log("[wrappedsupabase] SUPABASE_SERVICE_ROLE_KEY:", Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ? "[REDACTED]" : "undefined");

    // Validate environment variables
    if (!targetSupabaseUrl) {
        console.error("[wrappedsupabase] Error: Neither EXT_SUPABASE_URL nor SUPABASE_URL env var is set.");
        throw new Error("Supabase URL environment variable not configured correctly.");
    }
    if (!serviceRoleKey) {
        console.error("[wrappedsupabase] Error: Neither EXT_SUPABASE_SERVICE_ROLE_KEY nor SUPABASE_SERVICE_ROLE_KEY env var is set.");
        throw new Error("Supabase Service Role Key environment variable not found.");
    }

    // Initialize client using environment variables
    // console.log(`[wrappedsupabase] Initializing client from ENV for URL: ${targetSupabaseUrl}`);
    const supabaseClient = createClient(targetSupabaseUrl, serviceRoleKey, {
       auth: { persistSession: false } // Recommended for server-side clients
    });

    // Define a more specific type for the SDK config
    interface SdkInstance {
      instance: unknown;
    }

    const sdkConfig: Record<string, SdkInstance> = {
      supabase: { instance: supabaseClient }
    };

    // Log the supabase client methods for debugging
    //console.log(`[wrappedsupabase] Supabase client methods:`, Object.keys(supabaseClient));

    // Check specific paths first
    if (path === "/wrappedsupabase/api/sdk-proxy" && req.method === "POST") {
      console.log(`[wrappedsupabase] Handling generic proxy request`);
      const body = await req.json();
      const service = body.service as string;

      // Log the request for debugging
      console.log(`[wrappedsupabase] Generic proxy request for service: ${service}`);
      console.log(`[wrappedsupabase] Request body:`, JSON.stringify(body));

      try {
        const result = await processSdkRequest(body, sdkConfig[service]);
        console.log(`[wrappedsupabase] Generic proxy result:`, JSON.stringify(result));
        return new Response(JSON.stringify(result.body), { status: result.status, headers: corsHeaders });
      } catch (error) {
        console.error(`[wrappedsupabase] Error processing generic proxy request:`, error);
        return new Response(
          JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    if (path.startsWith("/wrappedsupabase/api/proxy/") && req.method === "POST") {
      const service = path.split("/").pop() as string;
      console.log(`[wrappedsupabase] Handling specific proxy request for service: ${service}`);
      const body = await req.json();

      // Log the request for debugging
      console.log(`[wrappedsupabase] Specific proxy request body:`, JSON.stringify(body));

      try {
        // Define the step type
        interface ChainStep {
          type: string;
          property: string;
          args?: unknown[];
        }

        // Check if the chain contains a 'from' method call
        if (body.chain && Array.isArray(body.chain)) {
          const fromMethodIndex = body.chain.findIndex((step: ChainStep) =>
            step.type === 'call' && step.property === 'from'
          );

          if (fromMethodIndex !== -1) {
            console.log(`[wrappedsupabase] Found 'from' method call at index ${fromMethodIndex}`);

            // Extract the table name
            const tableName = body.chain[fromMethodIndex].args?.[0];
            console.log(`[wrappedsupabase] Table name: ${tableName}`);

            // Check if the supabase client has the 'from' method
            if (typeof supabaseClient.from !== 'function') {
              console.error(`[wrappedsupabase] Error: 'from' method not found on supabaseClient`);
              console.log(`[wrappedsupabase] supabaseClient methods:`, Object.keys(supabaseClient));
              throw new Error("Method 'from' not found on supabaseClient");
            }
          }
        }

        const result = await processSdkRequest({ ...body, service }, sdkConfig[service]);
        console.log(`[wrappedsupabase] Specific proxy result:`, JSON.stringify(result));
        return new Response(JSON.stringify(result.body), { status: result.status, headers: corsHeaders });
      } catch (error) {
        console.error(`[wrappedsupabase] Error processing specific proxy request:`, error);
        return new Response(
          JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Default fallback for wrappedsupabase base path (should not happen with proxy)
    console.warn(`[wrappedsupabase] Received request to unexpected path: ${path}`);
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders });
  } catch (error) {
    console.error("[wrappedsupabase] Handler error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});