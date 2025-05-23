// supabase/functions/stack-processor/index.ts
// Processes pending stack runs in the database
// This edge function is triggered when a new pending stack run is created

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
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
  console.log(`[${timestamp}] [${level.toUpperCase()}] [stack-processor] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
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
    if (status === 'processing' || status === 'in_progress') {
      updateData.started_at = updateData.started_at || new Date().toISOString();
    }
    
    // Add ended_at timestamp if we're done (completed or error)
    if (status === 'completed' || status === 'failed') {
      updateData.ended_at = new Date().toISOString();
    }
    
    // Add result if provided
    if (result !== null) {
      updateData.result = result;
    }
    
    // Add error if provided
    if (error !== null) {
      updateData.error = typeof error === 'string' ? { message: error } : error;
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
  let stackRun = await getStackRun(stackRunId);

  if (!stackRun) {
    log("error", `Stack run ${stackRunId} not found`);
    await processPendingStackRuns();
    return { status: "error", error: "Stack run not found" };
  }

  if (stackRun.status === "completed" || stackRun.status === "failed") {
    log("info", `Stack run ${stackRunId} already has status: ${stackRun.status}`);
    await processPendingStackRuns();
    return { status: stackRun.status, result: stackRun.result, error: stackRun.error };
  }

  if (stackRun.status === "waiting_on_stack_run_id") {
      log("info", `Stack run ${stackRunId} is waiting on another run, skipping processing via pending queue.`);
      await processPendingStackRuns();
      return { status: "waiting" };
  }
   
  if (stackRun.status === "pending_resume") {
      log("info", `Stack run ${stackRunId} is ready to resume. Attempting to resume.`);
      const childResult = stackRun.result && stackRun.result.child_result ? stackRun.result.child_result : null;
      try {
        await resumeTaskFromVM(stackRunId, childResult);
      } catch(e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        log("error", `Error during explicit resume of ${stackRunId}: ${errorMsg}`);
        const currentRunState = await getStackRun(stackRunId);
        if (currentRunState) await failStackRun(currentRunState, `Resumption error: ${errorMsg}`);
        else await updateStackRunStatus(stackRunId, "failed", null, `Resumption error: ${errorMsg}`);
      } finally {
        await processPendingStackRuns();
      }
      return { status: "resuming" };
  }

  await updateStackRunStatus(stackRunId, "processing");

  try {
    if (stackRun.service_name === "gapi") {
      log("info", `Identified GAPI service call: ${stackRun.method_name}`);
      const result = await processGapiCall(stackRun);
      await completeStackRun(stackRun, result);
      return { status: 'completed', result };
    } else if (stackRun.vm_state && stackRun.vm_state.taskCode && stackRun.vm_state.taskName) {
      log("info", `Processing VM task execution: ${stackRun.vm_state.taskName}`);
      const taskResult = await processTaskExecution(stackRun);
      
      if (taskResult.status === 'completed') {
        await completeStackRun(stackRun, taskResult.result);
      } else if (taskResult.status === 'paused') {
        log("info", `Task paused, waiting on ${taskResult.waiting_on_stack_run_id}`);
      } else if (taskResult.status === 'error') {
        await failStackRun(stackRun, taskResult.error || "Unknown error");
      }
      
      return taskResult;
    } else if (stackRun.method_name === 'tasks.execute' && stackRun.args) {
      const taskName = stackRun.args[0];
      const taskInput = stackRun.args[1] || {};
      log("info", `Executing task via tasks.execute: ${taskName}`);
      
      const tasksResponse = await fetch(`${SUPABASE_URL}/functions/v1/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({
          task: taskName,
          input: taskInput,
          parent_stack_run_id: stackRun.id,
          taskRunId: stackRun.parent_task_run_id
        })
      });
      
      const tasksResponseData = await tasksResponse.json();
      if (!tasksResponse.ok) {
        const errorMsg = `Error executing task via /tasks: ${tasksResponse.status} ${tasksResponse.statusText}`;
        log("error", errorMsg);
        await failStackRun(stackRun, errorMsg);
        return { status: 'error', error: errorMsg };
      }
      
      const result = tasksResponseData.result !== undefined ? tasksResponseData.result : tasksResponseData;
      await completeStackRun(stackRun, result);
      return { status: 'completed', result };
    } else {
      const errorMsg = `Invalid stack run configuration for ${stackRun.id}: no valid execution path`;
      log("error", errorMsg);
      await failStackRun(stackRun, errorMsg);
      return { status: 'error', error: errorMsg };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error processing stack run ${stackRunId}: ${errorMessage}`);
    const currentRunState = await getStackRun(stackRunId);
    if (currentRunState) {
        await failStackRun(currentRunState, errorMessage);
    } else {
        await updateStackRunStatus(stackRunId, "failed", null, errorMessage);
    }
    return { status: "failed", error: errorMessage };
  } finally {
    await processPendingStackRuns();
  }
}

/**
 * Process a task execution stack run
 */
async function processTaskExecution(stackRun: any): Promise<{status: 'completed' | 'paused' | 'error', result?: any, error?: string, waiting_on_stack_run_id?: string}> {
  try {
    const requestBody: any = {};
    if (stackRun.vm_state && stackRun.vm_state.taskCode && stackRun.vm_state.taskName) {
      log("info", `Using VM state to execute task: ${stackRun.vm_state.taskName} (StackRunID: ${stackRun.id}, TaskRunID: ${stackRun.parent_task_run_id})`);
      requestBody.taskCode = stackRun.vm_state.taskCode;
      requestBody.taskName = stackRun.vm_state.taskName;
      requestBody.taskInput = stackRun.vm_state.taskInput || {};
      requestBody.stackRunId = stackRun.id;
      requestBody.taskRunId = stackRun.parent_task_run_id;
       // If vm_state contains last_call_result, it's a resumption hint for QuickJS
      if (stackRun.vm_state.last_call_result !== undefined) {
        requestBody.initialVmState = {
          ...stackRun.vm_state,
          resume_payload: stackRun.vm_state.last_call_result
        };
        log("info", `Forwarding last_call_result for resumption of ${stackRun.id}`);
      }
    } else if (stackRun.method_name === 'tasks.execute' && stackRun.args) {
       // This handles cases where tasks.execute was queued directly, not a VM resumption
      const taskName = stackRun.args[0];
      const taskInput = stackRun.args[1] || {};
      log("info", `Executing task via tasks.execute: ${taskName} (StackRunID: ${stackRun.id})`);
      requestBody.taskName = taskName;
      requestBody.taskInput = taskInput; // Use taskInput for clarity if QuickJS expects that
      requestBody.input = taskInput; // Also provide as 'input' for compatibility
      requestBody.stackRunId = stackRun.id;
      requestBody.parent_stack_run_id = stackRun.id; // For the /tasks endpoint this might be relevant
      requestBody.taskRunId = stackRun.parent_task_run_id;

      // Call /tasks endpoint instead of /quickjs directly for tasks.execute
      const tasksResponse = await fetch(`${SUPABASE_URL}/functions/v1/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({
          task: taskName,
          input: taskInput,
          parent_stack_run_id: stackRun.id, // Link this execution to current stack run
          taskRunId: stackRun.parent_task_run_id // Propagate original task run id
        })
      });
      const tasksResponseData = await tasksResponse.json();
      if (!tasksResponse.ok) {
        const errorMsg = `Error executing task via /tasks: ${tasksResponse.status} ${tasksResponse.statusText} - ${tasksResponseData.error || simpleStringify(tasksResponseData)}`;
        log("error", errorMsg);
        return { status: 'error', error: errorMsg };
      }
       // /tasks endpoint should also adhere to the new contract, or we adapt here
       // Assuming /tasks ultimately calls quickjs and quickjs gives the new contract response
       // If /tasks gives its own taskRunId, that's for the outer call, not the QuickJS pause/complete status
       // For now, let's assume tasksResponseData *is* the QuickJS contract result if /tasks proxies it.
       // This part needs to align with /tasks endpoint's actual response structure.
       // Awaiting clarification or assuming /tasks proxies QuickJS response structure.
       // If tasksResponseData is { taskRunId: ..., status: 'processing'}, it's not the QuickJS outcome.
       // The QuickJS outcome would be on the stack_run that /tasks creates/manages.
       // This path is complex if /tasks doesn't return the direct QuickJS outcome.
       // For now, let's assume direct QuickJS call path is primary for ephemeral model.
       // Fallback: if this path is taken, we assume it completes, but this is a simplification.
       log("warn", `tasks.execute routed through /tasks; assuming completion with result: ${simpleStringify(tasksResponseData)} This path might need refinement based on /tasks contract.`);
       return { status: 'completed', result: tasksResponseData.result !== undefined ? tasksResponseData.result : tasksResponseData };
    }
     else {
      return { status: 'error', error: `Invalid state for processTaskExecution for stackRun ${stackRun.id}` };
    }

    const response = await fetch(`${SUPABASE_URL}/functions/v1/quickjs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify(requestBody)
    });
    
    const quickJsResponseData = await response.json();

    if (!response.ok) {
      const errorText = quickJsResponseData.error || await response.text();
      log("error", `QuickJS call for ${stackRun.id} failed with HTTP ${response.status}: ${errorText}`);
      return { status: 'error', error: `QuickJS HTTP Error: ${response.status} - ${errorText}` };
    }
    
    log("info", `QuickJS response for ${stackRun.id}: ${simpleStringify(quickJsResponseData)}`);

    // CRITICAL FIX: Check if QuickJS returned a suspension response
    if (quickJsResponseData.result && quickJsResponseData.result.__hostCallSuspended === true) {
      const childStackRunId = quickJsResponseData.result.stackRunId;
      log("info", `QuickJS suspended ${stackRun.id}, waiting on child service call ${childStackRunId}`);
      
      // NOTE: Do NOT update the parent stack run here - it will be updated automatically 
      // when the child service call is saved by the VM state manager
      // The VM state manager handles the parent-child relationship setup correctly
      
      return { status: 'paused', waiting_on_stack_run_id: childStackRunId };
    }

    if (quickJsResponseData.status === 'completed') {
      return { status: 'completed', result: quickJsResponseData.result };
    } else if (quickJsResponseData.status === 'paused') {
      // QuickJS should have updated the current stackRun (stackRun.id) to status 'waiting_on_stack_run_id'
      // and set stackRun.waiting_on_stack_run_id = quickJsResponseData.waiting_on_stack_run_id (the new child)
      log("info", `QuickJS paused ${stackRun.id}, waiting on new child ${quickJsResponseData.waiting_on_stack_run_id}`);
      return { status: 'paused', waiting_on_stack_run_id: quickJsResponseData.waiting_on_stack_run_id };
    } else if (quickJsResponseData.status === 'error') {
      return { status: 'error', error: quickJsResponseData.error || "Unknown error from QuickJS execution" };
    } else {
      log("warn", `QuickJS response for ${stackRun.id} lacks standard status. Assuming legacy completed. Data: ${simpleStringify(quickJsResponseData)}`);
      // Legacy: if no status field, assume it's a direct result and completed
      return { status: 'completed', result: quickJsResponseData.result !== undefined ? quickJsResponseData.result : quickJsResponseData };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Exception in processTaskExecution for ${stackRun.id}: ${errorMessage}`);
    return { status: 'error', error: errorMessage };
  }
}

