import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { executeMethodChain } from "npm:sdk-http-wrapper@1.0.10/server";
import websearch from "./websearch-service.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-task-id, x-execution-id, x-request-id",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Credentials": "true"
};

// Define type for websearch service methods
type WebSearchService = typeof websearch;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const path = new URL(req.url).pathname;

  try {
    if (req.method === "GET" && path === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: corsHeaders });
    }

    if (req.method === "POST") {
      const body = await req.json();
      
      try {
        let result;
        
        // Handle both old-style and new-style requests
        if (body.chain) {
          // Handle chain-style request from SDK wrapper
          result = await executeMethodChain(websearch, body.chain);
        } else if (body.method) {
          // Handle direct method call (from QuickJS)
          const method = body.method as keyof WebSearchService;
          const args = body.args || [];
          
          if (typeof websearch[method] === 'function') {
            // Cast to any to avoid TypeScript errors with dynamic method calls
            result = await (websearch[method] as Function)(...args);
          } else {
            throw new Error(`Method ${String(method)} not found on websearch service`);
          }
        } else {
          throw new Error("Request must include either 'chain' or 'method'");
        }
        
        return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return new Response(JSON.stringify({ 
          error: { 
            message: err.message,
            code: (err as any).code,
            name: err.name
          }
        }), { status: (err as any).status || 500, headers: corsHeaders });
      }
    }
    
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return new Response(
      JSON.stringify({ error: { message: err.message, stack: err.stack } }),
      { status: 500, headers: corsHeaders }
    );
  }
});
