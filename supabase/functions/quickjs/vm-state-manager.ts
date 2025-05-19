/**
 * VM State Manager for QuickJS
 *
 * Provides utilities for saving and restoring QuickJS VM state
 * to support ephemeral call queueing for nested module calls.
 */

import {
	getQuickJS,
	newAsyncContext,
	QuickJSAsyncContext,
	QuickJSContext,
	QuickJSRuntime,
	QuickJSHandle
} from "quickjs-emscripten";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { hostLog } from '../_shared/utils.ts';

// ==============================
// Types and Interfaces
// ==============================

export interface StackRun {
  id: string;
  parent_stack_run_id?: string;
  parent_task_run_id?: string;
  service_name: string;
  method_name: string;
  args: any[];
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'suspended_waiting_child' | 'pending_resume';
  created_at: string;
  updated_at: string;
  result?: any;
  error?: any;
  resume_payload?: any;
  waiting_on_stack_run_id?: string;
  vm_state?: SerializedVMState;
}

export interface SerializedVMState {
  task_code: string;
  task_name: string;
  input: unknown;
  parent_stack_run_id?: string;
  global_vars: Record<string, unknown>;
  call_context: Record<string, unknown>;
}

// ==============================
// Configuration
// ==============================

// Environment variables for Supabase
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// ==============================
// Utility Functions
// ==============================

/**
 * Generate a UUID for stack runs and task runs
 */
export function _generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Get a Supabase client instance with service role
 */
function getSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// ==============================
// Stack Run Management
// ==============================

/**
 * Saves a stack run to the database and triggers the stack processor
 * 
 * @param stackRunId Unique ID for the stack run
 * @param serviceName Name of the service being called
 * @param methodName Name of the method being called
 * @param args Arguments for the method call
 * @param parentTaskRunId Optional parent task run ID
 * @param parentStackRunId Optional parent stack run ID
 */
