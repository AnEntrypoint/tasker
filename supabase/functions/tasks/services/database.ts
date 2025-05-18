import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";
import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

config({ export: true });

// Helper to determine the correct wrappedsupabase proxy URL
function getWrappedSupabaseProxyUrl(): string {
  const extSupabaseUrl = Deno.env.get('EXT_SUPABASE_URL');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  
  // Always use localhost:54321 for local development REST API
  const defaultUrl = "http://localhost:54321";
  const edgeFunctionsUrl = "http://127.0.0.1:8000";

  if (extSupabaseUrl) {
    // If using local development URL for edge functions, use REST API URL instead
    if (extSupabaseUrl.includes('127.0.0.1:8000')) {
      console.log("[database.ts] Found edge functions URL in EXT_SUPABASE_URL, using REST API URL instead:", defaultUrl);
      return `${defaultUrl}/functions/v1/wrappedsupabase`;
    }
    console.log("[database.ts] Using EXT_SUPABASE_URL for wrappedsupabase:", extSupabaseUrl);
    return `${extSupabaseUrl}/functions/v1/wrappedsupabase`;
  } else if (supabaseUrl) {
    // If using local development URL for edge functions, use REST API URL instead
    if (supabaseUrl.includes('127.0.0.1:8000')) {
      console.log("[database.ts] Found edge functions URL in SUPABASE_URL, using REST API URL instead:", defaultUrl);
      return `${defaultUrl}/functions/v1/wrappedsupabase`;
    }
    console.log("[database.ts] Using SUPABASE_URL for wrappedsupabase:", supabaseUrl);
    return `${supabaseUrl}/functions/v1/wrappedsupabase`;
  } else {
    console.log("[database.ts] Neither EXT_SUPABASE_URL nor SUPABASE_URL found in environment. Using default:", defaultUrl);
    return `${defaultUrl}/functions/v1/wrappedsupabase`;
  }
}

const WRAPPED_SUPABASE_PROXY_URL = getWrappedSupabaseProxyUrl();
const SERVICE_ROLE_KEY = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY') || 
                          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || 
                          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

if (!SERVICE_ROLE_KEY) {
  console.error("[database.ts] EXT_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY not found in environment.");
  throw new Error("Supabase Service Role Key not configured.");
}

console.log("[database.ts] Final wrappedsupabase proxy baseUrl:", WRAPPED_SUPABASE_PROXY_URL);
console.log("[database.ts] Using service role key:", SERVICE_ROLE_KEY ? '[REDACTED]' : 'undefined');

/**
 * Interface for tracked deleted items in global scope
 */
declare global {
  var __deletedItems: Set<string> | undefined;
}

// Initialize global deleted items set if not already present
if (!globalThis.__deletedItems) {
  globalThis.__deletedItems = new Set<string>();
}

// Create service proxy
const supabase = createServiceProxy('supabase', {
  baseUrl: WRAPPED_SUPABASE_PROXY_URL,
  headers: {
    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
  }
});

/**
 * Enhanced database client
 */
export const supabaseClient = {
  from(table: string) {
    return supabase.from(table);
  }
};

/**
 * Fetch task from the database
 */
export async function fetchTaskFromDatabase(taskId?: string, taskName?: string): Promise<any> {
  if (!taskId && !taskName) {
    console.error("Database query error: Either taskId or taskName must be provided");
    return null;
  }

  console.log(`[INFO] Fetching task: ${taskId || taskName}`);

  try {
    // Try using the SDK wrapper first
    let query = supabase.from('task_functions').select('*');
    
    if (taskId && !isNaN(Number(taskId))) {
      query = query.eq('id', Number(taskId));
    } else {
      const searchTerm = taskName || taskId || '';
      query = query.eq('name', searchTerm);
    }
    
    try {
      const response = await query.limit(1).single();
      
      if (response.error) {
        console.error(`[ERROR] Task lookup failed: ${response.error.message}`);
      } else if (response) {
        console.log(`[INFO] Task found: ${response.name} (id: ${response.id})`);
        return response;
      }
    } catch (sdkError) {
      console.error(`[ERROR] SDK task fetch error: ${sdkError instanceof Error ? sdkError.message : String(sdkError)}`);
      // Fall through to direct fetch if SDK fails
    }
    
    // If SDK wrapper fails, try direct fetch
    console.log(`[INFO] Falling back to direct fetch for task: ${taskId || taskName}`);
    
    const baseUrl = Deno.env.get('SUPABASE_URL') || 'http://localhost:54321';
    const serviceRoleKey = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY') || 
                           Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    
    if (!serviceRoleKey) {
      throw new Error("Service role key not available for direct fetch");
    }
    
    let url = `${baseUrl}/rest/v1/task_functions?`;
    
    if (taskId && !isNaN(Number(taskId))) {
      url += `select=*&id=eq.${encodeURIComponent(taskId)}`;
    } else {
      const searchTerm = taskName || taskId || '';
      url += `select=*&name=eq.${encodeURIComponent(searchTerm)}`;
    }
    
    url += '&limit=1';
    
    console.log(`[DEBUG] Direct fetch URL: ${url}`);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (Array.isArray(data) && data.length > 0) {
      console.log(`[INFO] Task found via direct fetch: ${data[0].name} (id: ${data[0].id})`);
      return data[0];
    }
    
    console.log(`[INFO] No task found via direct fetch`);
    return null;
  } catch (error) {
    console.error(`[ERROR] Database fetch error: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Save task result to the database
 */
export async function saveTaskResult(taskId: string, result: any): Promise<boolean> {
  if (!taskId) {
    console.error("Database error: Task ID is required");
    return false;
  }
  
  try {
    const { error } = await supabase.from('task_results').insert({
      task_id: taskId,
      result,
      created_at: new Date().toISOString()
    });
    
    if (error) {
      console.error("Database save error:", error.message);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error("Database save error:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Handle Supabase access for external tasks
 */
export async function handleSupabaseAccess(input: any): Promise<any> {
  if (!WRAPPED_SUPABASE_PROXY_URL /* || !SERVICE_ROLE_KEY removed check */) {
    throw new Error("Missing Supabase configuration (URL)");
  }
  
  const allowedPaths = ["tasks", "task_results", "users"];
  
  if (!input.table || !allowedPaths.includes(input.table)) {
    throw new Error("Access denied: Table not allowed");
  }
  
  return {
    url: WRAPPED_SUPABASE_PROXY_URL,
    table: input.table,
  };
}
