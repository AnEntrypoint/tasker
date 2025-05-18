/**
 * VM State Manager for QuickJS
 *
 * Provides utilities for saving and restoring QuickJS VM state
 * to support ephemeral call queueing for nested module calls.
 */

import { QuickJSAsyncContext, QuickJSContext } from "quickjs-emscripten";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { getQuickJS } from "quickjs-emscripten";
import { hostLog } from '../_shared/utils.ts';

// Import required interfaces
import type { QuickJSHandle } from 'quickjs-emscripten';

// Define interfaces for VM state
interface SerializedVMState {
  task_code: string;
  task_name: string;
  input: unknown;
  parent_stack_run_id?: string;
  global_vars: Record<string, unknown>;
  call_context: Record<string, unknown>;
  pending_stack_run_id?: string;
  pending_call?: {
    module_name: string;
    method_name: string;
    args: unknown[];
  };
}

// Interface for stack run records
interface StackRun {
  id: string;
  parent_stack_run_id?: string;
  module_name?: string;
  service_name: string;
  method_name: string;
  args: any[];
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'pending_resume';
  created_at: string;
  updated_at: string;
  result?: any;
  error?: any;
  resume_payload?: any;
  vm_state?: SerializedVMState;
}

// Get environment variables for Supabase
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Supabase client for database operations
const getSupabaseClient = () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required");
  }
  
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
};

/**
 * Simple UUID generator function
 */
export function _generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Interface for VM state pointers
 */
interface VMPointers {
  vmPtr: number;
  rtPtr: number;
}

/**
 * Compresses a Uint8Array using CompressionStream
 */
async function _compressBuffer(buffer: ArrayBuffer): Promise<Uint8Array> {
  const compressionStream = new CompressionStream('gzip');
  const uint8Buffer = new Uint8Array(buffer);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(uint8Buffer);
      controller.close();
    },
  });
  const compressedStream = stream.pipeThrough(compressionStream);
  const compressedBuffer = await new Response(compressedStream).arrayBuffer();
  return new Uint8Array(compressedBuffer);
}

/**
 * Decompresses a Uint8Array using DecompressionStream
 */
async function _decompressBuffer(compressedBuffer: Uint8Array): Promise<Uint8Array> {
  const decompressionStream = new DecompressionStream('gzip');
  const compressedStream = new ReadableStream({
    start(controller) {
      controller.enqueue(compressedBuffer);
      controller.close();
    },
  });
  const decompressedStream = compressedStream.pipeThrough(decompressionStream);
  const decompressedBuffer = await new Response(decompressedStream).arrayBuffer();
  return new Uint8Array(decompressedBuffer);
}

/**
 * Saves a stack run to the database and triggers the stack processor
 */