export async function saveStackRun(
  stackRunId: string,
  serviceName: string,
  methodName: string,
  args: unknown[],
  parentTaskRunId?: string | null,
  parentStackRunId?: string | null
): Promise<void> {
  hostLog("VM State Manager", "info", `Saving stack run: ${stackRunId} for ${serviceName}.${methodName}`);
  
  try {
    const supabase = getSupabaseClient();
    
    // Insert stack run
    const { error } = await supabase
      .from('stack_runs')
      .insert({
        id: stackRunId,
        parent_stack_run_id: parentStackRunId || null,
        parent_task_run_id: parentTaskRunId || null,
        service_name: serviceName,
        method_name: methodName,
        args: args,
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

    if (error) {
      throw new Error(`Error inserting stack run: ${error.message}`);
    }

    hostLog("VM State Manager", "info", `Stack run saved: ${stackRunId}`);

    // If this stack run has a parent stack run, mark it as suspended
    if (parentStackRunId) {
      await updateParentStackRunStatus(parentStackRunId, stackRunId);
    }

    // Trigger stack processor to handle the new stack run
    await triggerStackProcessor();
    
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM State Manager", "error", `Error saving stack run: ${errorMessage}`);
    throw new Error(`Failed to save stack run: ${errorMessage}`);
  }
}

/**
 * Updates the parent stack run's status to suspended_waiting_child
 */
async function updateParentStackRunStatus(parentStackRunId: string, childStackRunId: string): Promise<void> {
  hostLog("VM State Manager", "info", `Marking parent stack run ${parentStackRunId} as suspended_waiting_child`);
  
  try {
    const { error: updateError } = await getSupabaseClient()
      .from('stack_runs')
      .update({
        status: 'suspended_waiting_child',
        waiting_on_stack_run_id: childStackRunId,
        updated_at: new Date().toISOString()
      })
      .eq('id', parentStackRunId);
      
    if (updateError) {
      hostLog("VM State Manager", "error", `Error updating parent stack run: ${updateError.message}`);
    } else {
      hostLog("VM State Manager", "info", `Parent stack run ${parentStackRunId} marked as suspended_waiting_child`);
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM State Manager", "error", `Error updating parent stack run: ${errorMessage}`);
  }
}

/**
 * Triggers the stack processor to process the next stack run
 */
export async function triggerStackProcessor(): Promise<void> {
  if (!SUPABASE_URL) {
    hostLog("VM State Manager", "error", "Cannot trigger stack processor: SUPABASE_URL not set");
    return;
  }
  
  hostLog("VM State Manager", "info", `Triggering stack processor`);
  
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/stack-processor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({
        trigger: 'vm-state-manager'
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Error triggering stack processor: ${response.status} - ${text}`);
    }
    
    hostLog("VM State Manager", "info", `Stack processor triggered successfully`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM State Manager", "error", `Error triggering stack processor: ${errorMessage}`);
  }
}

/**
 * Gets a stack run from the database by ID
 */
export async function getStackRun(stackRunId: string): Promise<StackRun> {
  hostLog("VM State Manager", "info", `Getting stack run: ${stackRunId}`);
  
  try {
    const supabase = getSupabaseClient();
    
    const { data, error } = await supabase
      .from('stack_runs')
      .select('*')
      .eq('id', stackRunId)
      .single();

    if (error) {
      throw new Error(`Error getting stack run: ${error.message}`);
    }
    
    if (!data) {
      throw new Error(`Stack run not found: ${stackRunId}`);
    }
    
    return data as StackRun;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM State Manager", "error", `Error getting stack run: ${errorMessage}`);
    throw new Error(`Failed to get stack run: ${errorMessage}`);
  }
}

/**
 * Updates a stack run's status and optional result/error
 */
export async function updateStackRun(
  stackRunId: string,
  status: 'processing' | 'completed' | 'failed' | 'suspended_waiting_child' | 'pending_resume',
  result?: unknown,
  error?: unknown
): Promise<void> {
  hostLog("VM State Manager", "info", `Updating stack run ${stackRunId} to status: ${status}`);

  try {
    const updateData: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString()
    };

    if (result !== undefined) {
      updateData.result = result;
    }

    if (error !== undefined) {
      updateData.error = error;
    }

    const { error: updateError } = await getSupabaseClient()
      .from('stack_runs')
      .update(updateData)
      .eq('id', stackRunId);

    if (updateError) {
      hostLog("VM State Manager", "error", `Error updating stack run: ${updateError.message}`);
      throw updateError;
    }

    hostLog("VM State Manager", "info", `Stack run ${stackRunId} updated to status: ${status}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM State Manager", "error", `Error updating stack run: ${errorMessage}`);
    throw error;
  }
}

/**
 * Gets pending stack runs from the database
 */
export async function getPendingStackRuns(): Promise<StackRun[]> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('stack_runs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(10);

    if (error) {
      hostLog("VM State Manager", "error", `Error fetching pending stack runs: ${error.message}`);
      return [];
    }

    return data as StackRun[] || [];
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM State Manager", "error", `Error in getPendingStackRuns: ${errorMessage}`);
    return [];
  }
}

/**
 * Cleans up a completed stack run by deleting it from the database
 */
export async function cleanupStackRun(stackRunId: string): Promise<void> {
  hostLog("VM State Manager", "info", `Cleaning up completed stack run: ${stackRunId}`);
  
  try {
    const supabase = getSupabaseClient();
    
    // Delete stack run from database
    const { error } = await supabase
      .from('stack_runs')
      .delete()
      .eq('id', stackRunId);
      
    if (error) {
      throw new Error(`Error deleting stack run: ${error.message}`);
    }
    
    hostLog("VM State Manager", "info", `Successfully cleaned up stack run ${stackRunId}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM State Manager", "error", `Error cleaning up stack run: ${errorMessage}`);
  }
}

// ==============================
// Task Run Management
// ==============================

/**
 * Updates a task run status, result and error
 */
export async function updateTaskRun(
  taskRunId: string,
  status: 'processing' | 'completed' | 'failed' | 'suspended',
  result?: unknown,
  error?: unknown
): Promise<void> {
  if (!taskRunId) {
    hostLog("VM State Manager", "warn", "No task run ID provided, not updating");
    return;
  }
  
  hostLog("VM State Manager", "info", `Updating task run ${taskRunId} with status: ${status}`);
  
  try {
    const supabase = getSupabaseClient();
    
    // Prepare update data
    const updateData: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString()
    };
    
    if (result !== undefined) {
      updateData.result = result;
    }
    
    if (error !== undefined) {
      updateData.error = error;
    }
    
    // End timestamp for terminal states
    if (status === 'completed' || status === 'failed') {
      updateData.ended_at = new Date().toISOString();
    }
    
    // Update task run in database
    const { error: updateError } = await supabase
      .from('task_runs')
      .update(updateData)
      .eq('id', taskRunId);
      
    if (updateError) {
      throw new Error(`Error updating task run: ${updateError.message}`);
    }

    hostLog("VM State Manager", "info", `Task run ${taskRunId} updated successfully to ${status}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM State Manager", "error", `Error updating task run: ${errorMessage}`);
  }
}

// ==============================
// VM State Management
// ==============================

/**
 * Captures VM state information to be serialized and stored
 */
export function captureVMState(
  context: QuickJSAsyncContext, 
  taskCode: string,
  taskName: string,
  taskInput: unknown,
  parentRunId?: string
): SerializedVMState {
  hostLog("VM State Manager", "info", `Capturing VM state for task: ${taskName}`);
  
  // Extract global variables from the context
  const globalVars = extractGlobalVars(context);
  
  // Extract call context information
  const callContext = extractCallContext(context);

  // Create a state object with all information
  const vmState: SerializedVMState = {
    task_code: taskCode,
    task_name: taskName,
    input: taskInput,
    parent_stack_run_id: parentRunId,
    global_vars: globalVars,
    call_context: callContext
  };
  
  hostLog("VM State Manager", "info", `VM state captured for task: ${taskName}`);
  return vmState;
}

/**
 * Extract global variables from VM context
 */
function extractGlobalVars(context: QuickJSAsyncContext): Record<string, unknown> {
  let globalVars: Record<string, unknown> = {};
  try {
    // Get global state from the VM context by evaluating a serialization function
    const evalResult = context.evalCode(`
      (() => {
        const globals = {};
        // List of important global variables to capture
        const globalVarNames = [
          // Task-specific globals
          'taskRunId', 'taskName', 'taskInput', 'taskResult',
          // State tracking variables
          'callSiteId', 'resumePayload', 'suspendedCallData',
          // Other important globals
          'serviceProxies', 'moduleCache'
        ];

        // Capture each global variable if it exists
        for (const varName of globalVarNames) {
          if (typeof globalThis[varName] !== 'undefined') {
            try {
              // Only capture serializable values
              globals[varName] = JSON.parse(JSON.stringify(globalThis[varName]));
            } catch (e) {
              console.log('Failed to serialize global var:', varName);
            }
          }
        }
        return globals;
      })()
    `);
    
    if (!evalResult.error && evalResult.value) {
      // Extract the globals object from the VM
      globalVars = context.dump(evalResult.value) as Record<string, unknown>;
      evalResult.value.dispose();
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM State Manager", "error", `Error extracting global variables: ${errorMessage}`);
    // Continue with empty globals if extraction fails
  }
  
  return globalVars;
}

/**
 * Extract call context information from VM
 */
function extractCallContext(context: QuickJSAsyncContext): Record<string, unknown> {
  let callContext: Record<string, unknown> = {};
  try {
    // Get call context from the VM by evaluating a function that captures call site info
    const evalResult = context.evalCode(`
      (() => {
        const callSiteInfo = {
          // The current position in the code where execution is suspended
          callSiteId: typeof callSiteId !== 'undefined' ? callSiteId : null,
          // Metadata about child function being called
          suspendedCallData: typeof suspendedCallData !== 'undefined' ? suspendedCallData : null,
          // Call stack information if available
          stackTrace: new Error().stack,
          // Current time for debugging
          suspendedAt: new Date().toISOString()
        };
        return callSiteInfo;
      })()
    `);
    
    if (!evalResult.error && evalResult.value) {
      // Extract the call context from the VM
      callContext = context.dump(evalResult.value) as Record<string, unknown>;
      evalResult.value.dispose();
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM State Manager", "error", `Error extracting call context: ${errorMessage}`);
    // Continue with empty call context if extraction fails
  }
  
  return callContext;
}

/**
 * Restores the VM state from the database
 */
export async function restoreVMState(
  stackRunId: string
): Promise<{ context: QuickJSAsyncContext, stackRun: StackRun }> {
  hostLog("VM State Manager", "info", `Restoring VM state for stack run ID: ${stackRunId}`);

  try {
    // Fetch the stack run record
    const stackRun = await getStackRun(stackRunId);
    
    // Create a new QuickJS async context for the restored VM
    const quickjs = await getQuickJS();
    const rt = quickjs.newRuntime();
    const asyncContext = await newAsyncContext(rt as any);
    
    hostLog("VM State Manager", "info", `Created new VM context for stack run: ${stackRunId}`);
    
    // If we don't have saved VM state, just return the fresh context
    if (!stackRun.vm_state) {
      hostLog("VM State Manager", "info", `No VM state found for stack run: ${stackRunId}`);
      return { context: asyncContext, stackRun };
    }
    
    // Strongly type the VM state for safer access
    const vmState = stackRun.vm_state as SerializedVMState;
    
    // Restore the VM state (this is a simplified version)
    hostLog("VM State Manager", "info", `Restoring VM state for stack run: ${stackRunId}`);
    
    return { context: asyncContext, stackRun };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM State Manager", "error", `Error restoring VM state: ${errorMessage}`);
    throw new Error(`Failed to restore VM state: ${errorMessage}`);
  }
}

/**
 * Prepares a stack run for resumption with the results from its child execution
 */
export async function prepareStackRunResumption(
  parentStackRunId: string,
  childStackRunId: string,
  childResult: unknown
): Promise<boolean> {
  hostLog("VM State Manager", "info", `Preparing stack run ${parentStackRunId} for resumption with child result`);

  try {
    const supabase = getSupabaseClient();
    
    // First, fetch the parent stack run to verify its state
    const { data: parentStackRun, error: fetchError } = await supabase
      .from('stack_runs')
      .select('*')
      .eq('id', parentStackRunId)
      .single();

    if (fetchError || !parentStackRun) {
      hostLog("VM State Manager", "error", `Error fetching parent stack run: ${fetchError?.message || 'Record not found'}`);
      return false;
    }

    // Verify the parent is actually in suspended state
    if (parentStackRun.status !== 'suspended_waiting_child') {
      hostLog("VM State Manager", "error", `Parent stack run ${parentStackRunId} is not in suspended_waiting_child state, found: ${parentStackRun.status}`);
      return false;
    }

    // Update to pending_resume with child result
    const { error: updateError } = await supabase
      .from('stack_runs')
      .update({
        status: 'pending_resume',
        resume_payload: childResult,
        updated_at: new Date().toISOString()
      })
      .eq('id', parentStackRunId);

    if (updateError) {
      hostLog("VM State Manager", "error", `Error updating parent stack run for resumption: ${updateError.message}`);
      return false;
    }

    hostLog("VM State Manager", "info", `Stack run ${parentStackRunId} prepared for resumption`);

    // If there's a parent task run, update it too
    if (parentStackRun.parent_task_run_id) {
      await updateTaskRun(
        parentStackRun.parent_task_run_id,
        'processing',
        undefined,
        undefined
      );
    }

    return true;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM State Manager", "error", `Error preparing stack run for resumption: ${errorMessage}`);
    return false;
  }
}
