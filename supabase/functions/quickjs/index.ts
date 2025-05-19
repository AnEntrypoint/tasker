/**
 * QuickJS Executor for Tasker
 * 
 * Provides a sandboxed JavaScript runtime for executing tasks
 * with ephemeral calls support for nested module invocations.
 */

import {
	getQuickJS,
	newAsyncContext,
	QuickJSContext,
	QuickJSHandle,
	QuickJSRuntime,
	QuickJSAsyncContext,
	QuickJSWASMModule
} from "quickjs-emscripten";

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// Import shared utils
import {
	hostLog,
	simpleStringify,
	LogEntry,
	fetchTaskFromDatabase
} from "../_shared/utils.ts";

// Import VM state manager for stack run management
import { saveStackRun, _generateUUID } from "./vm-state-manager.ts";

// ==============================
// Configuration
// ==============================

// Define CORS headers for HTTP responses
const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
	"Access-Control-Allow-Methods": "POST, OPTIONS"
};

// Get Supabase credentials from environment
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// ==============================
// Types and Interfaces
// ==============================

// Define QuickJSAsyncWASMModule type
interface QuickJSAsyncWASMModule extends QuickJSWASMModule {
	newRuntime: () => QuickJSRuntime;
}

// ==============================
// Helper Functions
// ==============================

/**
 * Create a QuickJS handle from a JavaScript value
 */
function createHandleFromJson(context: QuickJSContext, jsValue: any, handles: QuickJSHandle[]): QuickJSHandle {
	switch (typeof jsValue) {
		case 'string': 
			const strHandle = context.newString(jsValue); 
			handles.push(strHandle); 
			return strHandle;
		case 'number': 
			const numHandle = context.newNumber(jsValue); 
			handles.push(numHandle); 
			return numHandle;
		case 'boolean': 
			const boolHandle = jsValue ? context.true : context.false; 
			handles.push(boolHandle); 
			return boolHandle;
		case 'undefined': 
			const undefinedHandle = context.undefined; 
			handles.push(undefinedHandle); 
			return undefinedHandle;
		case 'object':
			if (jsValue === null) { 
				const nullHandle = context.null; 
				handles.push(nullHandle); 
				return nullHandle; 
			}
			if (Array.isArray(jsValue)) {
				return createArrayHandle(context, jsValue, handles);
			} else {
				return createObjectHandle(context, jsValue, handles);
			}
		default:
			hostLog("HandleConverter", "warn", `Unsupported type in createHandleFromJson: ${typeof jsValue}`);
			const handle = context.undefined;
			handles.push(handle); 
			return handle;
	}
}

/**
 * Create a QuickJS handle for an array
 */
function createArrayHandle(context: QuickJSContext, array: any[], handles: QuickJSHandle[]): QuickJSHandle {
	const arrayHandle = context.newArray(); 
	handles.push(arrayHandle);
	
	array.forEach((item, index) => {
		const itemHandle = createHandleFromJson(context, item, handles);
		context.setProp(arrayHandle, index, itemHandle);
	});
	
	return arrayHandle;
}

/**
 * Create a QuickJS handle for an object
 */
function createObjectHandle(context: QuickJSContext, obj: any, handles: QuickJSHandle[]): QuickJSHandle {
	const objHandle = context.newObject(); 
	handles.push(objHandle);
	
	for (const key in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {
			const valueHandle = createHandleFromJson(context, obj[key], handles);
			context.setProp(objHandle, key, valueHandle);
		}
	}
	
	return objHandle;
}

/**
 * Save an ephemeral call to the stack_runs table
 */
async function __saveEphemeralCall__(
	vm: QuickJSAsyncContext,
	stackRunId: string,
	serviceName: string,
	methodName: string,
	args: any[],
	parentStackRunId?: string | null,
	parentTaskRunId?: string | null
): Promise<boolean> {
	try {
		hostLog("EphemeralCall", "info", `Saving ephemeral call ${stackRunId} for ${serviceName}.${methodName}`);
		
		// Use saveStackRun from vm-state-manager to save the stack run
            await saveStackRun(
                stackRunId,
			serviceName, 
                methodName,
                args,
                parentTaskRunId,
                parentStackRunId
            );
            
		hostLog("EphemeralCall", "info", `Successfully saved stack run ${stackRunId}`);
		return true;
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		hostLog("EphemeralCall", "error", `Error saving ephemeral call: ${errorMessage}`);
		// Don't throw to prevent the QuickJS VM from crashing
		return false;
	}
}