export async function saveStackRun(
  stackRunId: string,
  moduleName: string,
  methodName: string,
  args: unknown[],
  parentRunId?: string,
  parentStackRunId?: string
): Promise<void> {
  hostLog("[VM State Manager]", "info", `Saving stack run ${stackRunId} for ${moduleName}.${methodName}`);
  
  try {
    // Get environment variables for Supabase connection
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Missing Supabase configuration");
    }
    
    // Create Supabase client
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // Insert record into stack_runs table
    const { error } = await supabase
      .from('stack_runs')
      .insert({
        id: stackRunId,
        parent_run_id: parentRunId || null,
        parent_stack_run_id: parentStackRunId || null,
        module_name: moduleName,
        service_name: moduleName, // Ensure both fields are set for backward compatibility
        method_name: methodName,
        args: args,
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      
    if (error) {
      throw new Error(`Error inserting stack run: ${error.message}`);
    }
    
    hostLog("[VM State Manager]", "info", `Stack run saved: ${stackRunId}`);
    
    // Trigger stack processor to handle the new stack run
    await triggerStackProcessor(supabaseUrl);
    
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("[VM State Manager]", "error", `Error saving stack run: ${errorMessage}`);
    throw new Error(`Failed to save stack run: ${errorMessage}`);
  }
}

/**
 * Triggers the stack processor to process the next stack run
 */
async function triggerStackProcessor(supabaseUrl: string): Promise<void> {
  hostLog("[VM State Manager]", "info", `Triggering stack processor at: ${supabaseUrl}/functions/v1/stack-processor`);
  
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/stack-processor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        trigger: 'vm-state-manager'
      })
    });
    
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Error triggering stack processor: ${response.status} - ${text}`);
    }
    
    hostLog("[VM State Manager]", "info", `Stack processor triggered`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("[VM State Manager]", "error", `Error triggering stack processor: ${errorMessage}`);
  }
}

/**
 * Gets a stack run from the database
 */
export async function getStackRun(stackRunId: string): Promise<any> {
  hostLog("[VM State Manager]", "info", `Getting stack run: ${stackRunId}`);
  
  try {
    // Get environment variables for Supabase connection
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Missing Supabase configuration");
    }
    
    // Create Supabase client
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // Get stack run from database
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
    
    return data;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("[VM State Manager]", "error", `Error getting stack run: ${errorMessage}`);
    throw new Error(`Failed to get stack run: ${errorMessage}`);
  }
}

/**
 * Updates a parent task run with a result or error
 */
export async function updateParentTaskRun(
  parentRunId: string,
  result?: unknown,
  error?: string
): Promise<void> {
  if (!parentRunId) {
    hostLog("[VM State Manager]", "warn", "No parent task run ID provided, not updating");
    return;
  }
  
  hostLog("[VM State Manager]", "info", `Updating parent task run ${parentRunId} with result`);
  
  try {
    // Get environment variables for Supabase connection
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Missing Supabase configuration");
    }
    
    // Create Supabase client
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // Prepare update data
    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      status: error ? 'failed' : 'completed'
    };
    
    if (result !== undefined) {
      updateData.result = result;
    }
    
    if (error) {
      updateData.error = error;
    }
    
    // Update task run in database
    const { error: updateError } = await supabase
      .from('task_runs')
      .update(updateData)
      .eq('id', parentRunId);
      
    if (updateError) {
      throw new Error(`Error updating parent task run: ${updateError.message}`);
    }
    
    hostLog("[VM State Manager]", "info", `Parent task run ${parentRunId} updated successfully`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("[VM State Manager]", "error", `Error updating parent task run: ${errorMessage}`);
  }
}

/**
 * Cleans up a completed stack run
 */
export async function cleanupStackRun(stackRunId: string): Promise<void> {
  hostLog("[VM State Manager]", "info", `Cleaning up completed stack run: ${stackRunId}`);
  
  try {
    // Get environment variables for Supabase connection
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Missing Supabase configuration");
    }
    
    // Create Supabase client
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // Delete stack run from database
    const { error } = await supabase
      .from('stack_runs')
      .delete()
      .eq('id', stackRunId);
      
    if (error) {
      throw new Error(`Error deleting stack run: ${error.message}`);
    }
    
    hostLog("[VM State Manager]", "info", `Successfully cleaned up stack run ${stackRunId}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("[VM State Manager]", "error", `Error cleaning up stack run: ${errorMessage}`);
  }
}

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
  console.log(`[VM State Manager] Capturing VM state for task: ${taskName}`);
  
  // Extract global variables from the context
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
    console.error(`[VM State Manager] Error extracting global variables: ${error instanceof Error ? error.message : String(error)}`);
    // Continue with empty globals if extraction fails
  }

  // Extract call context information
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
    console.error(`[VM State Manager] Error extracting call context: ${error instanceof Error ? error.message : String(error)}`);
    // Continue with empty call context if extraction fails
  }

  // Create a state object with all information
  const vmState: SerializedVMState = {
    task_code: taskCode,
    task_name: taskName,
    input: taskInput,
    parent_stack_run_id: parentRunId,
    global_vars: globalVars,
    call_context: callContext
  };
  
  console.log(`[VM State Manager] VM state captured for task: ${taskName}`);
  return vmState;
}

/**
 * Restores the VM state from the database
 */
