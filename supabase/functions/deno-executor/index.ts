/**
 * Native Deno Executor for Tasker
 * 
 * Uses native Deno execution for optimal performance and reliability.
 * Provides the same suspend/resume mechanism using HTTP-based stack processing.
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

// Simple types
interface SerializedVMState {
  [key: string]: any;
}

// Environment variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Create Supabase client
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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
 * Execute a task using native Deno - SIMPLIFIED VERSION
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
  const logPrefix = `DenoExecutor-${taskName}`;

  try {
    const startTime = Date.now();
    hostLog(logPrefix, "info", `Executing task: ${taskName}`);

    // Monitor memory usage if available
    if (typeof Deno !== 'undefined' && Deno.memoryUsage) {
      const memUsage = Deno.memoryUsage();
      hostLog(logPrefix, "info", `Memory usage: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap`);
    }

    // Create __callHostTool__ function with resume support
    const __callHostTool__ = (serviceName: string, methodPath: string[], args: any[]) => {
      // If we have a resume payload, return it instead of making a new external call
      if (initialVmState && initialVmState.resume_payload !== undefined && initialVmState.resume_payload !== null) {
        hostLog(logPrefix, "info", `Returning resume payload instead of making external call to ${serviceName}.${methodPath.join('.')}`);
        hostLog(logPrefix, "info", `Resume payload: ${JSON.stringify(initialVmState.resume_payload)}`);
        const result = initialVmState.resume_payload;
        // Clear the resume payload so subsequent calls work normally
        initialVmState.resume_payload = undefined;
        return result;
      }

      return makeExternalCall(serviceName, methodPath, args, taskRunId, stackRunId);
    };

    // Create simple console
    const console = {
      log: (...args: any[]) => hostLog(logPrefix, "info", args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ')),
      error: (...args: any[]) => hostLog(logPrefix, "error", args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ')),
      warn: (...args: any[]) => hostLog(logPrefix, "warn", args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' '))
    };

    // Execute the task code in a simple way
    const module = { exports: {} };
    const exports = module.exports;

    // Use eval to execute the task code with the context
    const taskFunction = eval(`
      (function(module, exports, __callHostTool__, console) {
        ${taskCode}
        return module.exports;
      })
    `);

    const handler = taskFunction(module, exports, __callHostTool__, console);

    if (typeof handler !== 'function') {
      throw new Error(`Task code must export a function, got: ${typeof handler}`);
    }

    hostLog(logPrefix, "info", `Executing task handler with input: ${JSON.stringify(taskInput)}`);

    // Execute the task handler
    const result = await handler(taskInput);

    const executionTime = Date.now() - startTime;
    hostLog(logPrefix, "info", `Task completed in ${executionTime}ms: ${JSON.stringify(result).substring(0, 200)}...`);

    // Monitor memory usage after execution
    if (typeof Deno !== 'undefined' && Deno.memoryUsage) {
      const memUsage = Deno.memoryUsage();
      hostLog(logPrefix, "info", `Final memory usage: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap`);
    }

    return result;

  } catch (error) {
    // Check if this is a suspension error
    if (error instanceof Error && error.message === 'TASK_SUSPENDED' && (error as any).suspensionData) {
      const suspensionData = (error as any).suspensionData;
      hostLog(logPrefix, "info", `Task suspended for external call: ${suspensionData.serviceName}.${suspensionData.methodPath.join('.')}`);

      // Return the suspension data directly
      return suspensionData;
    }

    hostLog(logPrefix, "error", `Task execution failed: ${error instanceof Error ? error.message : String(error)}`);
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
 * Handle resume requests - resume a suspended task with external call result
 */
async function handleResumeRequest(req: Request): Promise<Response> {
  const logPrefix = "DenoExecutor-HandleResume";

  try {
    const requestData = await req.json();
    const { stackRunIdToResume, resultToInject } = requestData;

    hostLog(logPrefix, "info", `Resume request for stack run ${stackRunIdToResume} with result: ${JSON.stringify(resultToInject).substring(0, 100)}...`);

    // Get the stack run to resume
    const { data: stackRun, error } = await supabase
      .from('stack_runs')
      .select('*')
      .eq('id', stackRunIdToResume)
      .single();

    if (error || !stackRun) {
      return new Response(JSON.stringify({
        error: `Stack run ${stackRunIdToResume} not found`
      }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Extract task information from VM state
    const vmState = stackRun.vm_state;
    if (!vmState || !vmState.taskCode) {
      return new Response(JSON.stringify({
        error: `Stack run ${stackRunIdToResume} has no VM state or task code`
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Execute the task with the injected result as the resume payload
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

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    hostLog(logPrefix, "error", `Error in handleResumeRequest: ${errorMsg}`);

    return new Response(JSON.stringify({
      error: errorMsg
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
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