// ==============================
// VM Environment Setup
// ==============================

/**
 * Set up the task environment with console and required tools
 */
async function setupTaskEnvironment(
	ctx: QuickJSAsyncContext,
	taskRunId: string,
	stackRunId?: string | null,
	parentTaskRunId?: string | null
): Promise<void> {
	// Add console logging capabilities
	setupConsoleObject(ctx);
	
	// Set current IDs in global context
	if (taskRunId) {
		const idHandle = ctx.newString(taskRunId);
		ctx.setProp(ctx.global, "__currentTaskRunId", idHandle);
		idHandle.dispose();
	}
	
				if (stackRunId) {
		const idHandle = ctx.newString(stackRunId);
		ctx.setProp(ctx.global, "__currentStackRunId", idHandle);
		idHandle.dispose();
	}
	
	// Set up host tool calling capability
	setupHostToolCaller(ctx, taskRunId);
	
	// Set up module exports object
	setupModuleExports(ctx);
	
	// Set up tools object with task execution capability
	setupToolsObject(ctx, taskRunId);
}

/**
 * Set up console object in VM
 */
function setupConsoleObject(ctx: QuickJSAsyncContext): void {
	const consoleObj = ctx.newObject();
	
	// Add all console methods
	const levels = ["log", "info", "warn", "error", "debug"] as const;
	for (const level of levels) {
		const logFn = ctx.newFunction(level, (...argHandles: QuickJSHandle[]) => {
			try {
				const stringArgs = argHandles.map(arg => {
					try {
						return ctx.typeof(arg) === 'string' ? ctx.getString(arg) : JSON.stringify(ctx.dump(arg));
							} catch (e) {
								return "[Complex Object]";
							}
				}).join(' ');
				
				hostLog("VMConsole", level, `${stringArgs}`);
					} catch (e) {
				// Don't fail if logging fails
				const errorMessage = e instanceof Error ? e.message : String(e);
				hostLog("VMConsole", "error", `Error in console.${level}: ${errorMessage}`);
			}
		});
		
		ctx.setProp(consoleObj, level, logFn);
		logFn.dispose();
	}
	
	// Set as global console
	ctx.setProp(ctx.global, "console", consoleObj);
			consoleObj.dispose();
		}

/**
 * Set up host tool calling capability
 */
function setupHostToolCaller(ctx: QuickJSAsyncContext, taskRunId: string): void {
	// Create the callHostTool function
	const callHostToolFn = ctx.newAsyncifiedFunction("__callHostTool__", async (
			serviceNameHandle: QuickJSHandle,
			methodChainHandle: QuickJSHandle,
			argsHandle: QuickJSHandle
		) => {
		const serviceName = ctx.getString(serviceNameHandle);
		const methodChainArray = ctx.dump(methodChainHandle) as string[];
			const methodName = methodChainArray.join('.');
		const args = ctx.dump(argsHandle);
		
		hostLog("HostTool", "info", `Host call: ${serviceName}.${methodName}`);
		
		// Create a stack run for this call
		const stackRunId = crypto.randomUUID();
		
		// Save the call as a stack run
		await __saveEphemeralCall__(
			ctx,
			stackRunId,
				serviceName,
			methodName,
			args,
			null,
			taskRunId
		);
		
		// Create a suspension marker
		const markerObj = ctx.newObject();
		ctx.setProp(markerObj, "__hostCallSuspended", ctx.true);
		ctx.setProp(markerObj, "stackRunId", ctx.newString(stackRunId));
		ctx.setProp(markerObj, "serviceName", ctx.newString(serviceName));
		ctx.setProp(markerObj, "methodName", ctx.newString(methodName));
		
		return markerObj;
		});
	
	ctx.setProp(ctx.global, "__callHostTool__", callHostToolFn);
	callHostToolFn.dispose();
}

/**
 * Set up module exports object
 */
function setupModuleExports(ctx: QuickJSAsyncContext): void {
	const moduleObj = ctx.newObject();
	const exportsObj = ctx.newObject();
	ctx.setProp(moduleObj, "exports", exportsObj);
	ctx.setProp(ctx.global, "module", moduleObj);
}