export async function restoreVMState(
  stackRunId: string,
  _variant: unknown
): Promise<{ context: QuickJSAsyncContext, stackRun: StackRun }> {
  console.log(`[VM State Manager] Restoring VM state for stack run ID: ${stackRunId}...`);

  try {
    // Fetch the stack run record
    const { data: stackRun, error } = await getSupabaseClient().from('stack_runs')
      .select('*')
      .eq('id', stackRunId)
      .single();

    if (error || !stackRun) {
      throw new Error(`Failed to fetch stack run: ${error?.message || 'Record not found'}`);
    }
    
    console.log(`[VM State Manager] Stack run loaded: ${stackRunId}, status: ${stackRun.status}`);
    
    // Create a new QuickJS async context for the restored VM
    const quickjs = await getQuickJS();
    const rt = quickjs.newRuntime();
    const context = rt.newContext();
    
    if (!stackRun.vm_state) {
      console.log(`[VM State Manager] No VM state found for stack run: ${stackRunId}`);
      return { context, stackRun };
    }
    
    // Strongly type the VM state for safer access
    const vmState = stackRun.vm_state as SerializedVMState;
    
    // Restore the task code
    if (vmState.task_code) {
      console.log(`[VM State Manager] Evaluating task code in new VM context`);
      try {
        // Evaluate the task code in the new context
        const evalResult = context.evalCode(vmState.task_code);
        if (!evalResult.error && evalResult.value) {
          evalResult.value.dispose();
        }
      } catch (codeError) {
        console.error(`[VM State Manager] Error evaluating task code: ${codeError instanceof Error ? codeError.message : String(codeError)}`);
        // Continue with restoration even if code evaluation fails
      }
    }
    
    // Restore global variables if they were saved
    if (vmState.global_vars && Object.keys(vmState.global_vars).length > 0) {
      console.log(`[VM State Manager] Restoring global variables:`, Object.keys(vmState.global_vars));
      
      try {
        // Create JavaScript code to restore each global variable
        let restoreGlobalsCode = '(() => {\n';
        for (const [key, value] of Object.entries(vmState.global_vars)) {
          try {
            // Skip undefined or functions which can't be serialized
            if (value !== undefined) {
              // Safely serialize the value as JSON
              const safeValue = JSON.stringify(value);
              // Add code to restore this global
              restoreGlobalsCode += `  try { globalThis["${key}"] = ${safeValue}; } catch (e) { console.log("Failed to restore global: ${key}"); }\n`;
            }
          } catch (serializeError) {
            console.error(`[VM State Manager] Error serializing global var '${key}':`, serializeError);
          }
        }
        restoreGlobalsCode += '  return "Globals restored";\n})()';
        
        // Evaluate the code to restore globals
        const evalResult = context.evalCode(restoreGlobalsCode);
        if (!evalResult.error && evalResult.value) {
          const result = context.dump(evalResult.value);
          console.log(`[VM State Manager] Global variables restoration result: ${result}`);
          evalResult.value.dispose();
        }
      } catch (restoreError) {
        console.error(`[VM State Manager] Error restoring global variables: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        // Continue with partial restoration if global vars fail
      }
    }
    
    // Restore call context information if available
    if (vmState.call_context && Object.keys(vmState.call_context).length > 0) {
      console.log(`[VM State Manager] Restoring call context:`, Object.keys(vmState.call_context));
      
      try {
        // Inject callContext as a global object
        const callContextCode = `
          globalThis.callContext = ${JSON.stringify(vmState.call_context)};
          // Also restore individual call context variables at global scope
          for (const [key, value] of Object.entries(globalThis.callContext)) {
            try {
              globalThis[key] = value;
            } catch (e) {
              console.log('Failed to restore call context variable:', key);
            }
          }
        `;
        
        const evalResult = context.evalCode(callContextCode);
        if (!evalResult.error && evalResult.value) {
          evalResult.value.dispose();
        }
      } catch (contextError) {
        console.error(`[VM State Manager] Error restoring call context: ${contextError instanceof Error ? contextError.message : String(contextError)}`);
        // Continue even if call context restoration fails
      }
    }
    
    // Check for and restore the resume payload if this was a "pending_resume" stack run
    if (stackRun.status === 'pending_resume' && stackRun.resume_payload) {
      console.log(`[VM State Manager] Restoring resume payload to VM`);
      
      try {
        // Inject the resume payload as __resumePayload global
        const resumePayloadCode = `
          globalThis.__resumePayload = ${JSON.stringify(stackRun.resume_payload)};
          globalThis.resumePayloadReceived = true;
        `;
        
        const evalResult = context.evalCode(resumePayloadCode);
        if (!evalResult.error && evalResult.value) {
          evalResult.value.dispose();
        }
      } catch (payloadError) {
        console.error(`[VM State Manager] Error restoring resume payload: ${payloadError instanceof Error ? payloadError.message : String(payloadError)}`);
      }
    }
    
    console.log(`[VM State Manager] VM context restored for stack run: ${stackRunId}`);
    return { context, stackRun };
  } catch (error) {
    console.error(`[VM State Manager] Error restoring VM state:`, error);
    throw error;
  }
}

/**
 * Updates the stack run status and result
 */
export async function updateStackRun(
  stackRunId: string,
  status: 'processing' | 'completed' | 'failed' | 'suspended_waiting_child' | 'pending_resume',
  result?: unknown,
  error?: unknown
): Promise<void> {
  console.log(`[VM State Manager] Updating stack run ${stackRunId} to status: ${status}`);

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

    const { error: updateError } = await getSupabaseClient().from('stack_runs')
      .update(updateData)
      .eq('id', stackRunId);

    if (updateError) {
      console.error(`[VM State Manager] Error updating stack run: ${updateError.message}`);
      throw updateError;
    }

    console.log(`[VM State Manager] Stack run ${stackRunId} updated to status: ${status}`);
  } catch (error) {
    console.error(`[VM State Manager] Error updating stack run:`, error);
    throw error;
  }
}

/**
 * Marks a stack run as suspended while waiting for a child execution
 */
export async function suspendStackRun(
  stackRunId: string,
  childStackRunId: string,
  vmState: SerializedVMState
): Promise<void> {
  console.log(`[VM State Manager] Suspending stack run ${stackRunId} waiting for child ${childStackRunId}`);

  try {
    // First, find the associated task_run for this stack_run
    const { data: stackRun, error: fetchError } = await getSupabaseClient().from('stack_runs')
      .select('parent_task_run_id')
      .eq('id', stackRunId)
      .single();

    if (fetchError || !stackRun) {
      console.error(`[VM State Manager] Error fetching stack run: ${fetchError?.message || 'Record not found'}`);
      throw new Error(`Failed to fetch stack run: ${fetchError?.message || 'Record not found'}`);
    }

    // Update the stack_run to suspended_waiting_child status
    const { error: updateError } = await getSupabaseClient().from('stack_runs')
      .update({
        status: 'suspended_waiting_child',
        vm_state: vmState,
        updated_at: new Date().toISOString()
      })
      .eq('id', stackRunId);

    if (updateError) {
      console.error(`[VM State Manager] Error suspending stack run: ${updateError.message}`);
      throw updateError;
    }

    // If we have a parent task run ID, update it too
    if (stackRun.parent_task_run_id) {
      console.log(`[VM State Manager] Updating parent task run ${stackRun.parent_task_run_id} to suspended status`);
      
      const { error: taskRunError } = await getSupabaseClient().from('task_runs')
        .update({
          status: 'suspended',
          waiting_on_stack_run_id: childStackRunId,
          updated_at: new Date().toISOString()
        })
        .eq('id', stackRun.parent_task_run_id);
      
      if (taskRunError) {
        console.error(`[VM State Manager] Error updating parent task run: ${taskRunError.message}`);
        // Continue even if task_run update fails
      } else {
        console.log(`[VM State Manager] Parent task run ${stackRun.parent_task_run_id} updated to suspended status`);
      }
    }

    // Update the child stack_run to link back to its parent
    console.log(`[VM State Manager] Linking child stack run ${childStackRunId} to parent ${stackRunId}`);
    
    const { error: childUpdateError } = await getSupabaseClient().from('stack_runs')
      .update({
        parent_stack_run_id: stackRunId,
        updated_at: new Date().toISOString()
      })
      .eq('id', childStackRunId);
    
    if (childUpdateError) {
      console.error(`[VM State Manager] Error updating child stack run: ${childUpdateError.message}`);
      // Continue even if child stack_run update fails
    } else {
      console.log(`[VM State Manager] Child stack run ${childStackRunId} linked to parent ${stackRunId}`);
    }

    console.log(`[VM State Manager] Stack run ${stackRunId} suspended successfully`);
  } catch (error) {
    console.error(`[VM State Manager] Error suspending stack run:`, error);
    throw error;
  }
}

/**
 * Gets pending stack runs
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
      console.error(`Error fetching pending stack runs: ${error.message}`);
      return [];
    }
    
    return data || [];
  } catch (error) {
    console.error(`Error in getPendingStackRuns: ${error instanceof Error ? error.message : String(error)}`);
    return [];
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
  console.log(`[VM State Manager] Preparing stack run ${parentStackRunId} for resumption with child result from ${childStackRunId}`);

  try {
    // First, fetch the parent stack run to verify its state
    const { data: parentStackRun, error: fetchError } = await getSupabaseClient().from('stack_runs')
      .select('*')
      .eq('id', parentStackRunId)
      .single();

    if (fetchError || !parentStackRun) {
      console.error(`[VM State Manager] Error fetching parent stack run: ${fetchError?.message || 'Record not found'}`);
      return false;
    }

    // Verify the parent is actually in suspended state
    if (parentStackRun.status !== 'suspended_waiting_child') {
      console.error(`[VM State Manager] Parent stack run ${parentStackRunId} is not in suspended_waiting_child state, found: ${parentStackRun.status}`);
      return false;
    }

    // Attach the child result as resume_payload
    const { error: updateError } = await getSupabaseClient().from('stack_runs')
      .update({
        status: 'pending_resume',
        resume_payload: childResult,
        updated_at: new Date().toISOString()
      })
      .eq('id', parentStackRunId);

    if (updateError) {
      console.error(`[VM State Manager] Error updating parent stack run for resumption: ${updateError.message}`);
      return false;
    }

    console.log(`[VM State Manager] Stack run ${parentStackRunId} prepared for resumption`);

    // If we have a parent task run, update its status too
    if (parentStackRun.parent_task_run_id) {
      console.log(`[VM State Manager] Updating parent task run ${parentStackRun.parent_task_run_id} status to 'processing'`);
      
      const { error: taskRunError } = await getSupabaseClient().from('task_runs')
        .update({
          status: 'processing',
          waiting_on_stack_run_id: null, // Clear the waiting flag
          updated_at: new Date().toISOString()
        })
        .eq('id', parentStackRun.parent_task_run_id);
      
      if (taskRunError) {
        console.error(`[VM State Manager] Error updating parent task run: ${taskRunError.message}`);
        // Continue even if task_run update fails
      }
    }

    return true;
  } catch (error) {
    console.error(`[VM State Manager] Error preparing stack run for resumption:`, error);
    return false;
  }
}

/**
 * Aggregates the results of all stack runs into the parent task run
 */
export async function aggregateTaskResults(taskRunId: string): Promise<boolean> {
  console.log(`[VM State Manager] Aggregating results for task run: ${taskRunId}`);
  
  try {
    const supabase = getSupabaseClient();
    
    // Get all stack runs for this task
    const { data: stackRuns, error: fetchError } = await supabase
      .from('stack_runs')
      .select('*')
      .eq('parent_task_run_id', taskRunId);
    
    if (fetchError) {
      console.error(`Error fetching stack runs for task ${taskRunId}: ${fetchError.message}`);
      return false;
    }
    
    // Build a tree of stack runs
    const stackRunTree = buildStackRunTree(stackRuns);
    
    // Aggregate results recursively
    const aggregatedResult = aggregateStackRunResults(stackRunTree);
    
    // Update the task run with aggregated results
    const { error: updateError } = await supabase.from('task_runs')
      .update({
        aggregated_results: aggregatedResult,
        updated_at: new Date().toISOString()
      })
      .eq('id', taskRunId);
    
    if (updateError) {
      console.error(`[VM State Manager] Error updating task run with aggregated results: ${updateError.message}`);
      return false;
    }
    
    console.log(`[VM State Manager] Successfully aggregated results for task run ${taskRunId}`);
    return true;
  } catch (error) {
    console.error(`[VM State Manager] Exception during task result aggregation:`, error);
    return false;
  }
}

/**
 * Helper function to build a tree of stack runs
 */
function buildStackRunTree(stackRuns: StackRun[]): Record<string, any> {
  const tree: Record<string, any> = {};
  const runMap = new Map<string, StackRun>();
  
  // Map all runs by ID
  stackRuns.forEach(run => {
    runMap.set(run.id, run);
  });
  
  // Build the tree
  stackRuns.forEach(run => {
    const node = {
      id: run.id,
      module_name: run.module_name,
      method_name: run.method_name,
      args: run.args,
      status: run.status,
      result: run.result,
      error: run.error,
      children: []
    };
    
    tree[run.id] = node;
  });
  
  // Link children to parents
  stackRuns.forEach(run => {
    if (run.parent_stack_run_id && tree[run.parent_stack_run_id]) {
      tree[run.parent_stack_run_id].children.push(tree[run.id]);
    }
  });
  
  return tree;
}

/**
 * Helper function to recursively aggregate stack run results
 */
function aggregateStackRunResults(tree: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  
  Object.values(tree).forEach(node => {
    if (!node.parent_stack_run_id) {
      // Root node
      result[node.id] = {
        module_name: node.module_name,
        method_name: node.method_name,
        status: node.status,
        result: node.result,
        error: node.error,
        children: node.children.map((child: any) => aggregateStackRunResults({ [child.id]: child })[child.id])
      };
    }
  });
  
  return result;
}
