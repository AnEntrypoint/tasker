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
import { 
	saveStackRun, 
	triggerStackProcessor,
	captureVMState,
	_generateUUID
} from "./vm-state-manager.ts";

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
 * Set up the host tool caller function that enables VM suspension for service calls
 */
function setupHostToolCaller(ctx: QuickJSAsyncContext, taskRunId: string): void {
	// Create the callHostTool function - this is synchronous, not asyncified
	const callHostToolFn = ctx.newFunction("__callHostTool__", (
		serviceNameHandle: QuickJSHandle,
		methodChainHandle: QuickJSHandle,
		argsHandle: QuickJSHandle
	) => {
		try {
			const serviceName = ctx.getString(serviceNameHandle);
			const methodChainArray = ctx.dump(methodChainHandle) as string[];
			const methodName = methodChainArray.join('.');
			const args = ctx.dump(argsHandle);
			
			hostLog("HostTool", "info", `Host call: ${serviceName}.${methodName}`);
			
			// Create a stack run for this call
			const stackRunId = crypto.randomUUID();
			
			// Create a promise that will be manually resolved on resume
			const deferred = ctx.newPromise();
			
			// Store the resolver in the global scope for resume
			const resolverObj = ctx.newObject();
			ctx.setProp(resolverObj, "resolve", deferred.resolve);
			ctx.setProp(resolverObj, "reject", deferred.reject);
			ctx.setProp(ctx.global, "__resumeResolver__", resolverObj);
			
			// Create a suspension marker that will signal the VM should be suspended
			const suspendInfoObj = ctx.newObject();
			ctx.setProp(suspendInfoObj, "suspended", ctx.true);
			ctx.setProp(suspendInfoObj, "stackRunId", ctx.newString(stackRunId));
			ctx.setProp(suspendInfoObj, "serviceName", ctx.newString(serviceName));
			ctx.setProp(suspendInfoObj, "methodName", ctx.newString(methodName));
			ctx.setProp(suspendInfoObj, "args", createHandleFromJson(ctx, args, []));
			ctx.setProp(suspendInfoObj, "parentTaskRunId", ctx.newString(taskRunId));
			
			// Set the suspend info in the global context
			ctx.setProp(ctx.global, "__suspendInfo__", suspendInfoObj);
			
			// Log the suspension
			hostLog("HostTool", "info", `Will suspend VM for call to ${serviceName}.${methodName}`);
			hostLog("HostTool", "info", `With stack run ID: ${stackRunId}`);
			
			// Return the promise to be awaited in the VM
			return deferred.promise;
		} catch (error) {
			// Log the error
			const errorMsg = error instanceof Error ? error.message : String(error);
			hostLog("HostTool", "error", `Error in __callHostTool__: ${errorMsg}`);
			
			// Return an error object
			const errorObj = ctx.newObject();
			ctx.setProp(errorObj, "error", ctx.newString(errorMsg));
			return errorObj;
		}
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
 * Setup the tools object in the VM
 */
function setupToolsObject(ctx: QuickJSAsyncContext, taskRunId: string): void {
	const logPrefix = `QuickJS-Tools-${taskRunId}`;
	hostLog(logPrefix, "info", "Setting up tools object");
	
	const toolsObj = ctx.newObject();
	
	// Create service proxies for different services
	const toolNames = ["database", "keystore", "openai", "websearch", "gapi"];
	
	for (const toolName of toolNames) {
		hostLog(logPrefix, "info", `Adding service: ${toolName}`);
		const serviceProxy = createServiceProxyObject(ctx, toolName, taskRunId);
		ctx.setProp(toolsObj, toolName, serviceProxy);
	}
	
	// Add special case for tasks service
	const tasksObj = ctx.newObject();
	
	// Create the execute function with stack run interception
	ctx.setProp(
		tasksObj,
		"execute", 
		ctx.newFunction("execute", (taskName: string, input: unknown) => {
			hostLog(logPrefix, "info", `Intercepting tasks.execute call: ${taskName}`);
			
			// Generate a unique ID for this stack run
			const stackRunId = _generateUUID();
			
			// Capture the VM state
			const vmState = captureVMState(ctx, taskRunId, stackRunId);
			
			// Save this stack run
			saveStackRun("tasks", "execute", [taskName, input], vmState, taskRunId)
				.then(() => {
					hostLog(logPrefix, "info", `Stack run created: ${stackRunId}`);
					
					// Trigger the stack processor
					return triggerStackProcessor();
				})
				.catch(error => {
					hostLog(logPrefix, "error", `Error creating stack run: ${error.message}`);
				});
			
			// Return a promise that will be resolved by the VM state manager
			// This will cause the VM to suspend execution
			return ctx.newPromise();
		})
	);
	
	// Add sleep function for testing
	ctx.setProp(
		toolsObj,
		"sleep", 
		ctx.newFunction("sleep", (msHandle: QuickJSHandle) => {
			// Get the sleep duration in milliseconds
			const ms = ctx.getNumber(msHandle);
			
			hostLog(logPrefix, "info", `Sleep requested for ${ms}ms`);
			
			// Create a new promise to hold the result
			const deferred = ctx.newPromise();
			
			// Create a unique stack run ID for this sleep operation
			const stackRunId = crypto.randomUUID();
			
			// Store the resolver in the global scope for resume
			const resolverObj = ctx.newObject();
			ctx.setProp(resolverObj, "resolve", deferred.resolve);
			ctx.setProp(resolverObj, "reject", deferred.reject);
			ctx.setProp(ctx.global, "__resumeResolver__", resolverObj);
			
			// Set suspension info
			const suspendInfoObj = ctx.newObject();
			ctx.setProp(suspendInfoObj, "suspended", ctx.true);
			ctx.setProp(suspendInfoObj, "stackRunId", ctx.newString(stackRunId));
			ctx.setProp(suspendInfoObj, "serviceName", ctx.newString("tools"));
			ctx.setProp(suspendInfoObj, "methodName", ctx.newString("sleep"));
			ctx.setProp(suspendInfoObj, "args", createHandleFromJson(ctx, [ms], []));
			ctx.setProp(suspendInfoObj, "parentTaskRunId", ctx.newString(taskRunId));
			
			// Set the suspend info in global context
			ctx.setProp(ctx.global, "__suspendInfo__", suspendInfoObj);
			
			// Set up background resolution of the promise after ms milliseconds
			setTimeout(() => {
				hostLog(logPrefix, "info", `Sleep completed after ${ms}ms`);
				
				// Trigger the resumption of the VM
				const suspendedTaskArgs = {
					taskRunId,
					stackRunId,
					result: { slept: true, duration: ms }
				};
				
				// TODO: Implement actual VM resumption logic with the result
				// For now, we'll let the executeQuickJS function handle it
			}, ms);
			
			// Return the promise to be awaited in the VM
			return deferred.promise;
		})
	);
	
	// Add the tasks object to tools
	ctx.setProp(toolsObj, "tasks", tasksObj);
	
	// Set the tools object as a global
	ctx.setProp(ctx.global, "tools", toolsObj);
	
	hostLog(logPrefix, "info", "Tools object setup complete");
}

/**
 * Save VM state for a stack run
 */
async function saveVMState(stackRunId: string, vmState: SerializedVMState, parentTaskRunId?: string): Promise<void> {
	hostLog("QuickJS-VM", "info", `Saving VM state for stack run: ${stackRunId}`);
	
	try {
		const { url, serviceRoleKey } = getSupabaseConfig();
		
		if (!serviceRoleKey) {
			throw new Error("Missing service role key");
		}
		
		const supabase = createClient(url, serviceRoleKey);
		
		// Create stack run record with VM state
		const { error } = await supabase
			.from("stack_runs")
			.insert({
				id: stackRunId,
				parent_task_run_id: parentTaskRunId || null,
				service_name: "tasks",
				method_name: "execute",
				args: [vmState.taskName, vmState.taskInput],
				status: "pending",
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				vm_state: vmState
			});
		
		if (error) {
			throw new Error(`Error creating stack run: ${error.message}`);
		}
		
		// If this stack run has a parent task run, update its status
		if (parentTaskRunId) {
			const { error: updateError } = await supabase
				.from("task_runs")
				.update({
					status: "suspended",
					updated_at: new Date().toISOString(),
					suspended_at: new Date().toISOString(),
					waiting_on_stack_run_id: stackRunId
				})
				.eq("id", parentTaskRunId);
			
			if (updateError) {
				hostLog("QuickJS-VM", "error", `Error updating parent task run: ${updateError.message}`);
			}
		}
		
		// Trigger stack processor
		await triggerStackProcessor();
		
	} catch (error) {
		hostLog("QuickJS-VM", "error", `Error saving VM state: ${error instanceof Error ? error.message : String(error)}`);
		throw error;
	}
}

/**
 * Get Supabase configuration
 */
function getSupabaseConfig() {
	const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
	let url = Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
	
	if (url.includes('127.0.0.1:8000')) {
		url = 'http://localhost:54321';
	}
	
	return { url, serviceRoleKey };
}

/**
 * Creates a service proxy object that can handle nested method chains
 */
function createServiceProxyObject(ctx: QuickJSAsyncContext, serviceName: string, taskRunId: string): QuickJSHandle {
	const proxyObj = ctx.newObject();
	
	// Add a specific property for tracking path in nested proxies
	const pathProp = '__path';
	ctx.setProp(proxyObj, pathProp, ctx.newArray());
	
	// Handle both direct method calls and nested property chains
	const handler = ctx.newFunction("handle", (
		targetHandle: QuickJSHandle,
		propNameHandle: QuickJSHandle
	) => {
		const propName = ctx.getString(propNameHandle);
		const currentPathArray = ctx.dump(ctx.getProp(targetHandle, pathProp)) as string[];
		const newPathArray = [...currentPathArray, propName];
		
		hostLog("ServiceProxy", "debug", `Creating proxy for ${serviceName}.${newPathArray.join('.')}`);
		
		// Create a wrapper for handling method calls
		const methodWrapper = ctx.newFunction(propName, (...argHandles: QuickJSHandle[]) => {
			try {
				// Extract arguments from handles
				const args = argHandles.map(arg => ctx.dump(arg));
				
				// Log the full path being called
				const fullMethodPath = newPathArray.join('.');
				hostLog("ServiceProxy", "info", `Call to ${serviceName}.${fullMethodPath} with args: ${simpleStringify(args)}`);
				
				// Instead of building a complex proxy chain, use __callHostTool__ directly
				// with the full method path as an array
				const callHostTool = ctx.getProp(ctx.global, "__callHostTool__");
				const serviceNameHandle = ctx.newString(serviceName);
				const methodPathHandle = createHandleFromJson(ctx, newPathArray, []);
				const argsHandle = createHandleFromJson(ctx, args, []);
				
				const result = ctx.callFunction(callHostTool, ctx.undefined, serviceNameHandle, methodPathHandle, argsHandle);
				
				serviceNameHandle.dispose();
				methodPathHandle.dispose();
				argsHandle.dispose();
				callHostTool.dispose();
				
				return result;
			} catch (error) {
				// Log the error
				const errorMsg = error instanceof Error ? error.message : String(error);
				hostLog("ServiceProxy", "error", `Error in ${serviceName}.${propName}: ${errorMsg}`);
				
				// Return an error object
				const errorObj = ctx.newObject();
				ctx.setProp(errorObj, "error", ctx.newString(errorMsg));
				return errorObj;
			}
		});
		
		// Create a nested proxy for property access chaining
		const nestedProxy = ctx.newObject();
		
		// Add __proto__ and constructor for proper instanceof checks
		ctx.setProp(nestedProxy, "__proto__", proxyObj);
		ctx.setProp(nestedProxy, "constructor", proxyObj);
		
		// Set the path on the nested proxy as an array
		const newPathArrayHandle = createHandleFromJson(ctx, newPathArray, []);
		ctx.setProp(nestedProxy, pathProp, newPathArrayHandle);
		
		// Set the method wrapper on the nested proxy
		ctx.setProp(nestedProxy, propName, methodWrapper);
		methodWrapper.dispose();
		
		return nestedProxy;
	});
	
	// Install the handler as a proxy
	ctx.setProp(proxyObj, "get", handler);
	handler.dispose();
	
	return proxyObj;
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
		
		// Convert task input to VM value - ensure it's not undefined
		const handles: QuickJSHandle[] = [];
		const normalizedInput = taskInput || {};
		hostLog(logPrefix, "info", `Preparing input: ${JSON.stringify(normalizedInput)}`);
		const inputHandle = createHandleFromJson(ctx, normalizedInput, handles);
		
		// Create context object with tools
		const contextObj = ctx.newObject();
		const toolsContextHandle = ctx.getProp(ctx.global, "tools");
		ctx.setProp(contextObj, "tools", toolsContextHandle);
		
		// Call the task function (synchronously)
		hostLog(logPrefix, "info", `Calling task function with input: ${JSON.stringify(normalizedInput)}`);
		const resultHandle = ctx.callFunction(taskHandler, ctx.undefined, inputHandle, contextObj);
		
		if (resultHandle.error) {
			throw extractErrorFromHandle(ctx, resultHandle.error);
		}
		
		// Process pending jobs for initial execution
		hostLog(logPrefix, "info", "Processing pending jobs for task execution");
		let processedJobs = 0;
		while (ctx.runtime.executePendingJobs() !== 0) {
			processedJobs++;
			if (processedJobs > 1000) {
				hostLog(logPrefix, "warn", "Too many pending jobs, possible infinite loop");
				break;
			}
		}
		
		// Check if execution was suspended for a host call
		const suspendInfoHandle = ctx.getProp(ctx.global, "__suspendInfo__");
		if (suspendInfoHandle && !suspendInfoHandle.isUndefined) {
			const suspendInfo = ctx.dump(suspendInfoHandle);
			suspendInfoHandle.dispose();
			
			if (suspendInfo && suspendInfo.suspended) {
				hostLog(logPrefix, "info", `Task execution suspended for ${suspendInfo.serviceName}.${suspendInfo.methodName} call`);
				
				// Create a VM state object for suspension
				const vmState = {
					stackRunId: suspendInfo.stackRunId,
					taskRunId,
					suspended: true,
					suspendedAt: new Date().toISOString(),
					waitingOnStackRunId: null
				};
				
				// Save stack run with the right parameter order
				await saveStackRun(
					suspendInfo.serviceName,
					suspendInfo.methodName,
					suspendInfo.args,
					vmState,
					taskRunId
				);
				
				// Trigger stack processor
				await triggerStackProcessor();
				
				// Return suspension info
				return {
					__hostCallSuspended: true,
					stackRunId: suspendInfo.stackRunId,
					serviceName: suspendInfo.serviceName,
					methodName: suspendInfo.methodName,
					args: suspendInfo.args,
					taskRunId
				};
			}
		}
		
		// For normal completion, extract the result
		const resultValue = resultHandle.value;
		const result = ctx.dump(resultValue);
		
		// Clean up handles
		for (const handle of handles) {
			handle.dispose();
		}
		
		// Check if resultHandle has a dispose method before calling it
		if (resultHandle && typeof resultHandle.dispose === 'function') {
			resultHandle.dispose();
		}
		
		return result;
	} catch (error) {
		hostLog(logPrefix, "error", `Error executing task: ${error instanceof Error ? error.message : String(error)}`);
		hostLog(logPrefix, "error", error instanceof Error ? error.stack || 'No stack' : 'No stack');
		throw error;
	} finally {
		// Clean up QuickJS resources
		if (ctx) ctx.dispose();
		if (rt) rt.dispose();
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

/**
 * Resume a suspended VM execution with a result
 */
async function resumeVM(stackRunId: string, result: any): Promise<any> {
	const logPrefix = `QuickJS-Resume-${stackRunId}`;
	let rt: QuickJSRuntime | null = null;
	let ctx: QuickJSAsyncContext | null = null;
	
	try {
		hostLog(logPrefix, "info", `Resuming VM for stack run: ${stackRunId}`);
		
		// Get the stack run with VM state
		const stackRun = await getStackRun(stackRunId);
		if (!stackRun || !stackRun.vm_state) {
			throw new Error(`No VM state found for stack run: ${stackRunId}`);
		}
		
		// Get parent task run ID
		const taskRunId = stackRun.parent_task_run_id;
		if (!taskRunId) {
			throw new Error(`No parent task run ID found for stack run: ${stackRunId}`);
		}
		
		// Initialize QuickJS
		const quickJSInstance = await getQuickJS() as QuickJSAsyncWASMModule;
		rt = quickJSInstance.newRuntime();
		ctx = await newAsyncContext(rt as any);
		
		// Set up the environment
		await setupTaskEnvironment(ctx, taskRunId);
		
		// Get the resolver from the global scope
		const resolverHandle = ctx.getProp(ctx.global, "__resumeResolver__");
		if (!resolverHandle || resolverHandle.isUndefined) {
			throw new Error("No resume resolver found in VM state");
		}
		
		// Create a handle for the result
		const resultHandle = createHandleFromJson(ctx, result, []);
		
		// Call the resolver with the result to continue execution
		hostLog(logPrefix, "info", "Calling resume resolver with result");
		const resolveHandle = ctx.getProp(resolverHandle, "resolve");
		ctx.callFunction(resolveHandle, ctx.undefined, [resultHandle]);
		
		// Process pending jobs to continue execution
		hostLog(logPrefix, "info", "Processing pending jobs after resume");
		let processedJobs = 0;
		while (ctx.runtime.executePendingJobs() > 0) {
			processedJobs++;
			hostLog(logPrefix, "info", `Processed ${processedJobs} pending jobs`);
			if (processedJobs > 1000) {
				hostLog(logPrefix, "warn", "Too many pending jobs, possible infinite loop");
				break;
			}
		}
		
		// Get the result from the global object
		const finalResultHandle = ctx.getProp(ctx.global, "__result__");
		const finalResult = ctx.dump(finalResultHandle);
		
		// Clean up handles
		resolverHandle.dispose();
		resolveHandle.dispose();
		resultHandle.dispose();
		finalResultHandle.dispose();
		
		return finalResult;
	} catch (error) {
		hostLog(logPrefix, "error", `Error resuming VM: ${error instanceof Error ? error.message : String(error)}`);
		hostLog(logPrefix, "error", error instanceof Error ? error.stack || 'No stack' : 'No stack');
		throw error;
	} finally {
		// Clean up QuickJS resources
		if (ctx) ctx.dispose();
		if (rt) rt.dispose();
	}
}

// ==============================
// HTTP Server
// ==============================

/**
 * Handle requests to the QuickJS function
 */
async function handleRequest(req: Request): Promise<Response> {
	hostLog("QuickJSHandler", "info", `Received request: ${req.method} ${req.url}`);
	
	if (req.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: corsHeaders
		});
	}
	
	// Extract URL path
	const url = new URL(req.url);
	const path = url.pathname.split('/').pop();
	
	// Handle VM resumption requests
	if (path === 'resume') {
		return handleVMResumption(req);
	}
	
	// Handle direct task execution
	return handleTaskExecution(req);
}

/**
 * Handle VM resumption requests
 */
async function handleVMResumption(req: Request): Promise<Response> {
	hostLog("QuickJSHandler", "info", "Handling VM resumption request");
	
	try {
		// Parse the request
		const requestData = await req.json();
		const { stackRunId } = requestData;
		
		if (!stackRunId) {
			return handleError(new Error("Missing stackRunId"), "Invalid resumption request", 400);
		}
		
		hostLog("QuickJSHandler", "info", `Resuming VM for stack run: ${stackRunId}`);
		
		// Restore VM state
		const { context, stackRun } = await restoreVMState(stackRunId);
		
		// Execute the VM and get the result
		const result = await executeRestored(context, stackRun);
		
		return new Response(simpleStringify({
			result,
			status: 'completed',
			message: `VM resumed successfully for stack run ${stackRunId}`
		}), {
			status: 200,
			headers: { ...corsHeaders, "Content-Type": "application/json" }
		});
	} catch (error) {
		return handleError(error, "Error resuming VM", 500);
	}
}

/**
 * Execute a restored VM context
 */
async function executeRestored(context: QuickJSAsyncContext, stackRun: any): Promise<any> {
	hostLog("QuickJSHandler", "info", `Executing restored VM for stack run: ${stackRun.id}`);
	
	try {
		// Get the resume payload
		const resumePayload = stackRun.resume_payload;
		
		if (!resumePayload) {
			throw new Error("No resume payload found");
		}
		
		// Create a handle for the resume payload
		const resumeHandle = createHandleFromJson(context, resumePayload, []);
		
		// Get the resolve function from the global scope
		const resumeResolver = context.getProp(context.global, "__resumeResolver__");
		
		if (!resumeResolver) {
			throw new Error("No resume resolver found in VM state");
		}
		
		// Call the resolver with the resume payload
		context.callFunction(resumeResolver, context.undefined, [resumeHandle]);
		
		// Execute pending jobs until there are none left
		let executed = 0;
		let bailout = 1000; // Safety limit
		
		while (context.runtime.executePendingJobs() > 0) {
			executed++;
			
			if (executed > bailout) {
				throw new Error("Too many pending jobs");
			}
		}
		
		// Get the result from the global __result__ variable
		const resultHandle = context.getProp(context.global, "__result__");
		
		if (!resultHandle) {
			throw new Error("No result found after VM execution");
		}
		
		// Extract the result
		const result = context.dump(resultHandle);
		
		// Dispose of handles
		resumeHandle.dispose();
		resumeResolver.dispose();
		resultHandle.dispose();
		
		return result;
	} catch (error) {
		hostLog("QuickJSHandler", "error", `Error executing restored VM: ${error instanceof Error ? error.message : String(error)}`);
		throw error;
	} finally {
		// Ensure context is disposed
		context.dispose();
	}
}

/**
 * Handle task execution requests
 */
async function handleTaskExecution(req: Request): Promise<Response> {
	if (req.method === "OPTIONS") {
		return new Response("ok", { headers: corsHeaders });
	}
	
	try {
		// Get request body
		let requestData;
		try {
			requestData = await req.json();
		} catch (error) {
			return handleError(error, "Invalid JSON request body", 400);
		}
		
		// Initialize supabase client
		if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
			return handleError("Missing Supabase credentials", "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", 500);
		}
		
		const supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
		
		// Extract task information
		const taskNameOrId = requestData.taskName || requestData.taskId;
		if (!taskNameOrId) {
			return handleError("Missing task name/id", "Missing taskName or taskId in request body", 400);
		}
		
		const taskInput = requestData.taskInput || {};
		let taskRunId = requestData.taskRunId || crypto.randomUUID();
		
		// Get the task code
		let taskCode: string;
		let taskName: string;
		
		try {
			// Call the fetchTaskFromDatabase which may return either a string or a task object
			const taskResult = await fetchTaskFromDatabase(supabaseClient, taskNameOrId);
			
			// If fetchTaskFromDatabase returns null, the task wasn't found
			if (!taskResult) {
				return handleError(`Task not found: ${taskNameOrId}`, `Task not found: ${taskNameOrId}`, 404);
			}
			
			// If taskResult is a string, use it directly as the task code
			if (typeof taskResult === 'string') {
				taskCode = taskResult;
				taskName = taskNameOrId;
			} 
			// If taskResult is an object, extract code and name properties
			else if (typeof taskResult === 'object' && taskResult !== null) {
				const taskData = taskResult as { code?: string; name?: string };
				taskCode = taskData.code || '';
				taskName = taskData.name || taskNameOrId;
      } else {
				return handleError(`Invalid task format: ${taskNameOrId}`, `Invalid task format: ${taskNameOrId}`, 404);
			}
			
			if (!taskCode) {
				return handleError(`Task code is empty: ${taskNameOrId}`, `Task code is empty: ${taskNameOrId}`, 404);
			}
		} catch (error) {
			return handleError(error, `Error fetching task: ${taskNameOrId}`, 500);
		}
		
		// Handle direct or async execution based on the request
		if (requestData.directExecution) {
			return await handleDirectExecution(supabaseClient, taskCode, taskName, taskInput, taskRunId);
          } else {
			return await handleAsyncExecution(supabaseClient, taskCode, taskName, taskInput, taskRunId);
		}
	} catch (error) {
		return handleError(error, "Unexpected error processing request", 500);
	}
}

/**
 * Handle direct execution of a task with no background processing
 */
async function handleDirectExecution(
	supabaseClient: SupabaseClient,
	taskCode: string,
	taskName: string,
	taskInput: any,
	taskRunId: string
): Promise<Response> {
	const logPrefix = `QuickJS-${taskName}-${taskRunId}`;
	hostLog(logPrefix, "info", `Starting direct execution of ${taskName} with run ID ${taskRunId}`);
	
	try {
		// Execute the task in QuickJS with a timeout
		const result = await executeQuickJS(taskCode, taskName, taskInput);
		
		// Check if the task execution was suspended for a host call
		if (result && typeof result === 'object' && result.__hostCallSuspended) {
			hostLog(logPrefix, "info", `Task execution suspended for ${result.serviceName}.${result.methodName} call`);
			
			// Save the stack run
			await saveStackRun(
				result.stackRunId,
				result.serviceName,
				result.methodName,
				result.args || [],
				taskRunId,
				null
			);
			
			// Return success response with suspended status
			return new Response(simpleStringify({
				status: 'suspended',
				message: `Task execution suspended for ${result.serviceName}.${result.methodName} call`,
				stackRunId: result.stackRunId
			}), {
				status: 202,
				headers: { ...corsHeaders, "Content-Type": "application/json" }
			});
		}
		
		// For normal completion, return the result
		hostLog(logPrefix, "info", "Task executed successfully");
		
		return new Response(simpleStringify({
			result,
			status: 'completed',
			message: `Task ${taskName} executed successfully`
		}), {
			status: 200,
			headers: { ...corsHeaders, "Content-Type": "application/json" }
		});
  } catch (error) {
		hostLog(logPrefix, "error", `Error executing task: ${error instanceof Error ? error.message : String(error)}`);
		
		// Return error response
		return handleError(error, `Error executing task ${taskName}`, 500);
  }
}

/**
 * Handle asynchronous execution of a task in the background
 */
async function handleAsyncExecution(
	supabaseClient: SupabaseClient,
	taskCode: string,
	taskName: string,
	taskInput: any,
	taskRunId: string
): Promise<Response> {
	const logPrefix = `QuickJS-${taskName}-${taskRunId}`;
	hostLog(logPrefix, "info", `Starting async execution of ${taskName} with run ID ${taskRunId}`);
	
	try {
		// Create a task run record
		const { data: taskRunData, error: taskRunInsertError } = await supabaseClient
			.from('task_runs')
			.insert({
				id: taskRunId,
				task_name: taskName,
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
		
		// Start execution in the background
		(async () => {
			try {
				// Execute the task in QuickJS
				const result = await executeQuickJS(taskCode, taskName, taskInput);
				
				// Check if the task execution was suspended for a host call
				if (result && typeof result === 'object' && result.__hostCallSuspended) {
					hostLog(logPrefix, "info", `Task execution suspended for ${result.serviceName}.${result.methodName} call`);
					
					// Save the stack run
					await saveStackRun(
						result.stackRunId,
						result.serviceName,
						result.methodName,
						result.args || [],
						taskRunId,
						null
					);
					
					// Update task run status to suspended
					await updateTaskRunStatus(
						supabaseClient, 
						taskRunId, 
						'suspended',
						null,
						null
					);
    } else {
					// Normal completion - update task run with result
					await updateTaskRunStatus(
						supabaseClient, 
						taskRunId, 
						'completed', 
						result
					);
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				const errorStack = error instanceof Error ? error.stack : undefined;
				hostLog(logPrefix, "error", `Error in background task execution: ${errorMessage}`);
				
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
		
		// Return the task run ID immediately
		return new Response(simpleStringify({
			taskRunId,
			status: 'processing',
			message: `Task execution started. Check status at /tasks/status?id=${taskRunId}`
		}), {
			status: 202,
			headers: { ...corsHeaders, "Content-Type": "application/json" }
		});
	} catch (error) {
		hostLog(logPrefix, "error", `Failed to start task execution: ${error instanceof Error ? error.message : String(error)}`);
		return handleError(error, `Failed to start task execution for ${taskName}`, 500);
	}
}

/**
 * Update task run status in the database
 */
async function updateTaskRunStatus(
	supabaseClient: SupabaseClient,
  taskRunId: string,
	status: 'processing' | 'completed' | 'failed' | 'suspended',
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
	} else if (status === 'suspended') {
		updateData.suspended_at = new Date().toISOString();
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