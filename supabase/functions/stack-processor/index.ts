// supabase/functions/stack-processor/index.ts
// Processes pending stack runs in the database
// This edge function is triggered when a new pending stack run is created

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.131.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.1";
import { corsHeaders } from "../_shared/cors.ts";
import { 
  prepareStackRunResumption, 
  aggregateTaskResults,
  updateStackRun 
} from "../quickjs/vm-state-manager.ts";
import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";

// Configuration for the Supabase client
function getSupabaseConfig() {
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  
  // Handle both local and production environments
  let url = Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
  
  // If we're in a Supabase Edge Function runtime, we need to use kong for local development
  if (Deno.env.get("SUPABASE_EDGE_RUNTIME_IS_LOCAL") === "true") {
    url = "http://kong:8000";
  }
  
  return { url, serviceRoleKey };
}

// Log function with timestamp and prefix
function log(level: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}${data !== undefined ? ' ' + JSON.stringify(data) : ''}`);
}

// Define a type for method chain items
interface MethodChainItem {
  type: string;
  property: string;
  args?: any[];
}

// The main function to process a stack run
async function processStackRun(stackRunId?: string) {
  try {
    const { url, serviceRoleKey } = getSupabaseConfig();
    
    if (!serviceRoleKey) {
      throw new Error("Missing service role key");
    }
    
    const supabase = createClient(url, serviceRoleKey);
    
    // If no stack run ID is provided, find the oldest pending one
    if (!stackRunId) {
      log("info", "No stack run ID provided, finding oldest pending run");
      
      const { data: pendingRuns, error: pendingError } = await supabase
        .from("stack_runs")
        .select("id, created_at")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(1);
      
      if (pendingError) {
        throw new Error(`Error finding pending runs: ${pendingError.message}`);
      }
      
      if (!pendingRuns || pendingRuns.length === 0) {
        log("info", "No pending stack runs found, exiting");
        return { success: true, message: "No pending stack runs found" };
      }
      
      stackRunId = pendingRuns[0].id;
    }
    
    log("info", `Processing stack run: ${stackRunId}`);
    
    // Get the stack run details
    const { data: stackRun, error: getError } = await supabase
      .from("stack_runs")
      .select("*")
      .eq("id", stackRunId)
      .single();
    
    if (getError) {
      throw new Error(`Error retrieving stack run: ${getError.message}`);
    }
    
    if (!stackRun) {
      throw new Error(`Stack run not found: ${stackRunId}`);
    }
    
    // If the stack run is already completed, just return success
    if (stackRun.status !== "pending") {
      log("info", `Stack run ${stackRunId} is already ${stackRun.status}, skipping`);
      return { success: true, message: `Stack run already ${stackRun.status}` };
    }
    
    // Mark the stack run as processing
      const { error: updateError } = await supabase
        .from("stack_runs")
        .update({ status: "processing", updated_at: new Date().toISOString() })
        .eq("id", stackRunId);
      
      if (updateError) {
      throw new Error(`Error updating stack run to processing: ${updateError.message}`);
    }
    
    // Extract the details we need for processing
    const { module_name, service_name, method_name, args, parent_run_id } = stackRun;
    
    // Validate required fields - use service_name as fallback for module_name
    const moduleName = module_name || service_name;
    
    if (!moduleName) {
      throw new Error(`Stack run ${stackRunId} has no module_name or service_name. Full record: ${JSON.stringify(stackRun)}`);
    }
    
    if (!method_name) {
      throw new Error(`Stack run ${stackRunId} has no method_name. Full record: ${JSON.stringify(stackRun)}`);
    }
    
    log("info", `Stack run fetched: ${moduleName}.${method_name}`);
    
    // Process the stack run based on its module and method
    let result;
    try {
      log("info", `Processing ${moduleName}.${method_name} call with${args ? ' args: ' + JSON.stringify(args) : 'out args'}`);
      
      // Update the parent task run if it exists
      if (parent_run_id) {
        const { error: parentUpdateError } = await supabase
          .from("task_runs")
          .update({ status: "processing", updated_at: new Date().toISOString() })
          .eq("id", parent_run_id);
        
        if (parentUpdateError) {
          log("error", `Error updating parent task run: ${parentUpdateError.message}`);
          // Continue anyway, this is not fatal
        } else {
          log("info", `Parent task run ${parent_run_id} updated successfully`);
        }
      }
      
      // Execute the appropriate service method
      if ((moduleName === "tasks" || moduleName === "task") && method_name === "execute") {
        // For tasks.execute, call the tasks function
        if (!args || args.length < 1) {
          throw new Error("No task name provided in args for tasks.execute");
        }
        const taskName = args[0];
        const taskInput = args.length > 1 ? args[1] : {};
        
        log("info", `Calling tasks.execute with taskName=${taskName}`);
        result = await executeTask(taskName, taskInput);
      } else if (moduleName === "gapi" && method_name === "authenticate") {
        // Handle gapi.authenticate
        log("info", `Calling gapi.authenticate with args: ${JSON.stringify(args)}`);
        result = await callGapi("authenticate", args);
      } else if (moduleName === "gapi") {
        // Handle other gapi methods
        log("info", `Calling gapi.${method_name} with args: ${JSON.stringify(args)}`);
        result = await callGapi(method_name, args);
      } else {
        // Handle other service methods
        log("info", `Calling generic service: ${moduleName}.${method_name} with args: ${JSON.stringify(args)}`);
        result = await callService(moduleName, method_name, args);
      }
      
      log("info", `Task executed successfully: ${moduleName}.${method_name}`);
      
      // Update the stack run with the successful result
      const { error: completeError } = await supabase
          .from("stack_runs")
        .update({
          status: "completed",
          result: result,
          updated_at: new Date().toISOString()
        })
        .eq("id", stackRunId);
      
      if (completeError) {
        throw new Error(`Error updating stack run to completed: ${completeError.message}`);
      }
      
      // Update parent task run with result if this is directly called from a task
      if (parent_run_id) {
        log("info", `Updating parent task run ${parent_run_id} with result`);
        
        const { error: parentResultError } = await supabase
          .from("task_runs")
          .update({
            status: "completed",
            result: result,
            updated_at: new Date().toISOString()
          })
          .eq("id", parent_run_id);
        
        if (parentResultError) {
          log("error", `Error updating parent task run with result: ${parentResultError.message}`);
          // Continue anyway, this is not fatal
        } else {
          log("info", `Parent task run ${parent_run_id} updated successfully`);
        }
      }
      
      return { success: true, result, message: `Stack run ${stackRunId} processed successfully` };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("error", `Error processing stack run: ${errorMessage}`);
      
      // Update the stack run with the error
      const { error: failError } = await supabase
        .from("stack_runs")
        .update({
          status: "failed",
          error: errorMessage,
          updated_at: new Date().toISOString()
        })
        .eq("id", stackRunId);
      
      if (failError) {
        log("error", `Error updating stack run to failed: ${failError.message}`);
      }
      
      // Update parent task run with the error if it exists
      if (parent_run_id) {
        log("error", `Updating parent task run ${parent_run_id} with error: ${errorMessage}`);
        
        const { error: parentErrorUpdate } = await supabase
          .from("task_runs")
          .update({
            status: "failed",
            error: errorMessage,
            updated_at: new Date().toISOString()
          })
          .eq("id", parent_run_id);
        
        if (parentErrorUpdate) {
          log("error", `Error updating parent task run with error: ${parentErrorUpdate.message}`);
        }
      }
      
      throw new Error(`Error processing stack run: ${errorMessage}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error in processStackRun: ${errorMessage}`);
    throw error;
  }
}

// Helper function to execute a task
async function executeTask(taskName: string, input: any): Promise<any> {
  log("info", `Executing task: ${taskName}`);
  
  const { url, serviceRoleKey } = getSupabaseConfig();
  
  if (!serviceRoleKey) {
    throw new Error("Missing service role key");
  }
  
  // Prepare the QuickJS function call
  log("info", `Using quickjs URL: ${url}/functions/v1/quickjs`);
  
  // Generate stack run ID for this QuickJS execution
  const stackRunId = crypto.randomUUID();
  
  log("info", `Preparing to call QuickJS with:
      - Task: ${taskName}
      - StackRunId: ${stackRunId}
      - Input: ${JSON.stringify(input)}
    `);
  
  try {
    // Call the QuickJS edge function directly 
    const response = await fetch(`${url}/functions/v1/quickjs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`
      },
      body: JSON.stringify({
        direct: true,
        taskName: taskName,
        stackRunId: stackRunId,
        input: input
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`QuickJS call failed with status ${response.status}: ${errorText}`);
    }
    
    const result = await response.json();
    
    if (result.error) {
      throw new Error(`Task executed with error: ${result.error}`);
    }
    
    log("info", `Task executed successfully: ${JSON.stringify(result.result || {})}`);
    
    // Return the unwrapped result
    return result.result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error executing task: ${errorMessage}`);
    throw new Error(`Task execution failed: ${errorMessage}`);
  }
}

