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
        throw new Error(`Error fetching pending runs: ${pendingError.message}`);
      }
      
      if (!pendingRuns || pendingRuns.length === 0) {
        log("info", "No pending runs to process");
        return;
      }
      
      stackRunId = pendingRuns[0].id;
    }
    
    log("info", `Processing stack run: ${stackRunId}`);
    
    // Mark as processing to avoid race conditions
      const { error: updateError } = await supabase
        .from("stack_runs")
      .update({
        status: "processing",
        updated_at: new Date().toISOString()
      })
        .eq("id", stackRunId);
      
      if (updateError) {
      throw new Error(`Error updating stack run to processing: ${updateError.message}`);
      }
    
    // Fetch the stack run details
    const { data: stackRun, error: fetchError } = await supabase
        .from("stack_runs")
        .select("*")
        .eq("id", stackRunId)
      .maybeSingle();
      
    if (fetchError) {
      throw new Error(`Error fetching stack run: ${fetchError.message}`);
    }
    
    if (!stackRun) {
      throw new Error(`Stack run not found: ${stackRunId}`);
    }
    
    // Use either module_name or service_name for compatibility
    const moduleName = stackRun.module_name || stackRun.service_name || 'unknown';
    const methodName = stackRun.method_name;
    
    log("info", `Stack run fetched: ${moduleName}.${methodName}`);
    
    // Process based on module name and method name
      let result;
      
    // Check if this is a task execution
    if ((moduleName === "tasks" || moduleName === "task") && methodName === "execute") {
      // Process tasks.execute call
      log("info", `Processing tasks.execute call with args: ${JSON.stringify(stackRun.args)}`);
      result = await processTaskExecute(stackRun.args, stackRunId, stackRun.parent_task_run_id || null);
    } else if (moduleName === "gapi") {
      // Process GAPI calls
      // Ensure method is a string and handle the two supported methods explicitly
      if (methodName === "authenticate") {
        log("info", `Processing gapi.authenticate call with args: ${JSON.stringify(stackRun.args)}`);
        result = await callGapi("authenticate", stackRun.args);
      } else if (methodName === "admin.directory.domains.list") {
        log("info", `Processing gapi.admin.directory.domains.list call with args: ${JSON.stringify(stackRun.args)}`);
        result = await callGapi("admin.directory.domains.list", stackRun.args);
      } else {
        // For unknown/unsupported methods, throw a descriptive error
        const method = methodName || "unknown";
        log("error", `Unsupported gapi method: ${method}`);
        throw new Error(`Unsupported gapi method: ${method}`);
      }
    } else {
      // Handle other service modules
      try {
        log("info", `Processing ${moduleName}.${methodName} call with service proxy`);
        result = await callService(moduleName, methodName, stackRun.args);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Unsupported module/method: ${moduleName}.${methodName}: ${errorMessage}`);
      }
    }
    
    log("info", `Task executed successfully, raw result: ${JSON.stringify(result)}`);
    
    // Unwrap the result from the QuickJS response if needed
    let finalResult = result;
    if (result && typeof result === 'object') {
      // Handle both formats returned by QuickJS
      if (result.result !== undefined) {
        finalResult = result.result;
        log("info", `Extracted result from result.result: ${JSON.stringify(finalResult)}`);
      }
      }
      
    // Update the stack run with the successful result
    const { error: completeError } = await supabase
          .from("stack_runs")
          .update({
            status: "completed",
        result: finalResult,
            updated_at: new Date().toISOString()
          })
          .eq("id", stackRunId);
        
    if (completeError) {
      throw new Error(`Error updating stack run to completed: ${completeError.message}`);
    }
    
    // Update any relevant task runs if this was a direct task call
    if (stackRun && stackRun.parent_task_run_id) {
      const parentRunId = stackRun.parent_task_run_id;
      log("info", `Updating parent task run ${parentRunId} with result`);
      
      try {
        // CRITICAL: This update needs to happen correctly for the task to show as completed
        if (parentRunId) {
          await updateTaskRun(parentRunId, finalResult);
          log("info", `Successfully updated parent task run ${parentRunId} with completed status and result`);
        } else {
          log("warn", "Parent run ID is defined but empty, skipping update");
        }
      } catch (updateError) {
        const errorMessage = updateError instanceof Error ? updateError.message : String(updateError);
        log("error", `Failed to update parent task run ${parentRunId}: ${errorMessage}`);
      
        // Try a direct update as a fallback
        try {
          log("info", `Attempting direct update of task_runs record ${parentRunId}`);
          const { url, serviceRoleKey } = getSupabaseConfig();
          
          if (serviceRoleKey) {
            const supabase = createClient(url, serviceRoleKey);
            
            const { error: directUpdateError } = await supabase
              .from("task_runs")
          .update({
                status: "completed",
                result: finalResult,
                updated_at: new Date().toISOString(),
                ended_at: new Date().toISOString()
          })
              .eq("id", parentRunId);
        
            if (directUpdateError) {
              log("error", `Direct update also failed: ${directUpdateError.message}`);
            } else {
              log("info", `Direct update of task_runs record ${parentRunId} succeeded`);
            }
          }
        } catch (directError) {
          log("error", `Exception during direct update: ${directError instanceof Error ? directError.message : String(directError)}`);
        }
      }
    }
    
    // Check if this run has a parent stack run that's waiting on it
    let waitingParents = null;
    let hasWaitingColumn = false; 
    
    // First check if the waiting_on_stack_run_id column exists
    try {
      // Check if the column exists by querying the information schema
      const { data: columnExists, error: columnError } = await supabase
        .from("information_schema.columns")
        .select("column_name")
        .eq("table_name", "stack_runs")
        .eq("column_name", "waiting_on_stack_run_id")
        .maybeSingle();

      // If we got data and no error, the column exists
      if (!columnError && columnExists) {
        hasWaitingColumn = true;
        log("info", "waiting_on_stack_run_id column exists in stack_runs table");
      } else {
        log("warn", "waiting_on_stack_run_id column does not exist in stack_runs table. Skipping parent run checks.");
        hasWaitingColumn = false;
        waitingParents = [];
      }
    } catch (columnCheckError: unknown) {
      const errorMessage = columnCheckError instanceof Error ? columnCheckError.message : String(columnCheckError);
      log("warn", `Error checking for waiting_on_stack_run_id column: ${errorMessage}`);
      hasWaitingColumn = false;
      waitingParents = [];
    }
    
    // Only proceed with the waiting parents check if the column exists
    if (hasWaitingColumn) {
      try {
        const { data: fetchedParents, error: waitingError } = await supabase
          .from("stack_runs")
          .select("id")
          .eq("waiting_on_stack_run_id", stackRunId)
          .eq("status", "suspended_waiting_child");
        
        if (!waitingError) {
          waitingParents = fetchedParents;
        } else {
          log("error", `Error checking for waiting parent runs: ${waitingError.message}`);
          waitingParents = [];
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log("error", `Exception checking for waiting parent runs: ${errorMessage}`);
        waitingParents = [];
      }
    }
    
    // If we have waiting parents, resume them
    if (waitingParents && waitingParents.length > 0) {
      const parentStackRunId = waitingParents[0].id;
      
      if (!parentStackRunId) {
        log("warn", "Parent stack run ID is undefined, skipping resumption");
        return finalResult;
      }
      
      log("info", `Found parent stack run ${parentStackRunId} waiting on this run, preparing resumption`);
      
      try {
        // Prepare parent for resumption with this result
        const updateData: Record<string, any> = {
          status: "pending_resume",
          result: finalResult,
          updated_at: new Date().toISOString()
        };
        
        // Only add resume_payload and waiting_on_stack_run_id if the columns exist
        try {
          updateData.resume_payload = finalResult;
          if (hasWaitingColumn) {
            updateData.waiting_on_stack_run_id = null;
          }
        } catch (e) {
          log("warn", "Could not set some fields, columns may not exist");
        }
        
        const { error: resumeError } = await supabase
          .from("stack_runs")
          .update(updateData)
          .eq("id", parentStackRunId);
        
        if (resumeError) {
          log("error", `Error updating parent for resumption: ${resumeError.message}`);
        } else {
          log("info", `Parent stack run ${parentStackRunId} marked for resumption with our result`);
          
          // Immediately process the parent stack run to continue execution
          return await processStackRun(parentStackRunId);
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log("error", `Exception updating parent for resumption: ${errorMessage}`);
      }
    }
    
    // Check for more pending runs
    const { data: nextPendingRun, error: nextError } = await supabase
      .from("stack_runs")
      .select("id")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
      
    if (nextError) {
      log("error", `Error checking for more pending runs: ${nextError.message}`);
    } else if (nextPendingRun) {
      log("info", `Found another pending run: ${nextPendingRun.id}, processing...`);
      return await processStackRun(nextPendingRun.id);
      } else {
      log("info", "No more pending runs to process");
      }
      
    return finalResult;
    } catch (error) {
    log("error", `Error processing stack run: ${error instanceof Error ? error.message : String(error)}`);
      
    // If we have a stack run ID, update it to failed
    if (stackRunId) {
      try {
        const { url, serviceRoleKey } = getSupabaseConfig();
        
        if (serviceRoleKey) {
          const supabase = createClient(url, serviceRoleKey);
          
          await supabase
            .from("stack_runs")
            .update({
              status: "failed",
              error: { message: error instanceof Error ? error.message : String(error) },
              updated_at: new Date().toISOString()
            })
            .eq("id", stackRunId);
        }
      } catch (updateError) {
        log("error", `Failed to update stack run status after error: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
      }
    }
    
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
        directExecution: true,
        taskName: taskName,
        stackRunId: stackRunId,
        taskInput: input
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
    
    log("info", `Task executed successfully, raw result: ${JSON.stringify(result)}`);
    
    // Return the unwrapped result
    return result.result || result;
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
  } catch (error: unknown) {
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

// Helper function to update a task run with the final result
async function updateTaskRun(taskRunId: string, result: any, status: string = 'completed'): Promise<void> {
  if (!taskRunId) {
    log("warn", "No task run ID provided to update");
    return;
  }
  
  try {
    const { url, serviceRoleKey } = getSupabaseConfig();
    
    if (!serviceRoleKey) {
      throw new Error("Missing service role key");
    }
    
    const supabase = createClient(url, serviceRoleKey);
    
    log("info", `Updating task run ${taskRunId} with status ${status}`);
    
    const { error } = await supabase
      .from('task_runs')
      .update({
        status,
        result,
        updated_at: new Date().toISOString(),
        ended_at: new Date().toISOString()
      })
      .eq('id', taskRunId);
    
    if (error) {
      log("error", `Error updating task run ${taskRunId}: ${error.message}`);
    } else {
      log("info", `Task run ${taskRunId} updated successfully`);
    }
  } catch (error) {
    log("error", `Exception updating task run ${taskRunId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Special handler for tasks.execute calls
async function processTaskExecute(args: any[], stackRunId: string, parent_task_run_id?: string | null): Promise<any> {
  const [taskName, taskInput] = args;
  log("info", `Calling tasks.execute with taskName=${taskName}`);
  
  try {
    const result = await executeTask(taskName, taskInput);
    log("info", `Task executed successfully, raw result: ${JSON.stringify(result)}`);
    
    // Extract the actual result from the response
    let finalResult = result;
    if (result && typeof result === 'object') {
      // Handle both formats returned by QuickJS
      if (result.result !== undefined) {
        finalResult = result.result;
        log("info", `Extracted result from result.result: ${JSON.stringify(finalResult)}`);
      }
    }
    
    // If this task was triggered from a task_run record, update its status directly
    if (parent_task_run_id) {
      try {
        const { url, serviceRoleKey } = getSupabaseConfig();
        if (!serviceRoleKey) {
          log("error", "Missing service role key, cannot update parent task run");
        } else {
          const supabase = createClient(url, serviceRoleKey);
          
          log("info", `Directly updating task_runs record ${parent_task_run_id} with completed status and result`);
          
          // CRITICAL: This is the most important step - updating the task_run record to completed
          const { error: taskRunUpdateError } = await supabase
      .from("task_runs")
      .update({
              status: "completed",
              result: finalResult,
              updated_at: new Date().toISOString(),
              ended_at: new Date().toISOString()
      })
            .eq("id", parent_task_run_id);
    
          if (taskRunUpdateError) {
            log("error", `Error updating task_runs record: ${taskRunUpdateError.message}`);
          } else {
            log("info", `Successfully updated task_runs record ${parent_task_run_id} with status 'completed'`);
          }
        }
      } catch (updateError: unknown) {
        const errorMessage = updateError instanceof Error ? updateError.message : String(updateError);
        log("error", `Exception updating task_runs record: ${errorMessage}`);
        // Don't throw here, we still want to return the result
      }
    } else {
      log("warn", "No parent_task_run_id provided, cannot update task_runs record");
    }
    
    // Return the unwrapped result
    return finalResult;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error executing task: ${errorMessage}`);
    
    // If this task was triggered from a task_run record, update its status to failed
    if (parent_task_run_id) {
      try {
        const { url, serviceRoleKey } = getSupabaseConfig();
        if (!serviceRoleKey) {
          log("error", "Missing service role key, cannot update parent task run");
        } else {
          const supabase = createClient(url, serviceRoleKey);
          
          log("info", `Directly updating task_runs record ${parent_task_run_id} with failed status`);
          
          const { error: taskRunUpdateError } = await supabase
            .from("task_runs")
            .update({
              status: "failed",
              error: { message: errorMessage },
              updated_at: new Date().toISOString(),
              ended_at: new Date().toISOString()
            })
            .eq("id", parent_task_run_id);
    
          if (taskRunUpdateError) {
            log("error", `Error updating task_runs record: ${taskRunUpdateError.message}`);
          } else {
            log("info", `Successfully updated task_runs record ${parent_task_run_id} with status 'failed'`);
          }
        }
      } catch (updateError: unknown) {
        const errorMessage = updateError instanceof Error ? updateError.message : String(updateError);
        log("error", `Exception updating task_runs record: ${errorMessage}`);
      }
    }
    
    throw new Error(`Task execution failed: ${errorMessage}`);
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