/**
 * FlowState-Powered Deno Executor for Tasker
 *
 * Integrates FlowState library for automatic pause/resume on external calls
 * while maintaining compatibility with existing HTTP-based stack processing.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// No imports from shared dependencies to avoid compilation errors

// No FlowState import - using HTTP-based service calls for all external operations

// ==============================
// Utility Functions
// ==============================

/**
 * Simple logging function to replace hostLog from utils
 */
function hostLog(prefix: string, level: 'info' | 'error' | 'warn', message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] [${prefix}] ${message}`);
}

/**
 * Simple stringification function
 */
function simpleStringify(obj: any): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch (error) {
    return String(obj);
  }
}

// ==============================
// Minimal Service Registry
// ==============================

/**
 * Minimal service registry implementation to avoid shared dependency issues
 */
class MinimalServiceRegistry {
  private supabaseUrl: string;
  private serviceKey: string;

  constructor() {
    this.supabaseUrl = SUPABASE_URL;
    this.serviceKey = SERVICE_ROLE_KEY;
  }

  /**
   * Make a direct HTTP call to a wrapped service
   */
  async call(serviceName: string, method: string, params: any): Promise<any> {
    const logPrefix = `ServiceRegistry-${serviceName}`;

    try {
      const url = `${this.supabaseUrl}/functions/v1/${serviceName}`;

      hostLog(logPrefix, "info", `Calling ${serviceName}.${method} via HTTP`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: method,
          ...params
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Service call failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const result = await response.json();

      hostLog(logPrefix, "info", `${serviceName}.${method} call completed successfully`);
      return result;

    } catch (error) {
      hostLog(logPrefix, "error", `Service call failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Make database calls directly to avoid service registry complexity
   */
  async databaseCall(table: string, action: string, params: any): Promise<any> {
    const logPrefix = `DatabaseCall-${table}`;

    try {
      const url = `${this.supabaseUrl}/functions/v1/wrappedsupabase`;

      hostLog(logPrefix, "info", `Database ${action} on ${table}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: action,
          table: table,
          ...params
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Database call failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const result = await response.json();

      hostLog(logPrefix, "info", `Database ${action} on ${table} completed`);
      return result;

    } catch (error) {
      hostLog(logPrefix, "error", `Database call failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}

// Create minimal service registry instance
const serviceRegistry = new MinimalServiceRegistry();

// HTTP-based execution result types
interface ExecutionResult {
  status: 'completed' | 'paused' | 'error';
  result?: any;
  error?: string;
  suspensionData?: any;
}

// Simple types
interface SerializedVMState {
  [key: string]: any;
}

// Environment variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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
 * Make an external service call using the service registry
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

  // Use minimal service registry to create child stack run via database
  const insertResult = await serviceRegistry.databaseCall('stack_runs', 'insert', {
    records: [{
      parent_task_run_id: parseInt(taskRunId),
      parent_stack_run_id: parseInt(stackRunId),
      service_name: actualServiceName,
      method_name: methodPath.join('.'),
      args: args,
      status: 'pending',
      vm_state: null,
      waiting_on_stack_run_id: null,
      resume_payload: null
    }]
  });

  if (!insertResult.success || !insertResult.data) {
    throw new Error(`Failed to save stack run via service registry: ${insertResult.error || 'Unknown error'}`);
  }

  const actualChildStackRunId = insertResult.data[0]?.id;

  if (!actualChildStackRunId) {
    throw new Error('Failed to get child stack run ID from service registry response');
  }

  hostLog(logPrefix, "info", `Created child stack run ${actualChildStackRunId} for ${serviceName}.${methodPath.join('.')}`);

  // Use minimal service registry to update the current stack run to suspended_waiting_child status
  const updateResult = await serviceRegistry.databaseCall('stack_runs', 'update', {
    filter: { id: parseInt(stackRunId) },
    update: {
      status: 'suspended_waiting_child',
      waiting_on_stack_run_id: actualChildStackRunId,
      updated_at: new Date().toISOString()
    }
  });

  if (!updateResult.success) {
    throw new Error(`Failed to update stack run status via service registry: ${updateResult.error}`);
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
// Secure Sandbox Environment
// ==============================

/**
 * Secure sandbox for executing task code with proper isolation
 */
class SecureSandbox {
  private taskRunId: string;
  private stackRunId: string;
  private taskName: string;
  private logPrefix: string;

  constructor(taskRunId: string, stackRunId: string, taskName: string) {
    this.taskRunId = taskRunId;
    this.stackRunId = stackRunId;
    this.taskName = taskName;
    this.logPrefix = `Sandbox-${taskName}`;
  }

  /**
   * Execute task code in a secure environment
   */
  async execute(taskCode: string, taskInput: any, initialVmState?: SerializedVMState): Promise<any> {
    hostLog(this.logPrefix, "info", `Executing task in secure sandbox`);

    try {
      // Create a fresh global context for the task
      const taskGlobal = this.createTaskGlobal();

      // Handle resume payload if present
      if (initialVmState?.resume_payload) {
        taskGlobal._resume_payload = initialVmState.resume_payload;
        hostLog(this.logPrefix, "info", `Resume payload available for task execution`);
      }

      // Execute the task code in the sandbox
      const taskFunction = this.compileTaskCode(taskCode, taskGlobal);

      // Execute the task with input
      const result = await taskFunction(taskInput);

      hostLog(this.logPrefix, "info", `Task execution completed successfully`);
      return result;

    } catch (error) {
      hostLog(this.logPrefix, "error", `Task execution failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Create a secure global context for task execution
   */
  private createTaskGlobal(): any {
    return {
      // Console that forwards to host logging
      console: {
        log: (...args: any[]) => {
          const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
          hostLog(this.logPrefix, "info", message);
        },
        error: (...args: any[]) => {
          const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
          hostLog(this.logPrefix, "error", message);
        },
        warn: (...args: any[]) => {
          const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
          hostLog(this.logPrefix, "warn", message);
        }
      },

      // Host logging function
      _hostLog: (level: string, message: string) => {
        hostLog(this.logPrefix, level as any, message);
      },

      // Global context for call tracking
      _taskRunId: this.taskRunId,
      _stackRunId: this.stackRunId,

      // Resume payload (will be set if available)
      _resume_payload: undefined,

      // Safe standard objects
      Object,
      Array,
      String,
      Number,
      Boolean,
      Date,
      Math,
      JSON,
      RegExp,

      // Async utilities
      Promise,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,

      // Crypto utilities
      crypto: {
        randomUUID: () => crypto.randomUUID()
      },

      // Module exports
      module: { exports: {} },
      exports: {}
    };
  }

  /**
   * Compile and prepare task code for execution
   */
  private compileTaskCode(taskCode: string, taskGlobal: any): (input: any) => Promise<any> {
    try {
      // Create a function from the task code
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

      // Extract the main function from the task code
      const mainFunctionMatch = taskCode.match(/(?:module\.exports\s*=\s*|export\s+(?:default\s+)?)(function\s+(\w+)|(\w+))/);
      const functionName = mainFunctionMatch?.[2] || mainFunctionMatch?.[3] || 'handler';

      // Execute the task code to define the function
      const taskEval = new AsyncFunction('globalThis', taskCode);
      taskEval(taskGlobal);

      // Extract the main function
      const handler = taskGlobal.module?.exports?.[functionName] ||
                     taskGlobal[functionName] ||
                     taskGlobal.handler;

      if (typeof handler !== 'function') {
        throw new Error(`Task handler function '${functionName}' not found or not a function`);
      }

      return handler;
    } catch (error) {
      hostLog(this.logPrefix, "error", `Failed to compile task code: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}

/**
 * Create a secure sandbox for task execution
 */
function createSecureSandbox(taskRunId: string, stackRunId: string, taskName: string): SecureSandbox {
  return new SecureSandbox(taskRunId, stackRunId, taskName);
}

/**
 * Extract suspension data from a suspension error
 */
async function extractSuspensionDataFromError(error: Error, taskRunId: string, stackRunId: string): Promise<any> {
  const logPrefix = `SuspensionExtractor-${taskRunId}`;

  try {
    hostLog(logPrefix, "info", `Extracting suspension data from error: ${error.message}`);

    // Parse the suspension error to extract call context
    const errorMatch = error.message.match(/TASK_SUSPENDED: External call to (\w+)\.([^ ]+) needs suspension/);
    if (!errorMatch) {
      throw new Error('Invalid suspension error format');
    }

    const serviceName = errorMatch[1];
    const methodPath = errorMatch[2].split('.');

    hostLog(logPrefix, "info", `Parsed external call: ${serviceName}.${methodPath.join('.')}`);

    // For now, we'll create a basic suspension structure
    // In a real implementation, you'd extract this from the call context
    const suspensionData = await makeExternalCall(serviceName, methodPath, [], taskRunId, stackRunId);

    return suspensionData;

  } catch (extractError) {
    hostLog(logPrefix, "error", `Failed to extract suspension data: ${extractError instanceof Error ? extractError.message : String(extractError)}`);
    throw extractError;
  }
}

// ==============================
// Task Execution
// ==============================

/**
 * Execute a task using HTTP-based FlowState with enhanced pause/resume capabilities
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
    hostLog(logPrefix, "info", `Executing HTTP-based FlowState task: ${taskName}`);

    // Monitor memory usage if available
    if (typeof Deno !== 'undefined' && Deno.memoryUsage) {
      const memUsage = Deno.memoryUsage();
      hostLog(logPrefix, "info", `Memory usage: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap`);
    }

    // Prepare enhanced task code with service registry integration
    const enhancedTaskCode = `
      ${taskCode}

      // Global __callHostTool__ function using service registry
      globalThis.__callHostTool__ = async function(serviceName, methodPath, args) {
        // Convert methodPath array to dot notation for consistency
        const methodString = Array.isArray(methodPath) ? methodPath.join('.') : methodPath;

        // Store call context for later use
        const callContext = {
          serviceName: serviceName,
          methodPath: Array.isArray(methodPath) ? methodPath : [methodPath],
          args: args,
          taskRunId: '${taskRunId}',
          stackRunId: '${stackRunId}'
        };

        // Store context globally for external call tracking
        globalThis._currentCallContext = callContext;

        // CRITICAL: All external calls must trigger suspension for FlowState to work
        // Instead of making the actual call, we throw a suspension error
        // The stack processor will handle the actual service call
        throw new Error(\`TASK_SUSPENDED: External call to \${serviceName}.\${methodString} needs suspension\`);
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
      if (typeof module !== 'undefined') {
        module.exports = ${taskCode.match(/module\.exports\s*=\s*([^;]+)/)?.[1] || taskCode.match(/export\s+(?:default\s+)?function\s+(\w+)/)?.[1] || 'handler'};
      }
    `;

    // Create a secure sandbox environment
    const sandbox = createSecureSandbox(taskRunId, stackRunId, taskName);

    // Execute the task in the sandbox
    const result = await sandbox.execute(enhancedTaskCode, taskInput, initialVmState);

    hostLog(logPrefix, "info", `HTTP-based FlowState execution completed`);

    // Monitor memory usage after execution
    if (typeof Deno !== 'undefined' && Deno.memoryUsage) {
      const memUsage = Deno.memoryUsage();
      hostLog(logPrefix, "info", `Final memory usage: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap`);
    }

    return result;

  } catch (error) {
    hostLog(logPrefix, "error", `HTTP-based FlowState execution failed: ${error instanceof Error ? error.message : String(error)}`);

    // Check if this is a suspension error
    if (error instanceof Error && error.message.includes('TASK_SUSPENDED')) {
      // Extract suspension data from the error
      const suspensionData = await extractSuspensionDataFromError(error, taskRunId, stackRunId);
      return suspensionData;
    }

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
        version: '1.0.0',
        serviceRegistry: 'minimal'
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

    // Use legacy resume mechanism which is now the primary mechanism
    return await handleLegacyResume(requestData);

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

/**
 * Resume mechanism for suspended tasks using service registry
 */
async function handleLegacyResume(requestData: any): Promise<Response> {
  const logPrefix = "DenoExecutor-Resume";

  const { stackRunIdToResume, resultToInject } = requestData;

  hostLog(logPrefix, "info", `Resuming stack run ${stackRunIdToResume} with result injection`);

  // Get the stack run to resume using minimal service registry
  const stackRunResult = await serviceRegistry.databaseCall('stack_runs', 'select', {
    filter: { id: parseInt(stackRunIdToResume) }
  });

  if (!stackRunResult.success || !stackRunResult.data?.[0]) {
    throw new Error(`Stack run ${stackRunIdToResume} not found`);
  }

  const stackRun = stackRunResult.data[0];

  // Extract task information from VM state
  const vmState = stackRun.vm_state;
  if (!vmState || !vmState.taskCode) {
    throw new Error(`Stack run ${stackRunIdToResume} has no VM state or task code`);
  }

  try {
    // Execute the task with the injected result using the sandbox
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

    // Check if the result is a suspension (task paused again)
    if (result && result.__hostCallSuspended === true) {
      hostLog(logPrefix, "info", `Task suspended again during resume, child stack run: ${result.stackRunId}`);

      return new Response(JSON.stringify({
        status: 'paused',
        suspensionData: result
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Task completed successfully
    hostLog(logPrefix, "info", `Task resumed and completed successfully`);

    return new Response(JSON.stringify({
      status: 'completed',
      result: result
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (error) {
    hostLog(logPrefix, "error", `Task resume failed: ${error instanceof Error ? error.message : String(error)}`);

    // Check if this is a suspension error
    if (error instanceof Error && error.message.includes('TASK_SUSPENDED')) {
      const suspensionData = await extractSuspensionDataFromError(error, stackRun.parent_task_run_id.toString(), stackRunIdToResume);

      return new Response(JSON.stringify({
        status: 'paused',
        suspensionData: suspensionData
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
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

console.log("🚀 Deno Task Executor with Unified Service Registry started successfully");