// Helper function to call gapi services
async function callGapi(method: string, args: any[]): Promise<any> {
  log("info", `Calling gapi.${method} with args: ${JSON.stringify(args)}`);
  
  const { url, serviceRoleKey } = getSupabaseConfig();
  
  if (!serviceRoleKey) {
    throw new Error("Missing service role key");
  }
  
  try {
    // Build the method chain based on the method
    const chain: MethodChainItem[] = [{ type: "get", property: "gapi" }];
    
    if (method === "authenticate") {
      chain.push({ type: "call", property: "authenticate", args });
    } else {
      // For other methods, you'd need to build the chain accordingly
      chain.push({ type: "call", property: method, args });
    }
    
    // Call the wrappedgapi function
    const response = await fetch(`${url}/functions/v1/wrappedgapi`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`
      },
      body: JSON.stringify({ chain })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`gapi.${method} call failed with status ${response.status}: ${errorText}`);
    }
    
    const result = await response.json();
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error calling gapi.${method}: ${errorMessage}`);
    throw new Error(`gapi.${method} call failed: ${errorMessage}`);
  }
}

// Helper function to call other services
async function callService(service: string, method: string, args: any[]): Promise<any> {
  log("info", `Calling ${service}.${method} with args: ${JSON.stringify(args)}`);
  
  const { url, serviceRoleKey } = getSupabaseConfig();
  
  if (!serviceRoleKey) {
    throw new Error("Missing service role key");
  }
  
  try {
    // Map service name to edge function name
    const functionName = `wrapped${service}`;
    
    // Build the proper chain for the service
    // For this example, we're assuming it's a direct method call
    const chain: MethodChainItem[] = [
      { type: "get", property: service },
      { type: "call", property: method, args }
    ];
    
    // Call the wrapped service
    const response = await fetch(`${url}/functions/v1/${functionName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`
      },
      body: JSON.stringify({ chain })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${service}.${method} call failed with status ${response.status}: ${errorText}`);
    }
    
    const result = await response.json();
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error calling ${service}.${method}: ${errorMessage}`);
    throw new Error(`${service}.${method} call failed: ${errorMessage}`);
  }
}

