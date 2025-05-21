// supabase/functions/stack-processor/index.ts
// Processes pending stack runs in the database
// This edge function is triggered when a new pending stack run is created

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.36.0";
import { corsHeaders } from "../_shared/cors.ts";
import { 
  prepareStackRunResumption, 
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

// Initialize Supabase config and client
const config = getSupabaseConfig();
const SUPABASE_URL = config.url;
const SERVICE_ROLE_KEY = config.serviceRoleKey || "";
if (!SERVICE_ROLE_KEY) {
  console.error("Missing service role key");
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Helper function to get a stack run by ID
async function getStackRun(stackRunId: string): Promise<any> {
  try {
    const { data, error } = await supabase
      .from("stack_runs")
      .select("*")
      .eq("id", stackRunId)
      .single();
    
    if (error) {
      log("error", `Error fetching stack run ${stackRunId}: ${error.message}`);
      return null;
    }
    
    return data;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Exception fetching stack run ${stackRunId}: ${errorMessage}`);
    return null;
  }
}

// Helper function to update a stack run's status
async function updateStackRunStatus(stackRunId: string, status: string, result: any = null, error: string | null = null): Promise<void> {
  try {
    log("info", `Updating stack run ${stackRunId} status to ${status}`);
    
    const updateData: any = {
      status,
      updated_at: new Date().toISOString()
    };
    
    // Add started_at timestamp if we're just starting processing
    if (status === 'processing') {
      updateData.started_at = new Date().toISOString();
    }
    
    // Add ended_at timestamp if we're done (completed or error)
    if (status === 'completed' || status === 'error') {
      updateData.ended_at = new Date().toISOString();
    }
    
    // Add result if provided
    if (result !== null) {
      updateData.result = result;
    }
    
    // Add error if provided
    if (error !== null) {
      updateData.error = error;
    }
    
    const { error: updateError } = await supabase
      .from('stack_runs')
      .update(updateData)
      .eq('id', stackRunId);
    
    if (updateError) {
      log("error", `Error updating stack run ${stackRunId} status: ${updateError.message}`);
    } else {
      log("info", `Stack run ${stackRunId} status updated to ${status}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Exception updating stack run ${stackRunId} status: ${errorMessage}`);
  }
}

// Helper function to update a stack run's waiting_on_stack_run_id
async function updateStackRunWaitingOn(stackRunId: string, waitingOnStackRunId: string | null): Promise<void> {
  try {
    log("info", `Updating stack run ${stackRunId} waiting_on_stack_run_id to ${waitingOnStackRunId || 'null'}`);
    
    const { error } = await supabase
      .from('stack_runs')
      .update({
        waiting_on_stack_run_id: waitingOnStackRunId,
        updated_at: new Date().toISOString()
      })
      .eq('id', stackRunId);
    
    if (error) {
      log("error", `Error updating stack run ${stackRunId} waiting_on_stack_run_id: ${error.message}`);
    } else {
      log("info", `Stack run ${stackRunId} waiting_on_stack_run_id updated to ${waitingOnStackRunId || 'null'}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Exception updating stack run ${stackRunId} waiting_on_stack_run_id: ${errorMessage}`);
  }
}

// Helper function for simple JSON stringify that handles circular references
function simpleStringify(obj: any): string {
  try {
    const seen = new Set();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    }, 2);
  } catch (e) {
    return `[Cannot stringify: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

// Process a stack run
async function processStackRun(stackRunId: string): Promise<any> {
  log("info", `Processing stack run: ${stackRunId}`);
  
  try {
    // Get the stack run
    const stackRun = await getStackRun(stackRunId);
    if (!stackRun) {
      log("error", `Stack run ${stackRunId} not found`);
      return { error: "Stack run not found" };
    }
    
    // Skip already completed or failed runs
    if (stackRun.status === "completed" || stackRun.status === "failed") {
      log("info", `Stack run ${stackRunId} already has status: ${stackRun.status}`);
      return { status: stackRun.status, result: stackRun.result, error: stackRun.error };
    }
    
    // Update status to in_progress
    await updateStackRunStatus(stackRunId, "in_progress");
    
    // Handle based on the type of stack run
    let result;
    
    // Check if this is a GAPI call
    if (stackRun.service_name === "gapi") {
      log("info", `Identified GAPI service call: ${stackRun.method_name}`);
      result = await processGapiCall(stackRun);
    } else if (stackRun.vm_state && stackRun.vm_state.task_code) {
      // Task VM execution
      log("info", `Identified task VM execution for: ${stackRun.vm_state.task_name || 'unknown task'}`);
      result = await processTaskExecution(stackRun);
    } else {
      // Generic service call
      log("info", `Identified generic service call: ${stackRun.service_name}.${stackRun.method_name}`);
      result = await processServiceCall(stackRun);
    }
    
    // Update stack run status to completed with result
    await updateStackRunStatus(stackRunId, "completed", result);
    
    // Return the result
    return { status: "completed", result };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error processing stack run ${stackRunId}: ${errorMessage}`);
    
    // Update stack run status to failed with error
    try {
      await updateStackRunStatus(stackRunId, "failed", null, errorMessage);
    } catch (updateError) {
      const updateErrorMessage = updateError instanceof Error ? updateError.message : String(updateError);
      log("error", `Error updating stack run status: ${updateErrorMessage}`);
    }
    
    return { status: "failed", error: errorMessage };
  }
}

/**
 * Process a task execution stack run
 */
async function processTaskExecution(stackRun: any): Promise<any> {
  try {
    // If we have a vm_state, use it directly rather than making a tasks call
    if (stackRun.vm_state && stackRun.vm_state.task_code && stackRun.vm_state.task_name) {
      log("info", `Using VM state to execute task: ${stackRun.vm_state.task_name}`);
      
      // Call QuickJS to execute the task code
      const response = await fetch(`${SUPABASE_URL}/functions/v1/quickjs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({
          code: stackRun.vm_state.task_code,
          input: stackRun.vm_state.input || {},
          taskName: stackRun.vm_state.task_name,
          stackRunId: stackRun.id
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error executing task: ${response.status} ${response.statusText} - ${errorText}`);
      }
      
      const result = await response.json();
      log("info", `Task execution result: ${JSON.stringify(result)}`);
      
      return result;
    }
    
    // Otherwise, use the original method
    const taskName = stackRun.args[0];
    const taskInput = stackRun.args[1] || {};
    
    log("info", `Executing task: ${taskName}`);
    log("info", `Task input: ${JSON.stringify(taskInput)}`);
    
    // Execute the task using the tasks edge function
    const response = await fetch(`${SUPABASE_URL}/functions/v1/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        task: taskName,
        input: taskInput,
        parent_stack_run_id: stackRun.id
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Error executing task: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const result = await response.json();
    
    log("info", `Task execution result: ${JSON.stringify(result)}`);
    
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error executing task: ${errorMessage}`);
    throw error;
  }
}

/**
 * Process a generic service call stack run
 */
async function processServiceCall(stackRun: any): Promise<any> {
  const serviceName = stackRun.service_name;
  const methodName = stackRun.method_name;
  const args = stackRun.args || [];
  
  log("info", `Calling service: ${serviceName}.${methodName}`);
  log("info", `Args: ${JSON.stringify(args)}`);
  
  try {
    // Execute the service call using the appropriate edge function
    const response = await fetch(`${SUPABASE_URL}/functions/v1/wrapped${serviceName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        method: methodName,
        args
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Error calling service: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const result = await response.json();
    
    log("info", `Service call result: ${JSON.stringify(result)}`);
    
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error calling service ${serviceName}.${methodName}: ${errorMessage}`);
    throw error;
  }
}

/**
 * Resume a parent stack run with the result from a child
 */
async function resumeParentStackRun(parentStackRunId: string, childStackRunId: string, childResult: any): Promise<void> {
  log("info", `Resuming parent stack run: ${parentStackRunId} with result from ${childStackRunId}`);
  
  try {
    // Get the parent stack run
    const parentStackRun = await getStackRun(parentStackRunId);
    
    if (!parentStackRun) {
      throw new Error(`Parent stack run not found: ${parentStackRunId}`);
    }
    
    // Check if the parent is waiting on this child
    if (parentStackRun.waiting_on_stack_run_id !== childStackRunId) {
      log("info", `Parent ${parentStackRunId} is not waiting on child ${childStackRunId}`);
      return;
    }
    
    // Update the parent stack run
    await updateStackRunWaitingOn(parentStackRunId, null);
    
    // Mark the parent for resumption
    await updateStackRunStatus(parentStackRunId, "ready_to_resume", {
      child_result: childResult
    });
    
    log("info", `Parent stack run ${parentStackRunId} marked as ready to resume`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error resuming parent stack run ${parentStackRunId}: ${errorMessage}`);
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
async function callGapi(method: string | string[], args: any[]): Promise<any> {
  // Method can be either a string like "admin.domains.list" or an array ["admin", "domains", "list"]
  // Normalize to array format
  const methodPath = Array.isArray(method) ? method : method.split('.');
  
  log("info", `Calling gapi.${Array.isArray(method) ? method.join('.') : method} with args: ${JSON.stringify(args)}`);
  
  const { url, serviceRoleKey } = getSupabaseConfig();
  
  if (!serviceRoleKey) {
    throw new Error("Missing service role key");
  }
  
  try {
    // Start building the method chain
    const chain: MethodChainItem[] = [];
    
    // Add each part of the method path as a separate 'get' operation
    for (let i = 0; i < methodPath.length - 1; i++) {
      chain.push({ type: "get", property: methodPath[i] });
    }
    
    // Add the final method as a 'call' operation with the provided args
    chain.push({ 
      type: "call", 
      property: methodPath[methodPath.length - 1], 
      args: args
    });
    
    // Call the wrappedgapi edge function with the method chain
    log("info", `Sending chain to wrappedgapi: ${JSON.stringify(chain)}`);
    
    const response = await fetch(`${url}/functions/v1/wrappedgapi`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceRoleKey}`
      },
      body: JSON.stringify({ chain })
    });
    
    if (!response.ok) {
      let errorText = "Unknown error";
      try {
        errorText = await response.text();
      } catch (e) {
        errorText = `Failed to read error response: ${e instanceof Error ? e.message : String(e)}`;
      }
      throw new Error(`GAPI call failed with status ${response.status}: ${errorText}`);
    }
    
    const result = await response.json();
    log("info", `GAPI call successful, result keys: ${Object.keys(result).join(', ')}`);
    
    // Make sure we're returning the complete result
    return result;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error calling GAPI: ${errorMessage}`);
    throw new Error(`GAPI call failed: ${errorMessage}`);
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

// Process any pending stack runs
async function processPendingStackRuns(): Promise<void> {
  try {
    // Check if there are any pending runs
    const hasMorePending = await checkForMorePendingRuns();
    
    if (hasMorePending) {
      log("info", "Found more pending runs, processing next one");
      
      // Get the next pending run
      const { data, error } = await supabase
        .from("stack_runs")
        .select("id")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(1);
      
      if (error) {
        log("error", `Error fetching next pending run: ${error.message}`);
        return;
      }
      
      if (data && data.length > 0) {
        const nextStackRunId = data[0].id;
        log("info", `Processing next pending run: ${nextStackRunId}`);
        
        // Trigger the next stack run
        await processStackRun(nextStackRunId);
      }
    } else {
      log("info", "No more pending runs to process");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error processing pending runs: ${errorMessage}`);
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
  
  // Type check for parent_task_run_id to avoid null/undefined errors
  const parentTaskRunId = parent_task_run_id || undefined;
  
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
    if (parentTaskRunId) {
      try {
        const { url, serviceRoleKey } = getSupabaseConfig();
        if (!serviceRoleKey) {
          log("error", "Missing service role key, cannot update parent task run");
        } else {
          const supabase = createClient(url, serviceRoleKey);
          
          log("info", `Directly updating task_runs record ${parentTaskRunId} with completed status and result`);
          
          // CRITICAL: This is the most important step - updating the task_run record to completed
          const { error: taskRunUpdateError } = await supabase
      .from("task_runs")
      .update({
              status: "completed",
              result: finalResult,
              updated_at: new Date().toISOString(),
              ended_at: new Date().toISOString()
      })
            .eq("id", parentTaskRunId);
    
          if (taskRunUpdateError) {
            log("error", `Error updating task_runs record: ${taskRunUpdateError.message}`);
          } else {
            log("info", `Successfully updated task_runs record ${parentTaskRunId} with status 'completed'`);
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
    if (parentTaskRunId) {
      try {
        const { url, serviceRoleKey } = getSupabaseConfig();
        if (!serviceRoleKey) {
          log("error", "Missing service role key, cannot update parent task run");
        } else {
          const supabase = createClient(url, serviceRoleKey);
          
          log("info", `Directly updating task_runs record ${parentTaskRunId} with failed status`);
          
          const { error: taskRunUpdateError } = await supabase
            .from("task_runs")
            .update({
              status: "failed",
              error: { message: errorMessage },
              updated_at: new Date().toISOString(),
              ended_at: new Date().toISOString()
            })
            .eq("id", parentTaskRunId);
    
          if (taskRunUpdateError) {
            log("error", `Error updating task_runs record: ${taskRunUpdateError.message}`);
          } else {
            log("info", `Successfully updated task_runs record ${parentTaskRunId} with status 'failed'`);
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

// Process a GAPI method call
async function processGapiCall(stackRun: any): Promise<any> {
  // Extract service path and arguments from the stack run
  const serviceName = stackRun.service_name;
  const methodName = stackRun.method_name;
  const args = stackRun.args || [];
  
  log("info", `Processing GAPI call: ${methodName}, with args: ${simpleStringify(args)}`);
  
  try {
    // Call the GAPI service
    const methodPath = (stackRun.method_path || []).join('.');
    log("info", `Calling GAPI method: ${methodPath}, with args: ${simpleStringify(args)}`);
    
    const response = await fetch(`${SUPABASE_URL}/functions/v1/wrappedgapi`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        chain: [
          ...stackRun.method_path.map((part: string) => ({ type: "get", property: part })),
          { type: "call", property: methodName, args: args }
        ]
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GAPI call failed with status ${response.status}: ${errorText}`);
    }
    
    const result = await response.json();
    log("info", `GAPI call successful with result: ${simpleStringify(result)}`);
    
    // Update the stack run with the result
    await updateStackRunStatus(stackRun.id, "completed", result);
    
    // Process the parent run if it exists
    if (stackRun.parent_run_id) {
      log("info", `Processing parent run ${stackRun.parent_run_id} after GAPI call completion`);
      const parentRun = await getStackRun(stackRun.parent_run_id);
      
      if (parentRun && parentRun.status === "in_progress") {
        // Resume the parent VM execution
        return await processVMExecution(parentRun, result);
      }
    }
    
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error processing GAPI call: ${errorMessage}`);
    
    // Update the stack run with error
    await updateStackRunStatus(stackRun.id, "failed", null, JSON.stringify({ message: errorMessage }));
    
    throw error;
  }
}

// Process a VM execution (used by processGapiCall)
async function processVMExecution(stackRun: any, result: any): Promise<any> {
  // This will be called to resume a VM execution with the result of a GAPI call
  if (stackRun.vm_state && stackRun.vm_state.task_code) {
    log("info", `Resuming VM execution for task: ${stackRun.vm_state.task_name || 'unknown task'}`);
    
    // We'll reuse the existing task execution logic but with a modified VM state
    // that includes the result from the GAPI call
    const modifiedStackRun = {
      ...stackRun,
      vm_state: {
        ...stackRun.vm_state,
        last_call_result: result
      }
    };
    
    return await processTaskExecution(modifiedStackRun);
  } else {
    log("error", `Cannot resume VM execution: no VM state found in stack run ${stackRun.id}`);
    throw new Error("Cannot resume VM execution: no VM state in stack run");
  }
}

// Fix the handleRequest function to properly handle stackRunId
async function handleRequest(req: Request): Promise<Response> {
  log("info", "Handling stack processor request");
  
  // Handle preflight CORS requests
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  
  try {
    // Parse request body
    const requestData = await req.json();
    log("info", "Request data received", requestData);
    
    // Check if we received a specific stack run ID to process
    if (requestData && requestData.stackRunId) {
      const stackRunId = String(requestData.stackRunId);
      const result = await processStackRun(stackRunId);
      
      return new Response(
        JSON.stringify(result),
        {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          },
          status: 200
        }
      );
    }
    
    // Check if we're being triggered to process the next pending run
    if (requestData && requestData.trigger === "process-next") {
      await processPendingStackRuns();
      
      return new Response(
        JSON.stringify({ success: true, message: "Processing initiated" }),
        {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          },
          status: 200
        }
      );
    }
    
    return new Response(
      JSON.stringify({
        success: false,
        error: "Missing stackRunId or trigger parameter"
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        },
        status: 400
      }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error handling request: ${errorMessage}`);
    
    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        },
        status: 500
      }
    );
  }
}

// Process a task that is waiting for a child task to complete
async function resumeTaskFromVM(stackRunId: string, childResult: any): Promise<any> {
  log("info", `Resuming task from VM state for stack run: ${stackRunId}`);
  
  try {
    // Fetch the stack run with VM state
    const { url, serviceRoleKey } = getSupabaseConfig();
    
    if (!serviceRoleKey) {
      throw new Error("Missing service role key");
    }
    
    const supabase = createClient(url, serviceRoleKey);
    
    // Get the stack run
    const { data: stackRun, error: getError } = await supabase
      .from("stack_runs")
      .select("*")
      .eq("id", stackRunId)
      .single();
    
    if (getError) {
      throw new Error(`Error getting stack run: ${getError.message}`);
    }
    
    if (!stackRun) {
      throw new Error(`Stack run not found: ${stackRunId}`);
    }
    
    // Make sure we have VM state
    if (!stackRun.vm_state) {
      throw new Error(`No VM state for stack run: ${stackRunId}`);
    }
    
    // Update status to processing
    await supabase
      .from("stack_runs")
      .update({
        status: "processing",
        updated_at: new Date().toISOString()
      })
      .eq("id", stackRunId);
    
    // Prepare stack run for resumption by updating it with the child result
    const resumeSuccessful = await prepareStackRunResumption(stackRunId, stackRun.waiting_on_stack_run_id, childResult);
    
    if (!resumeSuccessful) {
      throw new Error(`Failed to prepare stack run for resumption: ${stackRunId}`);
    }
    
    // Call QuickJS to resume the VM with the saved state
    log("info", `Calling QuickJS to resume VM for stack run: ${stackRunId}`);
    
    const quickJsResponse = await fetch(`${url}/functions/v1/quickjs/resume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`
      },
      body: JSON.stringify({
        stackRunId
      })
    });
    
    if (!quickJsResponse.ok) {
      const responseText = await quickJsResponse.text();
      throw new Error(`Error resuming VM: ${quickJsResponse.status} - ${responseText}`);
    }
    
    // Get the result
    const quickJsResult = await quickJsResponse.json();
    
    // Update stack run with result
    await supabase
      .from("stack_runs")
      .update({
        status: "completed",
        result: quickJsResult.result,
        updated_at: new Date().toISOString()
      })
      .eq("id", stackRunId);
    
    // If this stack run has a parent task run, update its status
    if (stackRun.parent_task_run_id) {
      await updateTaskRun(stackRun.parent_task_run_id, quickJsResult.result, "completed");
    }
    
    return quickJsResult.result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error resuming task from VM: ${errorMessage}`);
    
    // Update stack run with error
    const { url, serviceRoleKey } = getSupabaseConfig();
    
    if (serviceRoleKey) {
      const supabase = createClient(url, serviceRoleKey);
      
      await supabase
        .from("stack_runs")
        .update({
          status: "failed",
          error: { message: errorMessage },
          updated_at: new Date().toISOString()
        })
        .eq("id", stackRunId);
    }
    
    throw error;
  }
}

// Handle the incoming stack processor request
serve(async (req) => {
  return await handleRequest(req);
}); 