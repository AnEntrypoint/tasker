import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// Helper to determine the correct Supabase URL (local vs deployed)
function getSupabaseUrl(): string {
  // Try EXT_SUPABASE_URL first, then fall back to SUPABASE_URL
  const extSupabaseUrl = Deno.env.get('EXT_SUPABASE_URL');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');

  if (extSupabaseUrl) {
    console.log("[wrappedsupabase] Using EXT_SUPABASE_URL:", extSupabaseUrl);
    return extSupabaseUrl;
  } else if (supabaseUrl) {
    console.log("[wrappedsupabase] Using SUPABASE_URL:", supabaseUrl);
    return supabaseUrl;
  } else {
    console.warn("[wrappedsupabase] Neither EXT_SUPABASE_URL nor SUPABASE_URL found in environment. Defaulting to http://127.0.0.1:54321");
    return 'http://127.0.0.1:54321'; // Default to local development with correct port
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
    console.log(`[wrappedsupabase] Initializing client for URL: ${targetSupabaseUrl}`);
    const supabaseClient = createClient(targetSupabaseUrl, serviceRoleKey, {
       auth: { persistSession: false } // Recommended for server-side clients
    });

    // Handle POST requests with simple manual processing instead of processSdkRequest
    if (req.method === 'POST') {
      const body = await req.json();
      console.log(`[wrappedsupabase] Processing request:`, body);
      
      if (body.chain && Array.isArray(body.chain)) {
        let result = supabaseClient;
        
        // Process the chain manually
        for (const step of body.chain) {
          if (step.property && typeof result[step.property] === 'function') {
            const args = step.args || [];
            console.log(`[wrappedsupabase] Calling ${step.property} with args:`, args);
            result = result[step.property](...args);
          } else {
            throw new Error(`Method ${step.property} not found or not a function`);
          }
        }
        
        // Execute the final result if it's a promise
        const finalResult = await result;
        console.log(`[wrappedsupabase] Request processed successfully`);
        
        return new Response(JSON.stringify(finalResult), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } else {
        throw new Error('Invalid request format - expected chain array');
      }
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: corsHeaders
    });
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