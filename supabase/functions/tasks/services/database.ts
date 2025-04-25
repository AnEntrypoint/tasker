import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";
import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

config({ export: true });

// Helper to determine the correct functions server URL (local vs deployed)
function getFunctionsServerUrl(): string {
  // Use SUPABASE_URL which points to the functions server (e.g., http://127.0.0.1:8000) locally
  const functionsUrl = Deno.env.get('SUPABASE_URL') || Deno.env.get('EXT_SUPABASE_URL');

  if (!functionsUrl) {
    console.error("[database.ts] Could not determine Functions Server URL from SUPABASE_URL or EXT_SUPABASE_URL");
    // Throw an error as this is critical
    throw new Error("Functions Server URL not configured in environment.");
  }

  // Assume the URL provided by env var is correct whether local or deployed
  // The key is whether the /tasks function can reach /wrappedsupabase via this URL
  const baseUrl = `${functionsUrl}/functions/v1`;
  console.log(`[database.ts] Using Functions Server URL: ${baseUrl}`);
  return baseUrl;
}

// Constants for database connection
// const SUPABASE_URL = Deno.env.get('EXT_SUPABASE_URL', ''); // Don't use this directly for proxy target
const FUNCTIONS_URL = getFunctionsServerUrl(); // Use the helper
const KEY = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY');

// Validate essential configuration
if (!KEY) {
  console.error("[database.ts] EXT_SUPABASE_SERVICE_ROLE_KEY not found in environment.");
  throw new Error("Supabase Service Role Key not configured.");
}

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
  baseUrl: `${FUNCTIONS_URL}/wrappedsupabase`, // Target wrappedsupabase via determined URL
  headers: {
    'Authorization': `Bearer ${KEY}`
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
  console.log(`[DEBUG] Using SUPABASE_URL: ${FUNCTIONS_URL}`);
  console.log(`[DEBUG] Using KEY: ${KEY!.substring(0, 10)}...`);

  try {
    let query = supabase.from('task_functions').select('*');
    
    if (taskId && !isNaN(Number(taskId))) {
      console.log(`[DEBUG] Querying by ID: ${taskId}`);
      query = query.eq('id', Number(taskId));
    } else {
      const searchTerm = taskName || taskId || '';
      console.log(`[DEBUG] Querying by name: ${searchTerm}`);
      query = query.eq('name', searchTerm);
    }
    
    console.log(`[DEBUG] Executing query...`);
    const response = await query.limit(1).single();
    
    console.log(`[DEBUG] Response received:`, JSON.stringify(response, null, 2));
    
    if (response.error) {
      console.error(`[ERROR] Task lookup failed: ${response.error.message}`);
      return null;
    }
    
    if (response) {
      console.log(`[INFO] Task found: ${response.name} (id: ${response.id})`);
      return response;
    }
    
    console.log(`[INFO] No task found`);
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
  if (!FUNCTIONS_URL /* || !KEY removed check */) {
    throw new Error("Missing Supabase configuration (URL)");
  }
  
  const allowedPaths = ["tasks", "task_results", "users"];
  
  if (!input.table || !allowedPaths.includes(input.table)) {
    throw new Error("Access denied: Table not allowed");
  }
  
  return {
    url: FUNCTIONS_URL,
    table: input.table,
  };
}
