/**
 * VM State Manager for QuickJS
 * Handles state capture, serialization, storage and restoration for VM suspend/resume
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
  stackRunId: string;
  taskRunId?: string;
  suspended: boolean;
  suspendedAt: string;
  resumeFunction?: string;
  vmSnapshot?: string;
  parentStackRunId?: string;
  waitingOnStackRunId?: string;
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
 * Get configuration for Supabase
 */
function getSupabaseConfig(): { url: string; serviceRoleKey: string } {
  const url = Deno.env.get("SUPABASE_URL") || 
    Deno.env.get("EXT_SUPABASE_URL") || 
    "http://127.0.0.1:8000";
  
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || 
    Deno.env.get("EXT_SUPABASE_SERVICE_ROLE_KEY") || 
    "";
  
  return { url, serviceRoleKey };
}

/**
 * Generate a UUID (v4)
 */
export function _generateUUID(): string {
  // Implementation from https://stackoverflow.com/a/2117523
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
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
  serviceName: string,
  methodName: string,
  args: any[],
  vmState: SerializedVMState,
  parentTaskRunId?: string,
  parentStackRunId?: string
): Promise<string> {
  const { url, serviceRoleKey } = getSupabaseConfig();
  
  if (!serviceRoleKey) {
    hostLog("VM-State-Manager", "error", "Missing service role key");
    throw new Error("Missing service role key");
  }
  
  try {
    const stackRunId = vmState.stackRunId || _generateUUID();
    
    // Prepare the record
    const record = {
      id: stackRunId,
      parent_task_run_id: parentTaskRunId,
      parent_stack_run_id: parentStackRunId,
      service_name: serviceName,
        method_name: methodName,
      args,
      status: "pending",
      vm_state: vmState,
      waiting_on_stack_run_id: vmState.waitingOnStackRunId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
    
    // Insert the record
    const response = await fetch(`${url}/rest/v1/stack_runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`,
        "apikey": serviceRoleKey,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(record)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      hostLog("VM-State-Manager", "error", `Error saving stack run: ${response.status} ${response.statusText} - ${errorText}`);
      throw new Error(`Error saving stack run: ${response.status} ${response.statusText}`);
    }
    
    hostLog("VM-State-Manager", "info", `Saved stack run: ${stackRunId}`);
    
    return stackRunId;
  } catch (error) {
    hostLog("VM-State-Manager", "error", `Error saving stack run: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Triggers the stack processor to process the next stack run
 */
export async function triggerStackProcessor(): Promise<void> {
  const { url, serviceRoleKey } = getSupabaseConfig();
  
  if (!serviceRoleKey) {
    hostLog("VM-State-Manager", "error", "Missing service role key");
    return;
  }
  
  try {
    const response = await fetch(`${url}/functions/v1/stack-processor`, {
      method: "POST",
          headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`
          },
      body: JSON.stringify({
        trigger: "quickjs"
      })
        });

        if (!response.ok) {
      const errorText = await response.text();
      hostLog("VM-State-Manager", "error", `Error triggering stack processor: ${response.status} ${response.statusText} - ${errorText}`);
    }
  } catch (error) {
    hostLog("VM-State-Manager", "error", `Error triggering stack processor: ${error instanceof Error ? error.message : String(error)}`);
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
  ctx: any, 
  taskRunId: string | undefined, 
  waitingOnStackRunId: string | undefined
): SerializedVMState {
  const stackRunId = _generateUUID();
  
  return {
    stackRunId,
    taskRunId,
    suspended: true,
    suspendedAt: new Date().toISOString(),
    waitingOnStackRunId
  };
}

/**
 * Restores the VM state from the database
 */
export async function restoreVMState(stackRunId: string): Promise<{ context: any; stackRun: any }> {
  const { url, serviceRoleKey } = getSupabaseConfig();
  
  if (!serviceRoleKey) {
    hostLog("VM-State-Manager", "error", "Missing service role key");
    throw new Error("Missing service role key");
  }
  
  try {
    // Fetch the stack run
    const response = await fetch(`${url}/rest/v1/stack_runs?id=eq.${stackRunId}&select=*`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`,
        "apikey": serviceRoleKey
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      hostLog("VM-State-Manager", "error", `Error fetching stack run: ${response.status} ${response.statusText} - ${errorText}`);
      throw new Error(`Error fetching stack run: ${response.status} ${response.statusText}`);
    }
    
    const stackRuns = await response.json();
    
    if (!stackRuns || !Array.isArray(stackRuns) || stackRuns.length === 0) {
      throw new Error(`Stack run not found: ${stackRunId}`);
    }
    
    const stackRun = stackRuns[0];
    
    // Update status to processing
    const updateResponse = await fetch(`${url}/rest/v1/stack_runs?id=eq.${stackRunId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`,
        "apikey": serviceRoleKey,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify({
        status: "processing",
        updated_at: new Date().toISOString()
      })
    });
    
    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      hostLog("VM-State-Manager", "error", `Error updating stack run status: ${updateResponse.status} ${updateResponse.statusText} - ${errorText}`);
      throw new Error(`Error updating stack run status: ${updateResponse.status} ${updateResponse.statusText}`);
    }
    
    // Create a new QuickJS context
    // Using dynamic import to avoid hard dependencies
    const context = await createQuickJSContext();
    
    return { context, stackRun };
  } catch (error) {
    hostLog("VM-State-Manager", "error", `Error restoring VM state: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
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
