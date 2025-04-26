import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { executeMethodChain } from "npm:sdk-http-wrapper@1.0.10/server";
import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";

// Type definitions
type ServerTimeResult = {
  timestamp: string;
  source: string;
};

// CORS headers for cross-origin requests
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-task-id, x-execution-id, x-request-id",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Credentials": "true"
};

/**
 * Keystore service implementation
 * This provides a simple key-value store backed by Supabase
 */
class KeystoreService {
  private supabase: any;

  constructor() {
    const extSupabaseUrl = Deno.env.get("EXT_SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("EXT_SUPABASE_SERVICE_ROLE_KEY") || "";
    
    if (!extSupabaseUrl) {
      console.warn("[KeystoreService Constructor] EXT_SUPABASE_URL env var not set. Defaulting Supabase proxy target to internal Kong URL.");
    }
    if (!serviceRoleKey) {
      console.error("[KeystoreService Constructor] FATAL: SUPABASE_SERVICE_ROLE_KEY environment variable is required.");
      throw new Error("SUPABASE_SERVICE_ROLE_KEY environment variable is required");
    }

    // Determine the correct baseUrl for wrappedsupabase
    let useKong = false;
    if (extSupabaseUrl.includes('localhost') || extSupabaseUrl.includes('127.0.0.1') || !extSupabaseUrl) {
        // If EXT_SUPABASE_URL looks like local dev OR if it's missing entirely, use kong.
        console.log("[KeystoreService Constructor] Detected local environment, targeting internal Kong URL for wrappedsupabase proxy.");
        useKong = true;
    } else {
        console.log(`[KeystoreService Constructor] Using provided EXT_SUPABASE_URL for wrappedsupabase proxy: ${extSupabaseUrl}`);
    }
    
    const baseUrl = useKong 
        ? 'http://kong:8000/functions/v1/wrappedsupabase' 
        : `${extSupabaseUrl}/functions/v1/wrappedsupabase`;

    console.log(`[KeystoreService Constructor] Final wrappedsupabase proxy baseUrl: ${baseUrl}`);

    // Create the service proxy using the determined baseUrl
    this.supabase = createServiceProxy('supabase', {
      baseUrl: baseUrl, 
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey, // Pass service key as apikey too for consistency?
        'x-supabase-role': 'service_role' // Ensure service role is used
      }
    });
    console.log("[KeystoreService Constructor] KeystoreService initialized.");
  }

  // Get a stored key value
  async getKey(namespace: string, key: string): Promise<string | null> {
    console.log(`Getting key ${key} from namespace ${namespace}`);
    const result = await this.supabase
      .from('keystore')
      .select('*')
      .eq('name', key)
      .eq('scope', namespace)
      .limit(1);
    const error = result?.error; 
    if(error) {
      console.error("Get key error:", error);
      throw new Error(`Failed to get key: ${error.message}`);
    }
    //console.log(`Got data:`, result);
    return result?.length ? result[0].value : null;
  }
  
  // Store a key value
  async setKey(namespace: string, key: string, value: string): Promise<boolean> {
    console.log(`[Keystore setKey] Setting key '${key}' in namespace '${namespace}'`);
    try {
      // 1. Check if the key/namespace combination already exists
      console.log(`[Keystore setKey] Checking existence for ${namespace}/${key}...`);
      const checkResponse = await this.supabase
        .from('keystore')
        .select('id', { count: 'exact', head: true }) // More efficient check
        .eq('name', key)
        .eq('scope', namespace);

      // Log the raw check response for debugging
      // console.log(`[Keystore setKey] Raw check response:`, JSON.stringify(checkResponse));

      const checkError = checkResponse?.error;
      const count = checkResponse?.count;

      if (checkError) {
        console.error(`[Keystore setKey] Error checking existing key ${namespace}/${key}:`, checkError);
        throw new Error(`Failed to check existing key: ${checkError.message}`);
      }

      console.log(`[Keystore setKey] Found count for ${namespace}/${key}: ${count}`);

      // 2. Update or Insert based on the count
      let operationResult: any;
      if (count !== null && count > 0) {
        // Key exists, perform an UPDATE
        console.log(`[Keystore setKey] Updating existing key ${namespace}/${key}.`);
        operationResult = await this.supabase
          .from('keystore')
          .update({ value })
          .eq('name', key)
          .eq('scope', namespace);
      } else {
        // Key does not exist, perform an INSERT
        console.log(`[Keystore setKey] Inserting new key ${namespace}/${key}.`);
        operationResult = await this.supabase
          .from('keystore')
          .insert({ name: key, value, scope: namespace });
      }

      // 3. Check for errors during the operation
      const operationError = operationResult?.error;
      if (operationError) {
        const action = (count !== null && count > 0) ? 'update' : 'insert';
        console.error(`[Keystore setKey] Failed to ${action} key ${namespace}/${key}:`, operationError);
        throw new Error(`Failed to ${action} key: ${operationError.message}`);
      }

      console.log(`[Keystore setKey] Successfully ${ (count !== null && count > 0) ? 'updated' : 'inserted'} key ${namespace}/${key}.`);
      return true;

    } catch (error) {
      console.error(`[Keystore setKey] General error for ${namespace}/${key}:`, error);
      // Re-throw the error to be handled by the calling function/proxy
      throw error;
    }
  }
  
