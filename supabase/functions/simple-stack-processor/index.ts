/**
 * Simple Stack Processor - Lightweight version for fast boot times
 * 
 * Processes stack runs with minimal complexity to avoid worker timeouts
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

// Environment variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Create Supabase client
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Simple logging
function log(level: string, message: string) {
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] [SIMPLE-STACK-PROCESSOR] ${message}`);
}

// Database-based coordination to prevent concurrent execution across workers
async function tryLockTaskChain(taskRunId: number, retries: number = 3): Promise<boolean> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Try to insert a lock record - will fail if already exists
      const { error } = await supabase
        .from('task_locks')
        .insert({
          task_run_id: taskRunId,
          locked_at: new Date().toISOString(),
          locked_by: `simple-stack-processor-${Date.now()}-${Math.random()}`
        });

      if (error) {
        // Lock already exists or other error
        if (attempt < retries) {
          // Wait a bit before retrying
          await new Promise(resolve => setTimeout(resolve, 100 * attempt));
          continue;
        }
        return false;
      }

      log("info", `Successfully locked task chain ${taskRunId} on attempt ${attempt}`);
      return true;
    } catch (error) {
      log("error", `Failed to lock task chain ${taskRunId} on attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
        continue;
      }
      return false;
    }
  }
  return false;
}

// Release task chain lock
async function unlockTaskChain(taskRunId: number): Promise<void> {
  try {
    const { error } = await supabase
      .from('task_locks')
      .delete()
      .eq('task_run_id', taskRunId);

    if (error) {
      log("error", `Failed to unlock task chain ${taskRunId}: ${error.message}`);
    } else {
      log("info", `Successfully unlocked task chain ${taskRunId}`);
    }
  } catch (error) {
    log("error", `Failed to unlock task chain ${taskRunId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Fire-and-forget stack processor trigger with throttling
let lastTriggerTime = 0;
const MIN_TRIGGER_INTERVAL = 1000; // Minimum 1 second between triggers

function triggerStackProcessorAsync(): void {
  const now = Date.now();
  if (now - lastTriggerTime < MIN_TRIGGER_INTERVAL) {
    // Skip this trigger to prevent overwhelming the system
    return;
  }
  lastTriggerTime = now;

  // Use setTimeout to make it truly async and non-blocking
  setTimeout(() => {
    fetch(`${SUPABASE_URL}/functions/v1/simple-stack-processor`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({ trigger: 'process-next' })
    }).catch(error => {
      log("warn", `Async trigger failed (non-critical): ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 0);
}

// Interval-based processing to ensure continuous operation
let processingInterval: number | null = null;
let consecutiveEmptyRuns = 0;
const MAX_CONSECUTIVE_EMPTY_RUNS = 5;

function startContinuousProcessing(): void {
  if (processingInterval !== null) {
    return; // Already running
  }

  log("info", "Starting continuous processing interval");

  processingInterval = setInterval(async () => {
    // Check if there are any pending stack runs before triggering
    try {
      const { data, error } = await supabase
        .from('stack_runs')
        .select('id')
        .eq('status', 'pending')
        .limit(1);

      if (error || !data || data.length === 0) {
        consecutiveEmptyRuns++;
        if (consecutiveEmptyRuns >= MAX_CONSECUTIVE_EMPTY_RUNS) {
          // Temporarily stop processing to reduce resource usage
          log("info", "No pending stack runs found for multiple cycles, pausing processing");
          stopContinuousProcessing();
          // Restart after a longer delay
          setTimeout(() => {
            consecutiveEmptyRuns = 0;
            startContinuousProcessing();
          }, 10000); // 10 second pause
          return;
        }
      } else {
        consecutiveEmptyRuns = 0;
        // Fire-and-forget trigger to process next stack run
        triggerStackProcessorAsync();
      }
    } catch (error) {
      log("warn", `Error checking for pending stack runs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 3000); // Increased to 3 seconds to reduce load
}

function stopContinuousProcessing(): void {
  if (processingInterval !== null) {
    clearInterval(processingInterval);
    processingInterval = null;
    log("info", "Stopped continuous processing interval");
  }
}

// Check if there are any processing stack runs for this task chain
async function isTaskChainBusy(taskRunId: number): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('stack_runs')
      .select('id')
      .eq('parent_task_run_id', taskRunId)
      .eq('status', 'processing')
      .limit(1);

    if (error) {
      log("error", `Failed to check task chain status: ${error.message}`);
      return false;
    }

    return data && data.length > 0;
  } catch (error) {
    log("error", `Failed to check task chain status: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// Get stack run from database
async function getStackRun(id: number) {
  const { data, error } = await supabase
    .from('stack_runs')
    .select('*')
    .eq('id', id)
    .single();
    
  if (error) throw new Error(`Failed to get stack run ${id}: ${error.message}`);
  return data;
}

// Update stack run status
async function updateStackRunStatus(id: number, status: string, result?: any, error?: string) {
  const updates: any = { 
    status, 
    updated_at: new Date().toISOString() 
  };
  
  if (result !== undefined) updates.result = result;
  if (error !== undefined) updates.error = error;
  if (status === 'completed' || status === 'failed') updates.ended_at = new Date().toISOString();
  
  const { error: updateError } = await supabase
    .from('stack_runs')
    .update(updates)
    .eq('id', id);
    
  if (updateError) throw new Error(`Failed to update stack run ${id}: ${updateError.message}`);
}

// Process a service call
async function processServiceCall(stackRun: any) {
  const { service_name, method_name, args, vm_state } = stackRun;

  log("info", `Processing service call: ${service_name}.${method_name}`);

  try {
    let response;

    if (service_name === 'deno-executor' && method_name === 'execute') {
      // Special handling for deno-executor calls (main tasks)
      const requestBody = {
        taskName: vm_state?.taskName || args[0],
        taskCode: vm_state?.taskCode,
        taskRunId: stackRun.parent_task_run_id,
        stackRunId: stackRun.id,
        taskInput: vm_state?.taskInput || args[1]
      };

      response = await fetch(`${SUPABASE_URL}/functions/v1/deno-executor`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify(requestBody)
      });
    } else if (service_name === 'tasks' && method_name === 'execute') {
      // Special handling for nested task calls
      const requestBody = {
        taskName: args[0],
        input: args[1]
      };

      response = await fetch(`${SUPABASE_URL}/functions/v1/tasks/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify(requestBody)
      });
    } else {
      // Standard wrapped service call
      const methodParts = method_name.split('.');
      const chain = methodParts.map((part, index) => {
        if (index === methodParts.length - 1) {
          // Last part gets the actual arguments
          return { property: part, args: args };
        } else {
          // Intermediate parts get empty args array
          return { property: part, args: [] };
        }
      });

      response = await fetch(`${SUPABASE_URL}/functions/v1/${service_name}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({ chain })
      });
    }

    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    log("info", `Service call ${service_name}.${method_name} completed successfully`);

    // CRITICAL: Check if this is a suspension response from deno-executor
    // The suspension data might be nested in result.result for deno-executor responses
    const suspensionData = result?.result || result;
    if (suspensionData && suspensionData.__hostCallSuspended === true) {
      log("info", `Task suspended for external call, child stack run: ${suspensionData.stackRunId}`);

      // Update the current stack run to suspended_waiting_child
      await updateStackRunStatus(stackRun.id, 'suspended_waiting_child');

      // Update waiting_on_stack_run_id to track which child we're waiting for
      const { error: updateError } = await supabase
        .from('stack_runs')
        .update({
          waiting_on_stack_run_id: suspensionData.stackRunId,
          updated_at: new Date().toISOString()
        })
        .eq('id', stackRun.id);

      if (updateError) {
        log("error", `Failed to update waiting_on_stack_run_id: ${updateError.message}`);
      } else {
        log("info", `Updated stack run ${stackRun.id} to wait for child ${suspensionData.stackRunId}`);
      }

      // Return suspension indicator instead of the suspension object
      throw new Error(`SUSPENDED_WAITING_FOR_CHILD:${suspensionData.stackRunId}`);
    }

    return result;

  } catch (error) {
    log("error", `Service call ${service_name}.${method_name} failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// Resume parent task
async function resumeParentTask(stackRun: any, result: any) {
  if (!stackRun.parent_stack_run_id) {
    log("info", `Stack run ${stackRun.id} has no parent to resume`);
    return;
  }

  // CRITICAL FIX: Check if the parent is actually waiting for this specific child
  // Only resume the parent if it's suspended and waiting for this specific stack run
  const { data: parentStackRun, error: parentError } = await supabase
    .from('stack_runs')
    .select('*')
    .eq('id', stackRun.parent_stack_run_id)
    .single();

  if (parentError || !parentStackRun) {
    log("error", `Failed to get parent stack run ${stackRun.parent_stack_run_id}: ${parentError?.message}`);
    return;
  }

  // Check if parent is suspended and waiting for this specific child
  if (parentStackRun.status !== 'suspended_waiting_child') {
    log("info", `Parent stack run ${stackRun.parent_stack_run_id} is not suspended_waiting_child (status: ${parentStackRun.status}), not resuming`);
    return;
  }

  // Check if parent is waiting for this specific child stack run
  if (parentStackRun.waiting_on_stack_run_id !== stackRun.id) {
    log("info", `Parent stack run ${stackRun.parent_stack_run_id} is waiting for stack run ${parentStackRun.waiting_on_stack_run_id}, not ${stackRun.id}, not resuming`);
    return;
  }

  log("info", `Resuming parent task ${stackRun.parent_stack_run_id} with result from expected child ${stackRun.id}`);

  try {
    // CRITICAL: Ensure the result is in the correct format for the task code
    // The task code expects the same structure as the original Google API response
    let formattedResult = result;

    // For Google API calls, ensure the result has the expected wrapper structure
    if (stackRun.service_name === 'wrappedgapi') {
      // The result should already be in the correct format from wrappedgapi
      // but let's ensure it's properly structured
      if (stackRun.method_name === 'admin.domains.list' && result && !result.domains && Array.isArray(result)) {
        // If we got a raw array, wrap it in the expected structure
        formattedResult = { domains: result };
        log("info", `Wrapped domains array in expected structure for task code`);
      } else if (stackRun.method_name === 'admin.users.list' && result && !result.users && Array.isArray(result)) {
        // If we got a raw array, wrap it in the expected structure
        formattedResult = { users: result };
        log("info", `Wrapped users array in expected structure for task code`);
      }
    }

    // Update parent to pending_resume status
    await updateStackRunStatus(stackRun.parent_stack_run_id, 'pending_resume');

    // Update parent with resume payload
    const { error } = await supabase
      .from('stack_runs')
      .update({
        resume_payload: formattedResult,
        updated_at: new Date().toISOString()
      })
      .eq('id', stackRun.parent_stack_run_id);

    if (error) throw new Error(`Failed to set resume payload: ${error.message}`);

    // Call deno-executor to resume the parent task
    const resumeResponse = await fetch(`${SUPABASE_URL}/functions/v1/deno-executor/resume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        stackRunIdToResume: stackRun.parent_stack_run_id,
        resultToInject: formattedResult
      })
    });

    if (!resumeResponse.ok) {
      throw new Error(`Failed to resume parent: ${resumeResponse.status} - ${await resumeResponse.text()}`);
    }

    const resumeResult = await resumeResponse.json();
    log("info", `Parent task ${stackRun.parent_stack_run_id} resumed successfully`);

    // Update parent with final result
    if (resumeResult.status === 'completed') {
      await updateStackRunStatus(stackRun.parent_stack_run_id, 'completed', resumeResult.result);
    } else if (resumeResult.status === 'error') {
      await updateStackRunStatus(stackRun.parent_stack_run_id, 'failed', null, resumeResult.error);
    }

    // Note: No need to trigger next processing here since the resumed task
    // will trigger the next stack run when it completes
    
  } catch (error) {
    log("error", `Failed to resume parent task: ${error instanceof Error ? error.message : String(error)}`);
    await updateStackRunStatus(stackRun.parent_stack_run_id, 'failed', null, `Resume failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Internal function to actually process a stack run
async function processStackRunInternal(stackRunId: number): Promise<boolean> {
  log("info", `Processing stack run: ${stackRunId}`);

  try {
    // Get the stack run
    const stackRun = await getStackRun(stackRunId);

    if (stackRun.status !== 'pending') {
      log("info", `Stack run ${stackRunId} is not pending (status: ${stackRun.status}), skipping`);
      return false;
    }

    // CRITICAL: Check if this task chain is already being processed
    const taskRunId = stackRun.parent_task_run_id;

    // Check if task chain is busy
    const isBusy = await isTaskChainBusy(taskRunId);
    if (isBusy) {
      log("info", `Task chain ${taskRunId} is already busy, skipping stack run ${stackRunId}`);
      return false;
    }

    // CRITICAL FIX: Allow child stack runs to process even if parent holds the lock
    // Check if this is a child stack run that should be allowed to process
    let lockAcquired = false;
    let bypassedLock = false;

    if (stackRun.parent_stack_run_id) {
      // This is a child stack run - check if it can be processed
      const { data: parentStackRun } = await supabase
        .from('stack_runs')
        .select('status, waiting_on_stack_run_id')
        .eq('id', stackRun.parent_stack_run_id)
        .single();

      if (parentStackRun) {
        // Allow child to process if:
        // 1. Parent is suspended waiting for this specific child, OR
        // 2. Parent is completed (no longer blocking), OR
        // 3. Parent is waiting for a different child (this one can run in parallel)
        const canProcess =
          (parentStackRun.status === 'suspended_waiting_child' && parentStackRun.waiting_on_stack_run_id === stackRunId) ||
          (parentStackRun.status === 'completed') ||
          (parentStackRun.waiting_on_stack_run_id && parentStackRun.waiting_on_stack_run_id !== stackRunId);

        if (canProcess) {
          log("info", `Allowing child stack run ${stackRunId} to process (parent status: ${parentStackRun.status}, waiting for: ${parentStackRun.waiting_on_stack_run_id})`);
          lockAcquired = true; // Bypass lock requirement
          bypassedLock = true;
        } else {
          // Try to acquire lock normally
          lockAcquired = await tryLockTaskChain(taskRunId);
        }
      } else {
        // Parent not found - try to acquire lock normally
        lockAcquired = await tryLockTaskChain(taskRunId);
      }
    } else {
      // This is a top-level stack run - try to acquire lock normally
      lockAcquired = await tryLockTaskChain(taskRunId);
    }

    if (!lockAcquired) {
      log("info", `Could not acquire lock for task chain ${taskRunId}, skipping stack run ${stackRunId}`);
      return false;
    }

    try {
      // Update to processing
      await updateStackRunStatus(stackRunId, 'processing');

      // Process the service call
      const result = await processServiceCall(stackRun);

      // If we get here without suspension, mark as completed
      await updateStackRunStatus(stackRunId, 'completed', result);

      // Resume parent task if exists
      await resumeParentTask(stackRun, result);

      log("info", `Stack run ${stackRunId} completed successfully`);

      return true; // Successfully processed

    } catch (error) {
      // Check if this is a suspension error
      if (error instanceof Error && error.message.startsWith('SUSPENDED_WAITING_FOR_CHILD:')) {
        const childStackRunId = error.message.substring('SUSPENDED_WAITING_FOR_CHILD:'.length);
        log("info", `Stack run ${stackRunId} suspended, waiting for child ${childStackRunId}`);

        // The stack run is already updated to suspended_waiting_child status in processServiceCall
        // Don't unlock the task chain - keep it locked until the child completes
        return true; // Successfully suspended (not failed)
      }

      // For other errors, unlock and fail (only if we actually acquired a lock)
      if (!bypassedLock) {
        await unlockTaskChain(taskRunId);
      }
      log("error", `Stack run ${stackRunId} failed: ${error instanceof Error ? error.message : String(error)}`);
      await updateStackRunStatus(stackRunId, 'failed', null, error instanceof Error ? error.message : String(error));
      return false; // Failed to process
    } finally {
      // Only unlock if we actually acquired a lock and not suspended
      if (!bypassedLock) {
        const { data: currentStackRun } = await supabase
          .from('stack_runs')
          .select('status')
          .eq('id', stackRunId)
          .single();

        if (currentStackRun && currentStackRun.status !== 'suspended_waiting_child') {
          await unlockTaskChain(taskRunId);
        }
      }
    }

  } catch (error) {
    log("error", `Stack run ${stackRunId} processing failed: ${error instanceof Error ? error.message : String(error)}`);
    await updateStackRunStatus(stackRunId, 'failed', null, error instanceof Error ? error.message : String(error));
    return false;
  }
}

// Process a single stack run (atomic operation)
async function processSingleStackRun(): Promise<{ processed: boolean; reason?: string; stackRunId?: number }> {
  log("info", "Processing single stack run");

  const nextStackRun = await getNextPendingStackRun();

  if (!nextStackRun) {
    log("info", "No pending stack runs to process");
    return { processed: false, reason: "no_pending" };
  }

  log("info", `Processing next stack run ${nextStackRun.id} in serial order`);

  const success = await processStackRunInternal(nextStackRun.id);

  if (success) {
    log("info", `Stack run ${nextStackRun.id} processed successfully`);

    // CRITICAL: Trigger next stack run processing at the end (fire-and-forget)
    // This ensures each stack run is atomic and triggers the next one
    triggerStackProcessorAsync();

    return { processed: true, stackRunId: nextStackRun.id };
  } else {
    log("warn", `Failed to process stack run ${nextStackRun.id}`);
    return { processed: false, reason: "processing_failed", stackRunId: nextStackRun.id };
  }
}

// Public function to process a stack run (uses database-based coordination)
async function processStackRun(stackRunId: number): Promise<void> {
  log("info", `Processing stack run ${stackRunId} with database coordination`);
  await processStackRunInternal(stackRunId);
}

// Get next pending stack run - RESPECTING SERIAL EXECUTION ORDER
async function getNextPendingStackRun() {
  // CRITICAL: Only process stack runs that don't have pending dependencies
  // This ensures we maintain the serial execution order from the original task code

  const { data, error } = await supabase
    .from('stack_runs')
    .select('id, parent_task_run_id, parent_stack_run_id, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to get pending stack runs: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return null;
  }

  // Find the first stack run that has no pending dependencies
  for (const stackRun of data) {
    // Check if this stack run has any pending siblings that were created before it
    // (indicating they should be processed first to maintain serial order)
    const { data: pendingSiblings, error: siblingsError } = await supabase
      .from('stack_runs')
      .select('id')
      .eq('parent_task_run_id', stackRun.parent_task_run_id)
      .eq('status', 'pending')
      .lt('created_at', stackRun.created_at);

    if (siblingsError) {
      log("error", `Failed to check pending siblings: ${siblingsError.message}`);
      continue;
    }

    // If no pending siblings created before this one, it's safe to process
    if (!pendingSiblings || pendingSiblings.length === 0) {
      return { id: stackRun.id };
    }
  }

  // No stack runs are ready to process (all have pending dependencies)
  return null;
}

// Start continuous processing when the service starts
startContinuousProcessing();

// Main handler
serve(async (req: Request) => {
  try {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Handle GET requests for health checks
    if (req.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'healthy',
        service: 'Simple Stack Processor',
        version: '1.0.0',
        continuousProcessing: processingInterval !== null
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    
    const requestData = await req.json();
    
    if (requestData.stackRunId) {
      // Process specific stack run
      await processStackRun(requestData.stackRunId);
    } else if (requestData.trigger === 'process-next') {
      // Process single stack run atomically - RESPECTING SERIAL ORDER
      const result = await processSingleStackRun();

      return new Response(JSON.stringify({
        status: 'success',
        processed: result.processed,
        reason: result.reason,
        stackRunId: result.stackRunId
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } else {
      return new Response(JSON.stringify({
        error: "Invalid request: must specify stackRunId or trigger=process-next"
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    
    return new Response(JSON.stringify({
      status: 'success'
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
    
  } catch (error) {
    log("error", `Error in serve function: ${error instanceof Error ? error.message : String(error)}`);
    
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});

console.log("🚀 Simple Stack Processor started successfully");
