import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { processSdkRequest } from "npm:sdk-http-wrapper@1.0.9/server";
import { createClient } from "npm:@supabase/supabase-js";
import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";
config({ export: true });

// Helper to determine the correct Supabase URL (local vs deployed)
function getSupabaseUrl(): string {
  const extSupabaseUrl = Deno.env.get('EXT_SUPABASE_URL'); // Read EXT variable
  if (!extSupabaseUrl) {
     console.warn("[wrappedsupabase] EXT_SUPABASE_URL not found in environment. Defaulting to internal kong:8000");
     return 'http://kong:8000'; // Default to internal for local if EXT isn't set
  }

  // Check if the EXT URL points to local development
  if (extSupabaseUrl.includes('localhost') || extSupabaseUrl.includes('127.0.0.1')) {
    console.log("[wrappedsupabase] Detected local EXT_SUPABASE_URL, using internal Kong URL.");
    return 'http://kong:8000';
  }

  // Otherwise, assume it's a deployed URL and use it directly
  console.log(`[wrappedsupabase] Using provided EXT_SUPABASE_URL: ${extSupabaseUrl}`);
  return extSupabaseUrl;
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
    
    // Get Service Role Key ONLY from environment variable
    const serviceRoleKey = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY');

    // Validate environment variables
    if (!targetSupabaseUrl || targetSupabaseUrl === 'http://kong:8000' && !Deno.env.get('EXT_SUPABASE_URL')) {
        // Log specific error if URL is missing or defaulted due to missing EXT_SUPABASE_URL
        console.error("[wrappedsupabase] Error: EXT_SUPABASE_URL env var not set or invalid.");
        throw new Error("Supabase URL environment variable not configured correctly.");
    }
    if (!serviceRoleKey) {
        console.error("[wrappedsupabase] Error: EXT_SUPABASE_SERVICE_ROLE_KEY env var not set.");
        throw new Error("Supabase Service Role Key environment variable not found.");
    }

    // Log the key being used (BE CAREFUL WITH LOGGING SECRETS)
    const keyStart = serviceRoleKey?.substring(0, 10);
    const keyEnd = serviceRoleKey?.substring(serviceRoleKey.length - 4);
    console.log(`[wrappedsupabase] Using Service Role Key: ${keyStart}...${keyEnd}`);

    // Initialize client using environment variables
    // console.log(`[wrappedsupabase] Initializing client from ENV for URL: ${targetSupabaseUrl}`);
    const supabaseClient = createClient(targetSupabaseUrl, serviceRoleKey, {
       auth: { persistSession: false } // Recommended for server-side clients
    });
    
    const sdkConfig: Record<string, { instance: any }> = {
      supabase: { instance: supabaseClient }
    };

    // Check specific paths first
    if (path === "/wrappedsupabase/api/sdk-proxy" && req.method === "POST") {
      console.log(`[wrappedsupabase] Handling generic proxy request`);
      const body = await req.json();
      const service = body.service as string;
      const result = await processSdkRequest(body, sdkConfig[service]);
      return new Response(JSON.stringify(result.body), { status: result.status, headers: corsHeaders });
    }
    
    if (path.startsWith("/wrappedsupabase/api/proxy/") && req.method === "POST") {
      const service = path.split("/").pop() as string;
      console.log(`[wrappedsupabase] Handling specific proxy request for service: ${service}`);
      const body = await req.json();
      const result = await processSdkRequest({ ...body, service }, sdkConfig[service]);
      return new Response(JSON.stringify(result.body), { status: result.status, headers: corsHeaders });
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