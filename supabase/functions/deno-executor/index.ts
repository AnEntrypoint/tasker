/**
 * FlowState-Powered Deno Executor for Tasker
 *
 * Integrates FlowState library for automatic pause/resume on external calls
 * while maintaining compatibility with existing HTTP-based stack processing.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// Import shared utilities
import {
  hostLog,
  simpleStringify,
  LogEntry
} from "../_shared/utils.ts";

// Import only what we need from shared utilities
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

// Import FlowState from CommonJS library
import {
  FlowStateEdge,
  type FlowStateRequest,
  type FlowStateResumeRequest,
  type FlowStateResult
} from '../../../flowstate/lib/edge-functions.cjs';

// Import custom storage adapter
import { supabaseFlowStateStorage } from './flowstate-storage.ts';

// Simple types
interface SerializedVMState {
  [key: string]: any;
}

// Environment variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Create Supabase client
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Set FlowState default storage
FlowStateEdge.setDefaultStorage(supabaseFlowStateStorage);

// Simple UUID generator
function generateUUID(): string {
  return crypto.randomUUID();
}





// ==============================
// Configuration
// ==============================

// Define CORS headers for HTTP responses
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ==============================
// External Call System
// ==============================

/**
 * Make an external service call - PROPER IMPLEMENTATION
 * Creates a child stack run and returns suspension data
 */
async function makeExternalCall(
  serviceName: string,
  methodPath: string[],
  args: any[],
  taskRunId: string,
  stackRunId: string
): Promise<any> {
  const logPrefix = `DenoExecutor-${taskRunId}`;

  hostLog(logPrefix, "info", `External call requested: ${serviceName}.${methodPath.join('.')} - creating child stack run`);

  // Map service names to actual function names
  const serviceMap: Record<string, string> = {
    'database': 'wrappedsupabase',
    'keystore': 'wrappedkeystore',
    'openai': 'wrappedopenai',
    'websearch': 'wrappedwebsearch',
    'gapi': 'wrappedgapi'
  };

  const actualServiceName = serviceMap[serviceName] || serviceName;

  // Save the stack run for this external call using Supabase client directly
  const { data, error } = await supabase
    .from('stack_runs')
    .insert({
      parent_task_run_id: parseInt(taskRunId),
      parent_stack_run_id: parseInt(stackRunId),
      service_name: actualServiceName,
      method_name: methodPath.join('.'),
      args: args,
      status: 'pending',
      vm_state: null,
      waiting_on_stack_run_id: null,
      resume_payload: null
    })
    .select('id')
    .single();

  if (error) {
    throw new Error(`Failed to save stack run: ${error.message}`);
  }

  const actualChildStackRunId = data.id;

  hostLog(logPrefix, "info", `Created child stack run ${actualChildStackRunId} for ${serviceName}.${methodPath.join('.')}`);

  // Update the current stack run to suspended_waiting_child status
  const { error: updateError } = await supabase
    .from('stack_runs')
    .update({
      status: 'suspended_waiting_child',
      waiting_on_stack_run_id: actualChildStackRunId,
      updated_at: new Date().toISOString()
    })
    .eq('id', parseInt(stackRunId));

  if (updateError) {
    throw new Error(`Failed to update stack run status: ${updateError.message}`);
  }

  hostLog(logPrefix, "info", `Updated stack run ${stackRunId} to suspended_waiting_child, waiting on ${actualChildStackRunId}`);

  // Create a suspension object that tells the stack processor to wait for this child
  const suspensionData = {
    __hostCallSuspended: true,
    serviceName,
    methodPath,
    args,
    taskRunId,
    stackRunId: actualChildStackRunId  // Return the child stack run ID
  };

  // Throw a special error that contains the suspension data
  // This will stop task execution immediately and be caught by the executor
  const suspensionError = new Error(`TASK_SUSPENDED`);
  (suspensionError as any).suspensionData = suspensionData;
  throw suspensionError;
}