/**
 * Set up tools object with task execution capability
 */
function setupToolsObject(ctx: QuickJSAsyncContext, taskRunId: string): void {
	// Create and add a tools object to the global scope
	const toolsObj = ctx.newObject();
	
	// Set up tasks object with execute method
	const tasksObj = ctx.newObject();
	const executeTask = ctx.newAsyncifiedFunction("execute", async (
		taskNameHandle: QuickJSHandle,
		taskInputHandle: QuickJSHandle
	) => {
		const nestedTaskName = ctx.getString(taskNameHandle);
		const nestedInput = ctx.dump(taskInputHandle);
		
		hostLog("TaskExecution", "info", `Nested task call: ${nestedTaskName}`);
		
		// Create stack run ID
		const nestedStackRunId = crypto.randomUUID();
		
		// Save the ephemeral call
		await __saveEphemeralCall__(
			ctx,
			nestedStackRunId,
			"tasks",
			"execute",
			[nestedTaskName, nestedInput],
			null,
			taskRunId
		);
		
		// Create suspension marker
		const markerObj = ctx.newObject();
		ctx.setProp(markerObj, "__hostCallSuspended", ctx.true);
		ctx.setProp(markerObj, "stackRunId", ctx.newString(nestedStackRunId));
		ctx.setProp(markerObj, "serviceName", ctx.newString("tasks"));
		ctx.setProp(markerObj, "methodName", ctx.newString("execute"));
		
		return markerObj;
	});
	
	ctx.setProp(tasksObj, "execute", executeTask);
	executeTask.dispose();
	ctx.setProp(toolsObj, "tasks", tasksObj);
	tasksObj.dispose();
	
	// Add tools to global
	ctx.setProp(ctx.global, "tools", toolsObj);
	toolsObj.dispose();
}

// ==============================
// Main Execution Functions
// ==============================

/**
 * Main function to execute a task in QuickJS
 */
async function executeQuickJS(taskCode: string, taskName: string, taskInput: any): Promise<any> {
	const logPrefix = `QuickJS-${taskName}`;
	let quickJSInstance: QuickJSAsyncWASMModule | null = null;
	let rt: QuickJSRuntime | null = null;
	let ctx: QuickJSAsyncContext | null = null;
	const activeHandles: QuickJSHandle[] = [];
	
	try {
		hostLog(logPrefix, "info", `Initializing QuickJS for ${taskName}`);
		
		// Initialize QuickJS
		quickJSInstance = await getQuickJS() as QuickJSAsyncWASMModule;
		rt = quickJSInstance.newRuntime();
		ctx = await newAsyncContext(rt as any);
		
		// Set up the environment
		const taskRunId = crypto.randomUUID();
		await setupTaskEnvironment(ctx, taskRunId);
		
		// Evaluate the task code and get handler function
		const taskHandler = await evaluateTaskCode(ctx, taskCode, logPrefix);
		
		// Convert task input to VM value
		const handles: QuickJSHandle[] = [];
		const inputHandle = createHandleFromJson(ctx, taskInput, handles);
		
		// Create context object with tools
		const contextObj = ctx.newObject();
		const toolsContextHandle = ctx.getProp(ctx.global, "tools");
		ctx.setProp(contextObj, "tools", toolsContextHandle);
		
		// Call the task function
		hostLog(logPrefix, "info", `Calling task function with input: ${JSON.stringify(taskInput)}`);
		const resultHandle = ctx.callFunction(taskHandler, ctx.undefined, inputHandle, contextObj);
		
		if (resultHandle.error) {
			throw extractErrorFromHandle(ctx, resultHandle.error);
		}
		
		// Extract and return the result
		const finalResult = ctx.dump(resultHandle.value);
		hostLog(logPrefix, "info", "Task executed successfully");
		
		return finalResult;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const errorStack = error instanceof Error ? error.stack : undefined;
		hostLog(logPrefix, "error", `Error executing task: ${errorMessage}`);
		throw error;
	} finally {
		// Clean up resources
		if (ctx) {
			ctx.dispose();
			hostLog(logPrefix, "info", "Context disposed");
		}
		if (rt) {
			rt.dispose();
			hostLog(logPrefix, "info", "Runtime disposed");
		}
	}
}

