/**
 * Stack Processor - Processes stack runs in a queue
 * Fixed version with proper syntax and structure
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.3";

import {
  saveStackRun,
  updateStackRun,
  getStackRun,
  cleanupStackRun,
  updateTaskRun,
  getPendingStackRuns,
  triggerStackProcessor,
  prepareStackRunResumption
} from "../quickjs/vm-state-manager.ts";
import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";

// Environment variables
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "http://127.0.0.1:8080";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Helper function to get config
function getSupabaseConfig() {
  const url = SUPABASE_URL;
  const serviceRoleKey = SERVICE_ROLE_KEY;
  
  return { url, serviceRoleKey };
}

// Log function with timestamp and prefix
function log(level: "info" | "warn" | "error", message: string) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}] [STACK-PROCESSOR] ${message}`);
}

// Error handling
if (!SUPABASE_URL) {
  console.error("Missing SUPABASE_URL");
}

if (!SERVICE_ROLE_KEY) {
  console.error("Missing service role key");
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Helper function to get a stack run by ID
async function getStackRunById(stackRunId: string): Promise<any> {
  try {
    const { data, error } = await supabase
      .from('stack_runs')
      .select('*')
      .eq('id', stackRunId)
      .maybeSingle();

    if (error) {
      throw error;
    }
    
    return data;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error fetching stack run ${stackRunId}: ${errorMessage}`);
    return null;
  }
}

// Helper function to update a stack run's status
async function updateStackRunStatus(
  stackRunId: string,
  status: string,
  result?: unknown,
  error?: unknown
): Promise<void> {
  try {
    const updateData: any = {
      status,
      updated_at: new Date().toISOString()
    };
    
    if (result !== undefined) updateData.result = result;
    if (error !== undefined) updateData.error = error;
    
    const { error: updateError } = await supabase
      .from('stack_runs')
      .update(updateData)
      .eq('id', stackRunId);
      
    if (updateError) {
      throw updateError;
    }
    
    log("info", `Updated stack run ${stackRunId} to status: ${status}`);
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    log("error", `Exception updating stack run ${stackRunId} status: ${errorMessage}`);
  }
}

// Helper function to update a stack run's waiting_on_stack_run_id
async function updateStackRunWaitingOn(
  stackRunId: string,
  waitingOnStackRunId: string | null
): Promise<void> {
  try {
    const { error } = await supabase
      .from('stack_runs')
      .update({
        waiting_on_stack_run_id: waitingOnStackRunId,
        updated_at: new Date().toISOString()
      })
      .eq('id', stackRunId);
      
    if (error) {
      throw error;
    }
    
    log("info", `Updated stack run ${stackRunId} waiting_on_stack_run_id to: ${waitingOnStackRunId}`);
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    log("error", `Exception updating stack run ${stackRunId} waiting_on_stack_run_id: ${errorMessage}`);
  }
}

// Helper function for simple JSON stringify that handles circular references
function simpleStringify(obj: any): string {
  try {
    const seen = new Set();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        // Simple circular reference detection
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    });
  } catch (e) {
    return `[Cannot stringify: ${e instanceof Error ? e.message : String(e)}]`;
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
      requestBody.action = "execute";
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
    } else {
      log("error", `Stack run ${stackRun.id} has no VM state with task info`);
      return { status: 'error', error: `No VM state with task info for stack run ${stackRun.id}` };
    }

    // Check if this is a tasks.execute call
    if (requestBody.taskName === 'tasks.execute') {
      const taskName = requestBody.taskInput.task;
      const taskInput = requestBody.taskInput.input;

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
          parent_stack_run_id: stackRun.id,
          taskRunId: stackRun.parent_task_run_id
        })
      });
      
      if (!tasksResponse.ok) {
        const errorText = await tasksResponse.text();
        const errorMsg = `Error executing task via /tasks: ${tasksResponse.status} ${tasksResponse.statusText} - ${errorText}`;
        log("error", errorMsg);
        return { status: 'error', error: errorMsg };
      }
      
      const tasksResponseData = await tasksResponse.json();
      log("warn", `tasks.execute routed through /tasks; result: ${simpleStringify(tasksResponseData)}`);
      return { status: 'completed', result: tasksResponseData.result !== undefined ? tasksResponseData.result : tasksResponseData };
    } else {
      // Call QuickJS directly for other tasks
      const response = await fetch(`${SUPABASE_URL}/functions/v1/quickjs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        log("error", `QuickJS call for ${stackRun.id} failed with HTTP ${response.status}: ${errorText}`);
        return { status: 'error', error: `QuickJS HTTP Error: ${response.status} - ${errorText}` };
      }
      
      const quickJsResponseData = await response.json();
      log("info", `QuickJS response for ${stackRun.id}: ${simpleStringify(quickJsResponseData)}`);

      // Check if QuickJS returned a suspension response
      if (quickJsResponseData.result && quickJsResponseData.result.__hostCallSuspended === true) {
        const childStackRunId = quickJsResponseData.result.stackRunId;
        log("info", `QuickJS suspended ${stackRun.id}, waiting on child service call ${childStackRunId}`);
        return { status: 'paused', waiting_on_stack_run_id: childStackRunId };
      }

      if (quickJsResponseData.status === 'completed') {
        return { status: 'completed', result: quickJsResponseData.result };
      } else if (quickJsResponseData.status === 'paused') {
        log("info", `QuickJS paused ${stackRun.id}, waiting on new child ${quickJsResponseData.waiting_on_stack_run_id}`);
        return { status: 'paused', waiting_on_stack_run_id: quickJsResponseData.waiting_on_stack_run_id };
      } else if (quickJsResponseData.status === 'error') {
        return { status: 'error', error: quickJsResponseData.error || "Unknown error from QuickJS execution" };
      } else {
        log("warn", `QuickJS response for ${stackRun.id} lacks standard status. Assuming legacy completed.`);
        return { status: 'completed', result: quickJsResponseData.result !== undefined ? quickJsResponseData.result : quickJsResponseData };
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Exception in processTaskExecution for ${stackRun.id}: ${errorMessage}`);
    return { status: 'error', error: errorMessage };
  }
}

// Process a generic service call stack run
async function processServiceCall(stackRun: any): Promise<any> {
  const serviceName = stackRun.service_name;
  const methodName = stackRun.method_name;
  const args = stackRun.args || [];

  log("info", `Processing service call: ${serviceName}.${methodName}`);

  // Create service proxy and call the method
  const serviceProxy = createServiceProxy(serviceName, {
    baseUrl: SUPABASE_URL,
    headers: {
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  try {
    const result = await serviceProxy[methodName](...args);
    log("info", `Service call ${serviceName}.${methodName} completed successfully`);
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Service call ${serviceName}.${methodName} failed: ${errorMessage}`);
    throw error;
  }
}

// Trigger the next pending stack run (async, don't wait for completion)
async function triggerNextPendingStackRun(): Promise<void> {
  try {
    // Get next pending stack run
    const pendingRuns = await getPendingStackRuns(1);
    
    if (pendingRuns.length === 0) {
      log("info", "No more pending stack runs to process");
      return;
    }

    const nextStackRunId = pendingRuns[0].id;
    log("info", `Triggering next pending stack run: ${nextStackRunId}`);

    // Trigger asynchronously (fire and forget)
    const { url, serviceRoleKey } = getSupabaseConfig();
    fetch(`${url}/functions/v1/stack-processor`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`
      },
      body: JSON.stringify({ stackRunId: nextStackRunId })
    }).catch(error => {
      log("error", `Error triggering next stack run: ${error.message}`);
    });

    log("info", `Next stack run ${nextStackRunId} triggered asynchronously`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error triggering next pending run: ${errorMessage}`);
  }
}

// Complete a stack run successfully
async function completeStackRun(stackRun: any, result: any) {
  log("info", `Completing stack run: ${stackRun.id}`);
  
  try {
    // Update the stack run status to completed
    await updateStackRunStatus(stackRun.id, "completed", result);
    
    // If this was a child stack run, resume the parent
    if (stackRun.parent_stack_run_id) {
      log("info", `Resuming parent stack run: ${stackRun.parent_stack_run_id}`);
      await prepareStackRunResumption(stackRun.parent_stack_run_id, stackRun.id, result);
      await triggerStackProcessor();
    }
    
    // If this was the main task execution, update the task run
    if (stackRun.parent_task_run_id && !stackRun.parent_stack_run_id) {
      log("info", `Updating task run: ${stackRun.parent_task_run_id}`);
      await updateTaskRun(stackRun.parent_task_run_id, "completed", result);
    }
    
    log("info", `Stack run ${stackRun.id} completed successfully`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error completing stack run ${stackRun.id}: ${errorMessage}`);
    throw error;
  }
  
  // CRITICAL: Always trigger the next pending run after completion
  try {
    await triggerNextPendingStackRun();
  } catch (triggerError) {
    const triggerErrorMsg = triggerError instanceof Error ? triggerError.message : String(triggerError);
    log("error", `Error triggering next pending run after ${stackRun.id} completion: ${triggerErrorMsg}`);
  }
}

// Fail a stack run
async function failStackRun(stackRun: any, errorMessage: string | object) {
  log("error", `Failing stack run: ${stackRun.id} - ${simpleStringify(errorMessage)}`);
  
  try {
    // Update the stack run status to failed
    await updateStackRunStatus(stackRun.id, "failed", null, errorMessage);
    
    // If this was a child stack run, fail the parent too
    if (stackRun.parent_stack_run_id) {
      log("info", `Failing parent stack run: ${stackRun.parent_stack_run_id}`);
      const parentStackRun = await getStackRunById(stackRun.parent_stack_run_id);
      if (parentStackRun) {
        await failStackRun(parentStackRun, `Child stack run failed: ${simpleStringify(errorMessage)}`);
      }
    }
    
    // If this was the main task execution, update the task run
    if (stackRun.parent_task_run_id && !stackRun.parent_stack_run_id) {
      log("info", `Updating task run to failed: ${stackRun.parent_task_run_id}`);
      await updateTaskRun(stackRun.parent_task_run_id, "failed", null, errorMessage);
    }
    
    log("info", `Stack run ${stackRun.id} failed`);
  } catch (error) {
    const dbErrorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error failing stack run ${stackRun.id}: ${dbErrorMessage}`);
  }
  
  // CRITICAL: Always trigger the next pending run after failure
  try {
    await triggerNextPendingStackRun();
  } catch (triggerError) {
    const triggerErrorMsg = triggerError instanceof Error ? triggerError.message : String(triggerError);
    log("error", `Error triggering next pending run after ${stackRun.id} failure: ${triggerErrorMsg}`);
  }
}

// Process a stack run with comprehensive error handling
async function processStackRun(stackRunId: string, processedStackRuns: Set<string> = new Set()): Promise<{ status: string, result?: any, error?: string }> {
  // Prevent infinite loops by tracking processed stack runs
  if (processedStackRuns.has(stackRunId)) {
    log("warn", `Stack run ${stackRunId} already processed in this cycle, skipping to avoid infinite loop`);
    return { status: "skipped", error: "Already processed in this cycle" };
  }
  processedStackRuns.add(stackRunId);

  log("info", `Processing stack run: ${stackRunId}`);
  
  try {
    // Update stack run to processing status
    await updateStackRunStatus(stackRunId, "processing");
    
    const stackRun = await getStackRunById(stackRunId);
    if (!stackRun) {
      const errorMessage = `Stack run ${stackRunId} not found`;
      log("error", errorMessage);
      return { status: "failed", error: errorMessage };
    }

    let result;
    
    // Route based on service name
    if (stackRun.service_name === "tasks" && stackRun.method_name === "execute") {
      const taskResult = await processTaskExecution(stackRun);
      
      if (taskResult.status === 'completed') {
        await completeStackRun(stackRun, taskResult.result);
        return { status: 'completed', result: taskResult.result };
      } else if (taskResult.status === 'paused') {
        log("info", `Task paused, waiting on ${taskResult.waiting_on_stack_run_id}`);
        await updateStackRunStatus(stackRunId, 'suspended_waiting_child');
        await updateStackRunWaitingOn(stackRunId, taskResult.waiting_on_stack_run_id || null);
        return { status: 'paused', result: taskResult.result };
      } else {
        await failStackRun(stackRun, taskResult.error || 'Unknown error');
        return { status: 'failed', error: taskResult.error };
      }
    } else {
      // Generic service call processing
      result = await processServiceCall(stackRun);
      await completeStackRun(stackRun, result);
      return { status: 'completed', result };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Error processing stack run ${stackRunId}: ${errorMessage}`);
    
    try {
      await updateStackRunStatus(stackRunId, "failed", null, errorMessage);
    } catch (dbError) {
      const dbErrorMessage = dbError instanceof Error ? dbError.message : String(dbError);
      log("error", `Failed to update stack run ${stackRunId} status after error: ${dbErrorMessage}`);
    }
    
    // Always trigger next run even on errors
    try {
      await triggerNextPendingStackRun();
    } catch (triggerError) {
      const triggerErrorMsg = triggerError instanceof Error ? triggerError.message : String(triggerError);
      log("error", `Failed to trigger next run after error in ${stackRunId}: ${triggerErrorMsg}`);
    }
    
    return { status: "failed", error: errorMessage };
  }
}

// Handle the incoming stack processor request
async function handleRequest(req: Request): Promise<Response> {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const requestBody = await req.json();
    log("info", `Stack processor request: ${simpleStringify(requestBody)}`);

    // Handle different request types
    if (requestBody.stackRunId) {
      // Process specific stack run
      const result = await processStackRun(requestBody.stackRunId);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } else if (requestBody.trigger === "process-next") {
      // Process next pending stack run
      const pendingRuns = await getPendingStackRuns(1);
      
      if (pendingRuns.length === 0) {
        return new Response(JSON.stringify({ message: "No pending stack runs" }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const result = await processStackRun(pendingRuns[0].id);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } else if (requestBody.trigger === "test-boot") {
      // Test endpoint to verify the function boots correctly
      return new Response(JSON.stringify({ status: "ok", message: "Stack processor booted successfully" }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } else {
      return new Response(JSON.stringify({ error: "Invalid request" }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", `Stack processor error: ${errorMessage}`);
    
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Handle the incoming stack processor request
serve(async (req) => {
  return await handleRequest(req);
});