/**
 * Process a generic service call stack run
 */
async function processServiceCall(stackRun: any): Promise<any> {
  const serviceName = stackRun.service_name;
  const methodName = stackRun.method_name;
  const args = stackRun.args || [];
  
  // First, check if the service name is a UUID (indicating a reference to a previous stack run's result)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const isUuid = serviceName && uuidRegex.test(serviceName);
  
  if (isUuid) {
    // This is a reference to a previous stack run - we need to get its result
    log("info", `Service name is a stack run ID: ${serviceName}`);
    
    const previousStackRun = await getStackRun(serviceName);
    if (!previousStackRun) {
      throw new Error(`Referenced stack run not found: ${serviceName}`);
    }
    
    if (!previousStackRun.result) {
      throw new Error(`Referenced stack run has no result: ${serviceName}`);
    }
    
    log("info", `Using result from previous stack run: ${serviceName}`);
    return previousStackRun.result;
  }
  
  // Standard service call - e.g. to 'gapi', 'openai', etc.
  log("info", `Calling service: ${serviceName}.${methodName}`);
  log("info", `Args: ${simpleStringify(args)}`);
  
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
    
    log("info", `Service call result: ${simpleStringify(result)}`);
    
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
      // If parent not found, it might have been processed or deleted. Log and exit.
      log("warn", `Parent stack run ${parentStackRunId} not found during resumption triggered by child ${childStackRunId}.`);
      return;
    }
    
    // Check if the parent is waiting on this child
    if (parentStackRun.waiting_on_stack_run_id !== childStackRunId) {
      log("warn", `Parent ${parentStackRunId} is not waiting on child ${childStackRunId} (actual: ${parentStackRun.waiting_on_stack_run_id}). Status: ${parentStackRun.status}. Skipping redundant resume trigger.`);
      return;
    }
    
    // Update the parent stack run: clear waiting_on, set status to ready_to_resume, store child_result (often in 'result' field for ready_to_resume)
    // prepareStackRunResumption can also be used if it sets vm_state.last_call_result
    log("info", `Marking parent stack run ${parentStackRunId} as ready_to_resume with child result.`);
    // Use updateStackRunStatus to set the status and store the child result.
    await updateStackRunStatus(parentStackRunId, "pending_resume", { child_result: childResult });
    // Clear the waiting_on_stack_run_id separately.
    await updateStackRunWaitingOn(parentStackRunId, null);

    // The following was the previous attempt, kept for history, but updateStackRun likely has a stricter signature.
    /* await updateStackRun(parentStackRunId, { 
        status: "pending_resume", 
        waiting_on_stack_run_id: null, 
        result: { child_result: childResult }, 
        updated_at: new Date().toISOString()
    }); */
    
    // Alternatively, call prepareStackRunResumption directly if it achieves the same goal
    // await prepareStackRunResumption(parentStackRunId, childStackRunId, childResult);
    
    log("info", `Parent stack run ${parentStackRunId} marked as ready_to_resume. It will be picked up or explicitly triggered.`);
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
    // Call the GAPI service proxy
    const gapiClient = createServiceProxy("gapi", {
      baseUrl: `${SUPABASE_URL}/functions/v1/wrappedgapi`,
      headers: {
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "apikey": SERVICE_ROLE_KEY
      }
    });

    // Dynamically call the method chain
    let currentProxy: any = gapiClient;
    const methodParts = stackRun.method_name.split('.');
    for (let i = 0; i < methodParts.length - 1; i++) {
      currentProxy = currentProxy[methodParts[i]];
    }
    const finalMethod = methodParts[methodParts.length - 1];
    const gapiResult = await currentProxy[finalMethod](...(stackRun.args || []));

    log("info", `GAPI service call ${stackRun.method_name} completed`, gapiResult);
    return gapiResult;
  } catch (callError: any) {
    const errorMessage = callError.message || String(callError);
    log("error", `Error calling GAPI service ${stackRun.method_name}: ${errorMessage}`);
    await updateStackRunStatus(stackRun.id, "failed", null, errorMessage);
    throw new Error(`GAPI call failed: ${errorMessage}`);
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
  let currentStackRun = await getStackRun(stackRunId);

  if (!currentStackRun) {
    throw new Error(`Stack run not found for resumption: ${stackRunId}`);
  }
  if (currentStackRun.status === 'completed' || currentStackRun.status === 'failed') {
    log("warn", `Attempted to resume already terminal stack run ${stackRunId} (status: ${currentStackRun.status})`);
    return currentStackRun.result; // Or throw error
  }

  try {
    await updateStackRunStatus(stackRunId, "processing"); // Mark as processing resumption
    
    // Prepare stack run for resumption by updating it with the child result into vm_state
    // The childResult is passed here; prepareStackRunResumption should use it.
    // The childStackRunId is not strictly needed by prepareStackRunResumption if stackRunId (parent) and childResult are enough.
    // Assuming prepareStackRunResumption correctly updates parent's (stackRunId) vm_state.
    const waitingOn = currentStackRun.waiting_on_stack_run_id; // This should have been the child ID
    const resumeSuccessful = await prepareStackRunResumption(stackRunId, waitingOn , childResult);
    
    if (!resumeSuccessful) {
      throw new Error(`Failed to prepare stack run for resumption: ${stackRunId}`);
    }
    
    // Call QuickJS to resume the VM with the saved state (which now includes childResult)
    log("info", `Calling QuickJS to resume VM for stack run: ${stackRunId}`);
    
    // The /quickjs/resume endpoint needs to exist and handle this.
    // For now, let's assume the main /quickjs endpoint can handle resumption if stackRunId is provided
    // and vm_state (now with child_result) is part of the payload construction in processTaskExecution.
    // OR, we need a dedicated /quickjs/resume that fetches the vm_state itself.
    // Let's use the main /quickjs path by re-processing this stackRun via processTaskExecution
    // as its vm_state is now updated.
    
    // Fetch the updated stack run after prepareStackRunResumption
    const stackRunForResumption = await getStackRun(stackRunId);
    if (!stackRunForResumption || !stackRunForResumption.vm_state) {
        throw new Error(`Stack run ${stackRunId} or its VM state not found after preparation for resumption.`);
    }

    // processTaskExecution will use the vm_state which includes the last_call_result
    const quickJsOutcome = await processTaskExecution(stackRunForResumption);
    
    currentStackRun = await getStackRun(stackRunId); // Refresh state again
     if (!currentStackRun) {
        throw new Error(`Stack run ${stackRunId} disappeared during QuickJS resumption.`);
    }

    if (quickJsOutcome.status === 'completed') {
      log("info", `Resumed task ${stackRunId} completed. Result: ${simpleStringify(quickJsOutcome.result)}`);
      await completeStackRun(currentStackRun, quickJsOutcome.result);
      return quickJsOutcome.result;
    } else if (quickJsOutcome.status === 'paused') {
      log("info", `Resumed task ${stackRunId} paused again, waiting on ${quickJsOutcome.waiting_on_stack_run_id}.`);
      // State already updated by QuickJS side. Nothing to do here.
      return { status: "paused" }; // Propagate paused state
    } else if (quickJsOutcome.status === 'error') {
      log("error", `Error during QuickJS resumption of ${stackRunId}: ${quickJsOutcome.error}`);
      await failStackRun(currentStackRun, quickJsOutcome.error || "Unknown error from QuickJS resumption");
      throw new Error(quickJsOutcome.error || "Unknown error from QuickJS resumption");
    } else {
      log("error", `Unknown status from QuickJS resumption of ${stackRunId}: ${quickJsOutcome.status}`);
      await failStackRun(currentStackRun, `Unknown status from QuickJS resumption: ${quickJsOutcome.status}`);
      throw new Error(`Unknown status from QuickJS resumption: ${quickJsOutcome.status}`);
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error resuming task from VM for ${stackRunId}: ${errorMessage}`);
    const runToFail = await getStackRun(stackRunId); // Get latest state before failing
    if (runToFail) {
        await failStackRun(runToFail, errorMessage);
    } else {
        // If it disappeared, just update by ID if possible
        await updateStackRunStatus(stackRunId, "failed", null, errorMessage);
    }
    throw error; // Re-throw for the caller of resumeTaskFromVM
  }
}

// ** NEW HELPER FUNCTIONS **
async function completeStackRun(stackRun: any, result: any, processedStackRuns: Set<string> = new Set()) {
  // Prevent infinite loops by tracking processed stack runs
  if (processedStackRuns.has(stackRun.id)) {
    log("warn", `Avoiding infinite loop: stack run ${stackRun.id} already processed in this completion chain`);
    return;
  }
  
  // Add this stack run to processed set
  processedStackRuns.add(stackRun.id);
  
  await updateStackRunStatus(stackRun.id, "completed", result);
  log("info", `Stack run ${stackRun.id} (TaskRunID: ${stackRun.parent_task_run_id}) completed.`);

  // CRITICAL FIX: Only complete the task_run if this is a TASK EXECUTION, not a SERVICE CALL
  // Service calls should resume their parent VM, not complete the task
  const isServiceCall = stackRun.service_name && (stackRun.service_name === "gapi" || stackRun.service_name === "openai" || stackRun.service_name === "websearch" || stackRun.service_name === "keystore" || stackRun.service_name === "database");
  const isTaskExecution = stackRun.vm_state && stackRun.vm_state.taskCode && stackRun.vm_state.taskName;
  
  if (isServiceCall) {
    log("info", `Stack run ${stackRun.id} is a service call (${stackRun.service_name}), not completing task_run directly`);
    // Service calls should not complete the task - they should resume their parent VM
    // The task completion will happen when the parent VM naturally completes
  } else if (isTaskExecution) {
    log("info", `Stack run ${stackRun.id} is a task execution, completing task_run ${stackRun.parent_task_run_id}`);
    if (stackRun.parent_task_run_id) {
      await updateTaskRun(stackRun.parent_task_run_id, result, 'completed');
    }
  } else {
    log("info", `Stack run ${stackRun.id} type unclear, completing task_run ${stackRun.parent_task_run_id} (fallback behavior)`);
    if (stackRun.parent_task_run_id) {
      await updateTaskRun(stackRun.parent_task_run_id, result, 'completed');
    }
  }

  // Check recursion depth limit
  if (processedStackRuns.size >= 10) {
    log("error", `Recursion depth limit reached (${processedStackRuns.size}), stopping completion propagation to prevent infinite loop`);
    return;
  }

  // Check if any parent stack_run was waiting for this one to complete
  const { data: parentRuns, error: parentError } = await supabase
    .from("stack_runs")
    .select("*") // Select all fields of the parent
    .eq("waiting_on_stack_run_id", stackRun.id) // Find parent waiting on this completed run
    .limit(1);

  if (parentError) {
    log("error", `Error finding parent waiting on ${stackRun.id}: ${parentError.message}`);
  } else if (parentRuns && parentRuns.length > 0) {
    const parentStackRunToResume = parentRuns[0];
    
    // Check if this would create a cycle
    if (processedStackRuns.has(parentStackRunToResume.id)) {
      log("error", `Detected parent-child cycle: parent ${parentStackRunToResume.id} already in completion chain, stopping propagation`);
      return;
    }
    
    log("info", `Child stack run ${stackRun.id} completed. Resuming parent stack run ${parentStackRunToResume.id} (depth: ${processedStackRuns.size})`);
    
    // resumeParentStackRun updates status to 'ready_to_resume' and stores child result appropriately
    await resumeParentStackRun(parentStackRunToResume.id, stackRun.id, result); 
    
    // Now, actively try to resume the parent.
    // resumeTaskFromVM will fetch the 'ready_to_resume' parent, set it to 'processing',
    // use prepareStackRunResumption (which uses the stored child result), and call QuickJS.
    try {
        await resumeTaskFromVM(parentStackRunToResume.id, result); // Pass child result again for clarity/use by prepareStackRunResumption
    } catch (e_resume) {
        const resumeErrorMsg = e_resume instanceof Error ? e_resume.message : String(e_resume);
        log("error", `Failed to trigger resume for parent ${parentStackRunToResume.id} after child ${stackRun.id} completed: ${resumeErrorMsg}`);
        // If resumeTaskFromVM fails, it should handle failing the parentStackRunToResume itself.
        // But let's avoid infinite recursion by not calling failStackRun again
        await updateStackRunStatus(parentStackRunToResume.id, "failed", null, resumeErrorMsg);
    }
  } else {
    log("info", `No parent stack run found waiting on completed child ${stackRun.id}. This may be the end of a chain or a standalone run.`);
  }
}

async function failStackRun(stackRun: any, errorMessage: string | object, processedStackRuns: Set<string> = new Set()) {
  // Prevent infinite loops by tracking processed stack runs
  if (processedStackRuns.has(stackRun.id)) {
    log("warn", `Avoiding infinite loop: stack run ${stackRun.id} already processed in this failure chain`);
    return;
  }
  
  // Add this stack run to processed set
  processedStackRuns.add(stackRun.id);
  
  const errorObject = typeof errorMessage === 'string' ? { message: errorMessage } : errorMessage;
  // Ensure that the error message passed to updateStackRunStatus is a string.
  const statusErrorMessage = typeof errorObject === 'string' ? errorObject : (errorObject as any).message || simpleStringify(errorObject);
  await updateStackRunStatus(stackRun.id, "failed", null, statusErrorMessage);
  log("error", `Stack run ${stackRun.id} (TaskRunID: ${stackRun.parent_task_run_id}) failed: ${simpleStringify(errorObject)}`);

  if (stackRun.parent_task_run_id) {
    log("info", `Updating parent task_run ${stackRun.parent_task_run_id} for failed stack_run ${stackRun.id}`);
    // Ensure the error message passed to updateTaskRun is a string or compatible type
    let taskRunErrorMessage = typeof errorObject === 'string' ? errorObject : (errorObject as any).message;
    if (typeof taskRunErrorMessage !== 'string') {
        taskRunErrorMessage = simpleStringify(errorObject);
    }
    await updateTaskRun(stackRun.parent_task_run_id, taskRunErrorMessage, 'failed');
  }

  // Propagate failure to any parent stack_run that was waiting for this one
  // BUT LIMIT THE RECURSION DEPTH TO PREVENT INFINITE LOOPS
  if (processedStackRuns.size >= 10) {
    log("error", `Recursion depth limit reached (${processedStackRuns.size}), stopping failure propagation to prevent infinite loop`);
    return;
  }

  const { data: parentRuns, error: parentError } = await supabase
    .from("stack_runs")
    .select("*") // Select all fields for recursive call
    .eq("waiting_on_stack_run_id", stackRun.id)
    .limit(1);

  if (parentError) {
    log("error", `Error finding parent waiting on failed child ${stackRun.id}: ${parentError.message}`);
  } else if (parentRuns && parentRuns.length > 0) {
    const parentStackRunToFail = parentRuns[0];
    
    // Check if this would create a cycle
    if (processedStackRuns.has(parentStackRunToFail.id)) {
      log("error", `Detected parent-child cycle: parent ${parentStackRunToFail.id} already in failure chain, stopping propagation`);
      return;
    }
    
    log("info", `Child stack run ${stackRun.id} failed. Propagating failure to parent stack run ${parentStackRunToFail.id} (depth: ${processedStackRuns.size})`);
    const parentErrorMessage = `Parent failed because child stack run ${stackRun.id} failed: ${(errorObject as any).message || simpleStringify(errorObject)}`;
    
    // Pass the processedStackRuns set to prevent cycles
    await failStackRun(parentStackRunToFail, parentErrorMessage, processedStackRuns);
  }
}
// ** END OF NEW HELPER FUNCTIONS **

// Handle the incoming stack processor request
serve(async (req) => {
  return await handleRequest(req);
}); 