/**
 * Evaluate task code and get the handler function
 */
async function evaluateTaskCode(
	ctx: QuickJSAsyncContext, 
	taskCode: string, 
	logPrefix: string
): Promise<QuickJSHandle> {
	hostLog(logPrefix, "info", "Evaluating task code");
	const evalResult = ctx.evalCode(`
		// Define module object and exports
		  const module = { exports: null };
		  
		  // Execute task code to attach function to module.exports
		  ${taskCode}
		  
		  // Extract the handler function
		  const taskHandler = typeof module.exports === 'function' 
			? module.exports 
			: null;
		  
		  // Return the handler function
		  taskHandler;
		`);

		if (evalResult.error) {
		const errMsg = ctx.dump(evalResult.error);
		hostLog(logPrefix, "error", `Error evaluating task code: ${errMsg}`);
		throw new Error(`Error evaluating task code: ${errMsg}`);
	}

		// Get the handler function
	const taskHandler = evalResult.value;
	if (ctx.typeof(taskHandler) !== 'function') {
		hostLog(logPrefix, "error", `Module exports is not a function, but a ${ctx.typeof(taskHandler)}`);
		throw new Error("Module exports is not a function");
	}
	
	return taskHandler;
}

/**
 * Extract an error object from a QuickJS handle
 */
function extractErrorFromHandle(ctx: QuickJSContext, errorHandle: QuickJSHandle): Error {
	const errorObj = ctx.dump(errorHandle);
				const errorMessage = typeof errorObj === 'object' && errorObj.message ? 
					errorObj.message : 
					typeof errorObj === 'string' ? 
						errorObj : 
						'Unknown error';
				
	return new Error(`Error in task execution: ${errorMessage}`);
}

// ==============================
// HTTP Server
// ==============================

/**
 * Handler for HTTP requests to the QuickJS function
 */
async function handleRequest(req: Request): Promise<Response> {
	if (req.method === "OPTIONS") {
		return new Response("ok", { headers: corsHeaders });
	}

	// Initialize Supabase client
	let supabaseClient: SupabaseClient;
	try {
		supabaseClient = createClient(
			SUPABASE_URL!,
			SUPABASE_SERVICE_KEY!,
			{
				global: { 
					headers: { Authorization: req.headers.get('Authorization')! }
				},
				auth: { persistSession: false }
			}
		);
	} catch (error) {
		return handleError(error, "Supabase client failed to initialize", 500);
	}

	try {
		// Parse request body
		const requestBody = await req.json();
		const { taskName: taskNameOrId, input: taskInput, parentRunId: parentTaskRunId } = requestBody;

		if (!taskNameOrId) {
			return new Response(simpleStringify({ error: "taskName is required" }), {
				status: 400,
				headers: { ...corsHeaders, "Content-Type": "application/json" }
			});
		}

		// Create or get a task run ID
		const taskRunId = crypto.randomUUID();
		const logPrefix = `QuickJS-${taskRunId}`;
		
		// Insert a task run record
		const { data: taskRunData, error: taskRunInsertError } = await supabaseClient
			.from('task_runs')
			.insert({
				id: taskRunId,
				task_name: taskNameOrId,
				parent_run_id: parentTaskRunId,
				status: 'processing',
				input: taskInput,
				started_at: new Date().toISOString()
			})
			.select('id')
			.single();

		if (taskRunInsertError) {
			hostLog(logPrefix, "error", `Failed to insert task run: ${taskRunInsertError.message}`);
			throw new Error(`Failed to create task run: ${taskRunInsertError.message}`);
		}

		// Fetch the task code
		hostLog(logPrefix, "info", `Fetching task code for ${taskNameOrId}`);
		const taskCode = await fetchTaskFromDatabase(supabaseClient, taskNameOrId, null, 
			(msg) => hostLog(logPrefix, 'info', msg));
		
		if (!taskCode) {
			// Update task run as failed
			await updateTaskRunStatus(
				supabaseClient, 
				taskRunId, 
				'failed', 
				null, 
				{ message: `Task code for '${taskNameOrId}' not found` }
			);
			
			return new Response(simpleStringify({ 
				error: `Task code for '${taskNameOrId}' not found` 
			}), {
				status: 404,
				headers: { ...corsHeaders, "Content-Type": "application/json" }
			});
		}

		// Check for direct execution mode vs. asynchronous execution
		const directExecution = requestBody.directExecution === true;
		
		if (directExecution) {
			return await handleDirectExecution(supabaseClient, taskCode, taskNameOrId, taskInput, taskRunId);
		} else {
			return await handleAsyncExecution(supabaseClient, taskCode, taskNameOrId, taskInput, taskRunId);
		}
	} catch (error) {
		return handleError(error, "Unhandled error in request processing", 500);
	}
}