// ==============================
// Task Execution
// ==============================

/**
 * Execute a task using FlowState with enhanced pause/resume capabilities
 */
async function executeTask(
  taskCode: string,
  taskName: string,
  taskInput: any,
  taskRunId: string,
  stackRunId: string,
  toolNames?: string[],
  initialVmState?: SerializedVMState
): Promise<any> {
  const logPrefix = `FlowStateExecutor-${taskName}`;

  try {
    const startTime = Date.now();
    hostLog(logPrefix, "info", `Executing FlowState task: ${taskName}`);

    // Monitor memory usage if available
    if (typeof Deno !== 'undefined' && Deno.memoryUsage) {
      const memUsage = Deno.memoryUsage();
      hostLog(logPrefix, "info", `Memory usage: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap`);
    }

    // Prepare task code with __callHostTool__ integration
    const enhancedTaskCode = `
      ${taskCode}

      // Global __callHostTool__ function for external service calls
      globalThis.__callHostTool__ = function(serviceName, methodPath, args) {
        // Convert methodPath array to dot notation for consistency
        const methodString = Array.isArray(methodPath) ? methodPath.join('.') : methodPath;

        // Create a unique fetch URL for this external call
        const fetchUrl = 'https://tasker-external-call/' + serviceName + '/' + methodString;

        // Store call context for later use
        const callContext = {
          serviceName: serviceName,
          methodPath: Array.isArray(methodPath) ? methodPath : [methodPath],
          args: args,
          taskRunId: '${taskRunId}',
          stackRunId: '${stackRunId}'
        };

        // Store context globally for the fetch interceptor
        globalThis._currentCallContext = callContext;

        // Make the external call via fetch (will be intercepted by FlowState)
        return fetch(fetchUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Tasker-Call-Context': JSON.stringify(callContext)
          },
          body: JSON.stringify({
            serviceName: serviceName,
            methodPath: callContext.methodPath,
            args: args
          })
        });
      };

      // Enhanced console for logging
      globalThis.console = {
        log: (...args) => {
          const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
          // Log via host (this will be captured by the edge function)
          if (globalThis._hostLog) {
            globalThis._hostLog('info', message);
          }
        },
        error: (...args) => {
          const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
          if (globalThis._hostLog) {
            globalThis._hostLog('error', message);
          }
        },
        warn: (...args) => {
          const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
          if (globalThis._hostLog) {
            globalThis._hostLog('warn', message);
          }
        }
      };

      // Export the main function
      module.exports = ${taskCode.match(/module\.exports\s*=\s*([^;]+)/)?.[1] || taskCode.match(/export\s+(?:default\s+)?function\s+(\w+)/)?.[1] || 'handler'};
    `;

    // Create FlowState request
    const flowStateRequest: FlowStateRequest = {
      id: stackRunId, // Use stack run ID as FlowState task ID
      code: enhancedTaskCode,
      name: taskName
    };

    // Execute with FlowState
    const result = await FlowStateEdge.execute(flowStateRequest, {
      saveToStorage: true,
      ttl: 2 * 60 * 60 * 1000 // 2 hours
    });

    hostLog(logPrefix, "info", `FlowState execution result: ${result.status}`);

    // Handle different FlowState states
    if (result.status === 'paused') {
      // FlowState paused on an external call - create suspension data for stack processor
      hostLog(logPrefix, "info", `FlowState paused on external call: ${result.fetchRequest?.url}`);

      // Extract call context from the fetch request
      const callContext = result.fetchRequest?.headers?.['X-Tasker-Call-Context'];
      let serviceName = 'unknown';
      let methodPath = [];
      let args = [];

      try {
        if (callContext) {
          const parsed = JSON.parse(callContext);
          serviceName = parsed.serviceName;
          methodPath = parsed.methodPath;
          args = parsed.args;
        }
      } catch (e) {
        hostLog(logPrefix, "warn", `Failed to parse call context: ${e}`);
      }

      // Create child stack run for external call
      const suspensionData = await makeExternalCall(serviceName, methodPath, args, taskRunId, stackRunId);

      // Return suspension data to stack processor
      return suspensionData;

    } else if (result.status === 'completed') {
      // Task completed successfully
      const executionTime = Date.now() - startTime;
      hostLog(logPrefix, "info", `FlowState task completed in ${executionTime}ms: ${JSON.stringify(result.result).substring(0, 200)}...`);

      // Monitor memory usage after execution
      if (typeof Deno !== 'undefined' && Deno.memoryUsage) {
        const memUsage = Deno.memoryUsage();
        hostLog(logPrefix, "info", `Final memory usage: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap`);
      }

      return result.result;

    } else if (result.status === 'error') {
      // Task failed
      hostLog(logPrefix, "error", `FlowState task failed: ${result.error}`);
      throw new Error(result.error || 'FlowState execution failed');
    }

    return result;

  } catch (error) {
    hostLog(logPrefix, "error", `FlowState execution failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// ==============================
// HTTP Handlers
// ==============================

/**
 * Handle execute requests
 */
async function handleExecuteRequest(req: Request): Promise<Response> {
  const logPrefix = "DenoExecutor-HandleExecute";
  
  try {
    // Handle GET requests for health checks
    if (req.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'healthy',
        service: 'Deno Task Executor',
        version: '1.0.0'
      }), { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }
    
    const requestData = await req.json();
    const { taskCode, taskName, taskInput, taskRunId, stackRunId, toolNames, initialVmState } = requestData;
    
    hostLog(logPrefix, "info", `Received request data: ${JSON.stringify({ taskName, taskRunId, stackRunId })}`);
    
    if (!taskCode || !taskName) {
      return new Response(JSON.stringify({
        error: "Missing taskCode or taskName"
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    
    const result = await executeTask(taskCode, taskName, taskInput, taskRunId, stackRunId, toolNames, initialVmState);
    
    return new Response(JSON.stringify({
      status: 'completed',
      result: result
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    hostLog(logPrefix, "error", `Error in handleExecuteRequest: ${errorMsg}`);
    
    return new Response(JSON.stringify({
      error: errorMsg
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}

/**
 * Handle resume requests - resume a suspended FlowState task with external call result
 */
async function handleResumeRequest(req: Request): Promise<Response> {
  const logPrefix = "FlowStateExecutor-HandleResume";

  try {
    const requestData = await req.json();
    const { stackRunIdToResume, resultToInject } = requestData;

    hostLog(logPrefix, "info", `FlowState resume request for stack run ${stackRunIdToResume} with result: ${JSON.stringify(resultToInject).substring(0, 100)}...`);

    // Load the FlowState task from storage
    const flowStateTask = await FlowStateEdge.loadTask(stackRunIdToResume);

    if (!flowStateTask) {
      // Fallback to old resume mechanism for compatibility
      hostLog(logPrefix, "warn", `FlowState task not found, falling back to legacy resume mechanism`);
      return await handleLegacyResume(requestData);
    }

    // Create a mock fetch response for FlowState resume
    const mockFetchResponse = {
      id: `resume_${Date.now()}`,
      success: true,
      status: 200,
      statusText: 'OK',
      data: resultToInject,
      timestamp: Date.now()
    };

    // Resume the FlowState task
    const resumeRequest: FlowStateResumeRequest = {
      taskId: stackRunIdToResume,
      vmState: flowStateTask.vmState,
      originalCode: flowStateTask.code,
      fetchResponse: mockFetchResponse
    };

    const result = await FlowStateEdge.resume(resumeRequest, {
      saveToStorage: true,
      ttl: 2 * 60 * 60 * 1000 // 2 hours
    });

    hostLog(logPrefix, "info", `FlowState resume result: ${result.status}`);

    // Handle different FlowState states after resume
    if (result.status === 'paused') {
      // Task paused again on another external call
      hostLog(logPrefix, "info", `FlowState task paused again on external call: ${result.fetchRequest?.url}`);

      // Extract call context and create suspension data
      const callContext = result.fetchRequest?.headers?.['X-Tasker-Call-Context'];
      let serviceName = 'unknown';
      let methodPath = [];
      let args = [];

      try {
        if (callContext) {
          const parsed = JSON.parse(callContext);
          serviceName = parsed.serviceName;
          methodPath = parsed.methodPath;
          args = parsed.args;
        }
      } catch (e) {
        hostLog(logPrefix, "warn", `Failed to parse call context: ${e}`);
      }

      // Get task run ID from the stack run
      const { data: stackRun } = await supabase
        .from('stack_runs')
        .select('parent_task_run_id')
        .eq('id', stackRunIdToResume)
        .single();

      // Create child stack run for the new external call
      const suspensionData = await makeExternalCall(
        serviceName,
        methodPath,
        args,
        stackRun?.parent_task_run_id?.toString() || '1',
        stackRunIdToResume
      );

      return new Response(JSON.stringify({
        status: 'paused',
        suspensionData: suspensionData
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    } else if (result.status === 'completed') {
      // Task completed successfully
      hostLog(logPrefix, "info", `FlowState task resumed and completed successfully`);

      return new Response(JSON.stringify({
        status: 'completed',
        result: result.result
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    } else if (result.status === 'error') {
      // Task failed during resume
      hostLog(logPrefix, "error", `FlowState task failed during resume: ${result.error}`);

      return new Response(JSON.stringify({
        status: 'error',
        error: result.error
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({
      status: 'unknown',
      result: result
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    hostLog(logPrefix, "error", `Error in FlowState handleResumeRequest: ${errorMsg}`);

    // Try fallback to legacy resume mechanism
    try {
      hostLog(logPrefix, "info", `Attempting fallback to legacy resume mechanism`);
      return await handleLegacyResume(requestData);
    } catch (fallbackError) {
      hostLog(logPrefix, "error", `Fallback resume also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);

      return new Response(JSON.stringify({
        error: errorMsg
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
}

/**
 * Legacy resume mechanism for compatibility with existing stack runs
 */
async function handleLegacyResume(requestData: any): Promise<Response> {
  const logPrefix = "FlowStateExecutor-LegacyResume";

  const { stackRunIdToResume, resultToInject } = requestData;

  hostLog(logPrefix, "info", `Legacy resume for stack run ${stackRunIdToResume}`);

  // Get the stack run to resume
  const { data: stackRun, error } = await supabase
    .from('stack_runs')
    .select('*')
    .eq('id', stackRunIdToResume)
    .single();

  if (error || !stackRun) {
    throw new Error(`Stack run ${stackRunIdToResume} not found`);
  }

  // Extract task information from VM state
  const vmState = stackRun.vm_state;
  if (!vmState || !vmState.taskCode) {
    throw new Error(`Stack run ${stackRunIdToResume} has no VM state or task code`);
  }

  // Execute the task with the injected result using the old method
  const result = await executeTask(
    vmState.taskCode,
    vmState.taskName,
    vmState.taskInput,
    stackRun.parent_task_run_id.toString(),
    stackRunIdToResume.toString(),
    vmState.toolNames,
    {
      ...vmState,
      resume_payload: resultToInject
    }
  );

  return new Response(JSON.stringify({
    status: 'completed',
    result: result
  }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

// ==============================
// Main Server
// ==============================

serve(async (req: Request) => {
  try {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    
    const url = new URL(req.url);
    const path = url.pathname.split('/').pop();
    
    if (path === 'resume') {
      return handleResumeRequest(req);
    } else {
      return handleExecuteRequest(req);
    }
  } catch (error) {
    hostLog("DenoExecutorHandler", "error", `Error in serve function: ${error instanceof Error ? error.message : String(error)}`);
    
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
});

console.log("🚀 Deno Task Executor started successfully");
