import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";
// import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts"; // Removed dotenv

// config({ export: true }); // Removed dotenv

// Helper to determine the correct wrappedsupabase proxy URL
function getWrappedSupabaseProxyUrl(): string {
  const extSupabaseUrl = Deno.env.get('EXT_SUPABASE_URL');
  const defaultEdgeFunctionsUrl = "http://127.0.0.1:8000"; // Default for local edge functions

  if (extSupabaseUrl) {
    console.log("[database.ts] Using EXT_SUPABASE_URL for wrappedsupabase base:", extSupabaseUrl);
    return `${extSupabaseUrl}/functions/v1/wrappedsupabase`;
  }
  console.warn("[database.ts] EXT_SUPABASE_URL not found. Falling back to default for wrappedsupabase proxy.");
  return `${defaultEdgeFunctionsUrl}/functions/v1/wrappedsupabase`;
}

const WRAPPED_SUPABASE_PROXY_URL = getWrappedSupabaseProxyUrl();

// Rely primarily on EXT_ prefixed variables provided by Supabase Edge Runtime
const SERVICE_ROLE_KEY = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY') || 
                          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"; // Hardcoded fallback

const ANON_KEY = Deno.env.get('EXT_SUPABASE_ANON_KEY') ||
                 "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"; // Hardcoded fallback

if (!Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY')) {
  console.warn("[database.ts] EXT_SUPABASE_SERVICE_ROLE_KEY not found in environment. Using hardcoded fallback.");
}
if (!Deno.env.get('EXT_SUPABASE_ANON_KEY')) {
  console.warn("[database.ts] EXT_SUPABASE_ANON_KEY not found in environment. Using hardcoded fallback.");
}

console.log("[database.ts] Final wrappedsupabase proxy baseUrl:", WRAPPED_SUPABASE_PROXY_URL);
console.log("[database.ts] Using service role key (from EXT_SUPABASE_SERVICE_ROLE_KEY or fallback):", SERVICE_ROLE_KEY ? '[REDACTED]' : 'undefined');
console.log("[database.ts] Using anon key (from EXT_SUPABASE_ANON_KEY or fallback):", ANON_KEY ? '[REDACTED]' : 'undefined');

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
    
    // For direct fetch, target the KONG URL ( Supabase REST API endpoint)
    // EXT_SUPABASE_URL should point to the functions server (e.g., http://127.0.0.1:8000)
    // SUPABASE_URL (if set by runtime) might be http://kong:8000
    const directDbBaseUrl = Deno.env.get('SUPABASE_URL') || 'http://127.0.0.1:8000'; // Prefer SUPABASE_URL if available (kong), else public functions URL

    // Keys for direct fetch should also prioritize EXT_ versions from the runtime
    const currentServiceRoleKey = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY') || SERVICE_ROLE_KEY;
    const currentAnonKey = Deno.env.get('EXT_SUPABASE_ANON_KEY') || ANON_KEY;
    
    if (!currentServiceRoleKey) {
      throw new Error("Service role key not available for direct fetch (after checking EXT_ and fallback)");
    }
    if (!currentAnonKey) {
      throw new Error("Anon key not available for direct fetch (after checking EXT_ and fallback)");
    }
    
    let url = `${directDbBaseUrl}/rest/v1/task_functions?`;
    
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
        'Authorization': `Bearer ${currentServiceRoleKey}`,
        'apikey': currentAnonKey // CORRECTED: Use Anon Key for apikey
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