/**
 * Handle direct execution mode (wait for result)
 */
async function handleDirectExecution(
	supabaseClient: SupabaseClient,
	taskCode: string,
	taskNameOrId: string,
	taskInput: any,
	taskRunId: string
): Promise<Response> {
	hostLog(`QuickJS-${taskRunId}`, "info", "Executing task directly");
	
	try {
		const result = await executeQuickJS(taskCode, taskNameOrId, taskInput);
		
		// Update task run record with result
		await updateTaskRunStatus(supabaseClient, taskRunId, 'completed', result);
		
		return new Response(JSON.stringify({
			taskRunId,
			result,
			status: 'completed'
		}), {
			status: 200,
			headers: { ...corsHeaders, "Content-Type": "application/json" }
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const errorStack = error instanceof Error ? error.stack : undefined;
		
		// Update task run record with error
		await updateTaskRunStatus(
			supabaseClient, 
			taskRunId, 
			'failed', 
			null, 
			{ message: errorMessage, stack: errorStack }
		);
		
		return new Response(simpleStringify({ 
			error: errorMessage, 
			stack: errorStack 
		}), {
			status: 500,
			headers: { ...corsHeaders, "Content-Type": "application/json" }
		});
	}
}

/**
 * Handle asynchronous execution mode (return immediately)
 */
async function handleAsyncExecution(
	supabaseClient: SupabaseClient,
	taskCode: string,
	taskNameOrId: string,
	taskInput: any,
	taskRunId: string
): Promise<Response> {
	hostLog(`QuickJS-${taskRunId}`, "info", "Starting asynchronous task execution");
	
	// Trigger the execution in the background
	(async () => {
		try {
			const result = await executeQuickJS(taskCode, taskNameOrId, taskInput);
			
			// Update task run record with result
			await updateTaskRunStatus(supabaseClient, taskRunId, 'completed', result);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const errorStack = error instanceof Error ? error.stack : undefined;
			
			// Update task run record with error
			await updateTaskRunStatus(
				supabaseClient, 
				taskRunId, 
				'failed', 
				null, 
				{ message: errorMessage, stack: errorStack }
			);
		}
	})();
	
	// Return immediately with task run ID
	return new Response(JSON.stringify({
		taskRunId,
		message: "Task execution started",
		status: 'processing'
	}), {
		status: 202, // Accepted
		headers: { ...corsHeaders, "Content-Type": "application/json" }
	});
}

/**
 * Update task run status in the database
 */
async function updateTaskRunStatus(
	supabaseClient: SupabaseClient,
	taskRunId: string,
	status: 'processing' | 'completed' | 'failed',
	result?: any,
	error?: any
): Promise<void> {
	const updateData: Record<string, any> = {
		status,
		updated_at: new Date().toISOString(),
	};
	
	if (result !== undefined) {
		updateData.result = result;
	}
	
	if (error !== undefined) {
		updateData.error = error;
	}
	
	if (status === 'completed' || status === 'failed') {
		updateData.ended_at = new Date().toISOString();
	}
	
	await supabaseClient
		.from('task_runs')
		.update(updateData)
		.eq('id', taskRunId);
}

/**
 * Handle errors in the request handler
 */
function handleError(error: unknown, defaultMessage: string, statusCode: number): Response {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const errorStack = error instanceof Error ? error.stack : undefined;
	
	hostLog("QuickJSHandler", "error", `${defaultMessage}: ${errorMessage}`);
	
	return new Response(simpleStringify({ 
		error: errorMessage, 
		stack: errorStack 
	}), {
		status: statusCode,
		headers: { ...corsHeaders, "Content-Type": "application/json" }
	});
}

// Export the main function for external use
export { executeQuickJS };

// Set up the Deno server
serve(handleRequest);