// Check if there are more pending stack runs that need processing
async function checkForMorePendingRuns(): Promise<boolean> {
  try {
    const { url, serviceRoleKey } = getSupabaseConfig();
    
    if (!serviceRoleKey) {
      throw new Error("Missing service role key");
    }
    
    const supabase = createClient(url, serviceRoleKey);
    
    const { data, error } = await supabase
      .from("stack_runs")
      .select("id")
      .eq("status", "pending")
      .limit(1);
    
    if (error) {
      log("error", `Error checking for more pending runs: ${error.message}`);
      return false;
    }
    
    return data !== null && data.length > 0;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error checking for more pending runs: ${errorMessage}`);
    return false;
  }
}

// Process the next pending stack run if available
async function processNextPendingRun(): Promise<void> {
  try {
    const hasMorePending = await checkForMorePendingRuns();
    
    if (hasMorePending) {
      log("info", "Found more pending runs, processing next one");
      
      // Trigger the next run by calling this function again
      const { url, serviceRoleKey } = getSupabaseConfig();
      
      if (!serviceRoleKey) {
        throw new Error("Missing service role key");
      }
      
      await fetch(`${url}/functions/v1/stack-processor`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${serviceRoleKey}`
        },
        body: JSON.stringify({ trigger: "process-next" })
      });
    } else {
      log("info", "No more pending runs to process");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error processing next pending run: ${errorMessage}`);
  }
}

// The main handler for incoming requests
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  
  try {
    // Process the request body
    const body = await req.json();
    const { stackRunId, trigger } = body;
    
    log("info", `Stack processor triggered${stackRunId ? ` for stack run ${stackRunId}` : trigger ? ` by ${trigger}` : ''}`);
    
    // If this is coming from a db trigger or cron, just log and process
    if (body.type === "db_change" || body.type === "cron") {
      log("info", `Triggered by ${body.type}`);
    }
    
    // If doing direct processing for a specific task run ID
    if (body.direct && body.taskRunId) {
      log("info", `Direct processing triggered`);
      log("info", `Direct processing for task: ${body.taskName}, runId: ${body.taskRunId}`);
      
      const result = await processStackRun(body.stackRunId);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    
    // Process the specified stack run or find the next pending one
    await processStackRun(stackRunId);
    
    // Check if there are more pending runs to process
    await processNextPendingRun();
    
    return new Response(JSON.stringify({ success: true, message: "Stack run processed" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error processing request: ${errorMessage}`);
    
    return new Response(JSON.stringify({ success: false, error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}); 