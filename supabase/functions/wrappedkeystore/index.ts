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
  private wrappedSupabaseUrl: string;
  private serviceRoleKey: string;

  constructor() {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || 'http://127.0.0.1:8080';
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    
    if (!serviceRoleKey) {
      console.error("[KeystoreService Constructor] FATAL: SUPABASE_SERVICE_ROLE_KEY environment variable is required.");
      throw new Error("SUPABASE_SERVICE_ROLE_KEY environment variable is required");
    }

    // Use wrappedsupabase proxy as the only way to access Supabase
    const wrappedSupabaseUrl = `${supabaseUrl}/functions/v1/wrappedsupabase`;
    console.log(`[KeystoreService Constructor] Connecting to wrappedsupabase: ${wrappedSupabaseUrl}`);
    
    // Create a simple HTTP client for wrappedsupabase instead of SDK proxy
    this.wrappedSupabaseUrl = wrappedSupabaseUrl;
    this.serviceRoleKey = serviceRoleKey;
    
    console.log(`[KeystoreService Constructor] KeystoreService initialized with wrappedsupabase proxy.`);
  }

  // Helper method to call wrappedsupabase
  private async callWrappedSupabase(chain: any[]) {
    const response = await fetch(this.wrappedSupabaseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.serviceRoleKey}`,
        'apikey': this.serviceRoleKey
      },
      body: JSON.stringify({ chain })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`wrappedsupabase call failed: ${response.status} - ${error}`);
    }

    return await response.json();
  }
  

  // Get a stored key value
  async getKey(namespace: string, key: string): Promise<string | null> {
    console.log(`Getting key ${key} from namespace ${namespace}`);
    
    try {
      const result = await this.callWrappedSupabase([
        { property: 'from', args: ['keystore'] },
        { property: 'select', args: ['key_value'] },
        { property: 'eq', args: ['key_name', key] },
        { property: 'limit', args: [1] }
      ]);

      if (result.error) {
        console.error("Get key error:", result.error);
        throw new Error(`Failed to get key: ${result.error.message || JSON.stringify(result.error)}`);
      }

      if (result.data && result.data.length > 0) {
        console.log(`Successfully retrieved key ${key}`);
        return result.data[0].key_value;
      }

      console.log(`Key ${key} not found`);
      return null;
    } catch (error) {
      console.error("Get key error:", error);
      throw new Error(`Failed to get key: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // Store a key value
  async setKey(namespace: string, key: string, value: string): Promise<boolean> {
    console.log(`Setting key '${key}' in namespace '${namespace}'`);
    try {
      // Check if the key exists
      const checkResult = await this.callWrappedSupabase([
        { property: 'from', args: ['keystore'] },
        { property: 'select', args: ['id'] },
        { property: 'eq', args: ['key_name', key] },
        { property: 'limit', args: [1] }
      ]);

      if (checkResult.error) {
        console.error(`Error checking existence for ${key}:`, checkResult.error);
        throw new Error(`Failed during existence check: ${checkResult.error.message || JSON.stringify(checkResult.error)}`);
      }

      const exists = checkResult.data && checkResult.data.length > 0;
      console.log(`Key ${key} exists? ${exists}`);

      let result;
      if (exists) {
        // Update existing key
        result = await this.callWrappedSupabase([
          { property: 'from', args: ['keystore'] },
          { property: 'update', args: [{ key_value: value, updated_at: new Date().toISOString() }] },
          { property: 'eq', args: ['key_name', key] }
        ]);
      } else {
        // Insert new key
        result = await this.callWrappedSupabase([
          { property: 'from', args: ['keystore'] },
          { property: 'insert', args: [{ key_name: key, key_value: value }] }
        ]);
      }

      if (result.error) {
        const action = exists ? 'update' : 'insert';
        console.error(`Failed to ${action} key ${key}:`, result.error);
        throw new Error(`Failed to ${action} key: ${result.error.message || JSON.stringify(result.error)}`);
      }

      console.log(`Successfully ${exists ? 'updated' : 'inserted'} key ${key}`);
      return true;

    } catch (error) {
      console.error(`General error for ${key}:`, error);
      throw error;
    }
  }
  
  // List all keys in a namespace
  async listKeys(namespace: string): Promise<string[]> {
    console.log(`Listing keys in namespace ${namespace}`);
    
    try {
      const result = await this.callWrappedSupabase([
        { property: 'from', args: ['keystore'] },
        { property: 'select', args: ['key_name'] }
      ]);
      
      if (result.error) {
        console.error('Error listing keys:', result.error);
        throw new Error(`Failed to list keys: ${result.error.message || JSON.stringify(result.error)}`);
      }
      
      console.log(`Found ${result.data?.length || 0} keys`);
      return result.data?.length ? result.data.map((row: any) => row.key_name) : [];
    } catch (error) {
      console.error('Error listing keys:', error);
      throw new Error(`Failed to list keys: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // Check if a key exists in a namespace
  async hasKey(namespace: string, key: string): Promise<boolean> {
    console.log(`Checking if key ${key} exists in namespace ${namespace}`);
    
    try {
      const result = await this.callWrappedSupabase([
        { property: 'from', args: ['keystore'] },
        { property: 'select', args: ['id'] },
        { property: 'eq', args: ['key_name', key] },
        { property: 'limit', args: [1] }
      ]);
      
      if (result.error) {
        console.error('Error checking key existence:', result.error);
        throw new Error(`Failed to check key existence: ${result.error.message || JSON.stringify(result.error)}`);
      }
      
      const exists = result.data && result.data.length > 0;
      console.log(`Key ${key} exists: ${exists}`);
      return exists;
    } catch (error) {
      console.error('Error checking key existence:', error);
      throw new Error(`Failed to check key existence: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // List all namespaces
  async listNamespaces(): Promise<string[]> {
    console.log(`Attempting listNamespaces...`);
    
    try {
      const result = await this.callWrappedSupabase([
        { property: 'from', args: ['keystore'] },
        { property: 'select', args: ['scope'] }
      ]);

      if (result.error) {
        console.error(`listNamespaces error:`, result.error);
        throw new Error(`Failed to list namespaces: ${result.error.message || JSON.stringify(result.error)}`);
      }
      
      if (result.data?.length) {
        const namespaces = new Set<string>();
        result.data.forEach((row: any) => {
          if (row.scope) namespaces.add(row.scope);
        });
        const namespaceList = Array.from(namespaces);
        console.log(`Found ${namespaceList.length} namespaces:`, namespaceList);
        return namespaceList;
      }
      
      console.log(`No namespaces found in table, returning defaults.`);
      return ['global', 'openai'];
    } catch (error) {
      console.error(`listNamespaces error:`, error);
      throw new Error(`Failed to list namespaces: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    { name: 'hasKey', description: 'Check if a key exists in a namespace' },
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