  // List all keys in a namespace
  async listKeys(namespace: string): Promise<string[]> {
    console.log(`Listing keys in namespace ${namespace}`);
    const { data } = await this.supabase
      .from('keystore')
      .select('name')
      .eq('scope', namespace);
    
    console.log(`Found ${data?.length || 0} keys in namespace ${namespace}`);
    return data?.length ? data.map((row: any) => row.name) : [];
  }
  
  // List all namespaces
  async listNamespaces(): Promise<string[]> {
    console.log(`[KeystoreService] Attempting listNamespaces...`);
    let queryResult: any = null;
    try {
      console.log(`[KeystoreService] Calling supabase.from('keystore').select('scope')...`);
      queryResult = await this.supabase
      .from('keystore')
      .select('scope');
      //console.log(`[KeystoreService] listNamespaces query completed. Raw result:`, queryResult);
    } catch (queryError: unknown) {
        console.error(`[KeystoreService] listNamespaces query FAILED:`, queryError);
        // Check if it's an Error object before accessing message
        const message = queryError instanceof Error ? queryError.message : String(queryError);
        throw new Error(`Failed during Supabase query for listNamespaces: ${message}`);
    }
    
    const data = queryResult?.data;
    const error = queryResult?.error;

    if (error) {
        console.error(`[KeystoreService] listNamespaces Supabase returned error:`, error);
        // Decide if we should throw or return default. Let's throw for clarity.
        throw new Error(`Supabase error listing namespaces: ${error.message || JSON.stringify(error)}`);
    }
    
    if (data?.length) {
      const namespaces = new Set<string>();
      data.forEach((row: any) => {
        if (row.scope) namespaces.add(row.scope);
      });
      const result = Array.from(namespaces);
      //console.log(`[KeystoreService] Found ${result.length} namespaces:`, result);
      return result;
    }
    
    // Fallback if data is null or empty, but no error occurred
    console.log(`[KeystoreService] No namespaces found in table, returning defaults.`);
    return ['global', 'openai']; 
  }
  
  // Get the current server time
  getServerTime(): ServerTimeResult {
    const timestamp = new Date().toISOString();
    console.log(`Getting server time: ${timestamp}`);
    return { timestamp, source: "keystore" };
  }
}

// Service metadata
const META = {
  methods: [
    { name: 'getKey', description: 'Get a stored key value' },
    { name: 'setKey', description: 'Store a key value' },
    { name: 'listKeys', description: 'List all keys in a namespace' },
    { name: 'listNamespaces', description: 'List all namespaces' },
    { name: 'getServerTime', description: 'Get current server time' }
  ]
};

// Create keystore service instance for SDK HTTP Wrapper
const keystoreService = new KeystoreService();

serve(async (req) => {
  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  try {
    // Health check endpoint
    if (req.method === "GET" && path === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: corsHeaders });
    }

    // Generic SDK proxy endpoint
    if (req.method === "POST") {
      const body = await req.json();
      
      try {
        let result;
        
        // Handle both action and chain formats
        if (body.action) {
          //console.log(`Processing action request: ${body.action}`, body);
          
          // Map action to method calls
          switch (body.action) {
            case "getKey":
              result = await keystoreService.getKey(body.namespace || 'global', body.key);
              break;
            case "setKey":
              result = await keystoreService.setKey(body.namespace || 'global', body.key, body.value);
              break;
            case "listKeys":
              result = await keystoreService.listKeys(body.namespace || 'global');
              break;
            case "listNamespaces":
              result = await keystoreService.listNamespaces();
              break;
            case "getServerTime":
              result = keystoreService.getServerTime();
              break;
            default:
              throw new Error(`Unknown action: ${body.action}`);
          }
        } 
        // Handle chain format
        else if (body.chain) {
          //console.log('Processing SDK proxy request with chain:', body.chain);
          result = await executeMethodChain(keystoreService, body.chain);
        } 
        else {
          throw new Error("Request must include either 'action' or 'chain' property");
        }
        
        //console.log('SDK proxy response:', result);
        return new Response(JSON.stringify(result), { 
          status: 200, 
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (error: unknown) {
        console.error('SDK proxy error:', error);
        const err = error instanceof Error ? error : new Error(String(error));
        return new Response(JSON.stringify({ 
          error: { 
            message: err.message,
            code: (err as any).code,
            name: err.name
          }
        }), { 
          status: (err as any).status || 500, 
          headers: corsHeaders 
        });
      }
    }
    
    // Not found response
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("Error:", err);
    console.error("Error stack:", err.stack);
    return new Response(
      JSON.stringify({ error: { message: err.message, stack: err.stack } }),
      { status: 500, headers: corsHeaders }
    );
  }
});