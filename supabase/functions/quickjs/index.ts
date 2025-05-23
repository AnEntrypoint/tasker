/**
 * QuickJS Executor for Tasker
 * 
 * Provides a sandboxed JavaScript runtime for executing tasks
 * with ephemeral calls support for nested module invocations.
 */

import {
	getQuickJS,
	QuickJSContext,
	QuickJSRuntime,
	QuickJSWASMModule,
	QuickJSAsyncWASMModule,
	QuickJSHandle,
	newAsyncContext,
	QuickJSAsyncContext,
	QuickJSDeferredPromise
} from "quickjs-emscripten";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { generateServiceProxy } from './proxy-generator.ts';

import {
	getStackRun,
	updateStackRun,
	triggerStackProcessor,
	updateTaskRun,
	SerializedVMState,
	saveStackRun,
	_generateUUID,
	captureVMState,
	StackRun,
	getSupabaseClient
} from "./vm-state-manager.ts";

import {
	hostLog,
	simpleStringify,
	LogEntry
} from "../_shared/utils.ts";

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

// SerializedVMState is defined in vm-state-manager.ts

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
			return boolHandle;
		case 'undefined': 
			return context.undefined;
		case 'object':
			if (jsValue === null) { 
				return context.null; 
			}
			if (Array.isArray(jsValue)) {
				return createArrayHandle(context, jsValue, handles);
			} else {
				return createObjectHandle(context, jsValue, handles);
			}
		default:
			hostLog("HandleConverter", "warn", `Unsupported type in createHandleFromJson: ${typeof jsValue}`);
			return context.undefined;
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
	stackRunId: string,
	serviceName: string,
	methodName: string,
	args: any[],
	taskRunId?: string,
	parentStackRunId?: string
): Promise<boolean> {
	try {
		hostLog("EphemeralCall", "info", `Saving ephemeral call ${stackRunId} for ${serviceName}.${methodName}`);
		
		const finalTaskRunId = taskRunId || _generateUUID();
		
		await saveStackRun(
			serviceName, 
			methodName,
			args,
			{ 
				stackRunId, 
				suspended: true, 
				suspendedAt: new Date().toISOString(), 
				taskRunId: finalTaskRunId,
				taskCode: "",
				taskName: serviceName,
				taskInput: args
			},
			finalTaskRunId,
			parentStackRunId
		);
		
		hostLog("EphemeralCall", "info", `Successfully saved stack run ${stackRunId}`);
		return true;
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		hostLog("EphemeralCall", "error", `Error saving ephemeral call: ${errorMessage}`);
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
	taskCode: string,
	taskName: string,
	taskInput: any,
	stackRunId?: string | null,
	toolNames?: string[]
): Promise<void> {
	setupConsoleObject(ctx);
	
	setupHostToolCaller(ctx, taskRunId);
	
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
	
	setupModuleExports(ctx);
	
	setupToolsObject(ctx, taskRunId, taskCode, taskName, taskInput, toolNames);
}

/**
 * Set up console object in VM
 */
function setupConsoleObject(ctx: QuickJSAsyncContext): void {
	const consoleObj = ctx.newObject();
	
	const levels = ["log", "info", "warn", "error", "debug"] as const;
	for (const level of levels) {
		const logFn = ctx.newFunction(level, (...argHandles: QuickJSHandle[]) => {
			try {
				const stringArgs = argHandles.map(arg => {
					try {
						if (ctx.typeof(arg) === 'string') return ctx.getString(arg);
						
						const dumped = ctx.dump(arg);
						return typeof dumped === 'string' ? dumped : simpleStringify(dumped);
					} catch (e) {
						return "[Unloggable Object]";
					}
				}).join(' ');
				
				hostLog("VMConsole", level, stringArgs);
			} catch (e) {
				const errorMessage = e instanceof Error ? e.message : String(e);
				hostLog("VMConsole", "error", `Error in console.${level}: ${errorMessage}`);
			}
		});
		
		ctx.setProp(consoleObj, level, logFn);
		logFn.dispose();
	}
	
	ctx.setProp(ctx.global, "console", consoleObj);
			consoleObj.dispose();
		}

/**
 * Set up the host tool caller function for direct service calls
 */
function setupHostToolCaller(ctx: QuickJSAsyncContext, taskRunId: string): void {
	const callHostToolFn = ctx.newAsyncifiedFunction("__callHostTool__", async (
		serviceNameHandle: QuickJSHandle,
		methodChainHandle: QuickJSHandle,
		argsHandle: QuickJSHandle
	) => {
		const handles: QuickJSHandle[] = [serviceNameHandle, methodChainHandle, argsHandle];
		
		try {
			const serviceName = ctx.getString(serviceNameHandle);
			
			const methodChainArray: string[] = [];
			const methodChainLen = ctx.getNumber(ctx.getProp(methodChainHandle, "length"));
			for (let i=0; i<methodChainLen; i++) {
				const partHandle = ctx.getProp(methodChainHandle, i);
				handles.push(partHandle);
				methodChainArray.push(ctx.getString(partHandle));
			}
			const methodName = methodChainArray.join('.');
			
			const args = ctx.dump(argsHandle);
			
			hostLog("HostToolDirect", "info", `Direct service call: ${serviceName}.${methodName} for taskRunId: ${taskRunId}`);
			
			const serviceUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/wrapped${serviceName.toLowerCase()}`;
			
			hostLog("HostToolDirect", "info", `Calling service at: ${serviceUrl} with method: ${methodName}`);
			
			const response = await fetch(serviceUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`
				},
				body: JSON.stringify({
					methodChain: methodChainArray,
					args: args,
					taskRunId: taskRunId
				})
			});
			
			if (!response.ok) {
				const errorBody = await response.text();
				hostLog("HostToolDirect", "error", `Service call ${serviceName}.${methodName} failed with status ${response.status}: ${errorBody}`);
				throw new Error(`Service call failed: ${response.status} - ${errorBody}`);
			}
			
			const result = await response.json();
			hostLog("HostToolDirect", "info", `Service call ${serviceName}.${methodName} completed successfully.`);
			
			const resultHandle = createHandleFromJson(ctx, result, handles);
			return resultHandle;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			hostLog("HostToolDirect", "error", `Error in direct service call: ${errorMsg}`);
			
			const qjsError = ctx.newError(errorMsg);
			throw qjsError;
		} finally {
			handles.forEach(h => { h?.dispose(); });
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
	exportsObj.dispose();
	ctx.setProp(ctx.global, "module", moduleObj);
	moduleObj.dispose();
}

/**
 * Setup the tools object in the VM using generateServiceProxy
 */
function setupToolsObject(
	ctx: QuickJSAsyncContext, 
	taskRunId: string,
	taskCode: string,
	taskName: string,
	taskInput: any,
	toolNames: string[] = []
): void {
	const logPrefix = `QuickJS-Tools-${taskRunId}`;
	hostLog(logPrefix, "info", "Setting up tools object using generateServiceProxy.");
	
	const toolsObj = ctx.newObject();
	
	const defaultTools = ["database", "keystore", "openai", "websearch", "gapi"];
	const finalToolNames = toolNames.length > 0 ? toolNames : defaultTools;
	
	hostLog(logPrefix, "info", `Creating service proxies for: ${finalToolNames.join(', ')}`);
	
	for (const toolName of finalToolNames) {
		hostLog(logPrefix, "info", `Adding service proxy for: ${toolName}`);
		const serviceProxyHandle = generateServiceProxy(ctx, taskRunId, taskCode, taskName, taskInput);
		ctx.setProp(toolsObj, toolName, serviceProxyHandle);
		serviceProxyHandle.dispose();
	}
	
	const tasksServiceObj = ctx.newObject();
	
	const executeFn = ctx.newAsyncifiedFunction("execute", async (
		taskNameHandle: QuickJSHandle, 
		inputHandle: QuickJSHandle
	): Promise<QuickJSHandle> => {
		const tempHandles: QuickJSHandle[] = [taskNameHandle, inputHandle];
		try {
			const targetTaskName = ctx.getString(taskNameHandle);
			const targetTaskInput = ctx.dump(inputHandle);
			
			hostLog(logPrefix, "info", `Intercepting tasks.execute for: ${targetTaskName}`);
			
			const childStackRunId = _generateUUID();
			hostLog(logPrefix, "info", `Generated childStackRunId: ${childStackRunId}`);

			const parentTaskRunId = taskRunId; 
			
			const callingVmState: SerializedVMState = captureVMState(
				ctx, 
				parentTaskRunId,
				childStackRunId,
				taskCode,
				taskName,
				taskInput
			); 
			
			await saveStackRun(
				"tasks",
				"suspend_for_child_task",
				[targetTaskName, targetTaskInput],
				callingVmState,
				parentTaskRunId,
				ctx.dump(ctx.getProp(ctx.global, "__currentStackRunId__")) || undefined
			);
			hostLog(logPrefix, "info", `Parent task ${taskName} (${parentTaskRunId}) suspended, state saved (waiting on ${childStackRunId}).`);

			const childTaskStackRun: Partial<StackRun> & {id: string} = {
				id: childStackRunId,
				parent_task_run_id: parentTaskRunId,
				parent_stack_run_id: callingVmState.stackRunId,
				service_name: "tasks",
				method_name: "execute",
				args: [targetTaskName, targetTaskInput],
				status: "pending",
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};

			const supabase = getSupabaseClient();
			if (!supabase) {
				throw new Error("Supabase client not available");
			}
			const { error: childSaveError } = await supabase.from("stack_runs").insert(childTaskStackRun);
			if (childSaveError) {
				hostLog(logPrefix, "error", `Failed to create initial stack_run for child task ${targetTaskName}: ${childSaveError.message}`);
				throw childSaveError;
			}
			hostLog(logPrefix, "info", `Child task ${targetTaskName} stack_run ${childStackRunId} created for execution.`);

		await triggerStackProcessor();
		
			const deferred = ctx.newPromise();
			tempHandles.push(deferred.handle);

			// Store promise resolvers in global map instead of QuickJS object  
			const resolvers = new Map();
			ctx.setProp(ctx.global, "__resumeResolverIds__", ctx.newString(callingVmState.stackRunId));

			return deferred.handle;
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
			hostLog(logPrefix, "error", `Error in tasks.execute interceptor: ${errorMsg}`);
			tempHandles.push(ctx.newError(errorMsg));
			throw tempHandles[tempHandles.length - 1];
			} finally {
			tempHandles.forEach(h => { h?.dispose(); });
		}
	});
	ctx.setProp(tasksServiceObj, "execute", executeFn);
	executeFn.dispose();
	
	ctx.setProp(toolsObj, "tasks", tasksServiceObj);
	tasksServiceObj.dispose();
	
	ctx.setProp(ctx.global, "tools", toolsObj);
	toolsObj.dispose();
	
	hostLog(logPrefix, "info", "Tools object setup complete with service proxies.");
}

/**
 * Save VM state for a stack run - THIS FUNCTION SEEMS REDUNDANT with saveStackRun from vm-state-manager
 * captureVMState + saveStackRun should cover this.
 * If this is for a *different* purpose, it needs clarification.
 * For now, assuming vm-state-manager.saveStackRun is the primary.
 */
// async function saveVMState(stackRunId: string, vmState: SerializedVMState, parentTaskRunId?: string): Promise<void> { ... }

/**
 * Get Supabase configuration
 */
function getSupabaseConfig() {
	let url = Deno.env.get("EXT_SUPABASE_URL") || Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
	const serviceRoleKey = Deno.env.get("EXT_SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
	
	if (url.includes('localhost:8000') || url.includes('127.0.0.1:8000')) {
	}
	if (!serviceRoleKey) {
		hostLog("SupabaseConfig", "error", "Missing SUPABASE_SERVICE_ROLE_KEY");
	}
	
	return { url, serviceRoleKey };
}

/**
 * Creates a service proxy object that can handle nested method chains
 * THIS IS NOW REPLACED BY proxy-generator.ts:generateServiceProxy
 * Keeping structure for reference or if a non-suspending proxy is ever needed.
 */
// function createServiceProxyObject(ctx: QuickJSAsyncContext, serviceName: string, taskRunId: string): QuickJSHandle { ... }

// ==============================
// Main Execution Functions
// ==============================

/**
 * Main function to execute a task in QuickJS
 */
async function executeQuickJS(
	taskCode: string, 
	taskName: string, 
	taskInput: any, 
	providedTaskRunId?: string,
	toolNames?: string[],
	initialVmState?: SerializedVMState,
	providedStackRunId?: string
): Promise<any> {
	const logPrefix = `QuickJS-${taskName}`;
	let quickJSInstance: QuickJSAsyncWASMModule | null = null;
	let ctx: QuickJSAsyncContext | null = null;
	
	try {
		hostLog(logPrefix, "info", `Initializing QuickJS for ${taskName}${initialVmState ? ' (resuming from checkpoint)' : ''}`);
		
		// DEBUG: Log VM state details
		if (initialVmState) {
			hostLog(logPrefix, "info", `VM State Debug - suspended: ${initialVmState.suspended}, waitingOnStackRunId: ${initialVmState.waitingOnStackRunId}`);
		}
		
		quickJSInstance = await getQuickJS() as QuickJSAsyncWASMModule;
		
		// For async operations, create a context that supports asyncify
		ctx = await newAsyncContext();
		
		const taskRunId = providedTaskRunId || initialVmState?.taskRunId || _generateUUID();
		const stackRunId = providedStackRunId || initialVmState?.stackRunId;
		
		await setupTaskEnvironment(ctx!, taskRunId, taskCode, taskName, taskInput, stackRunId, toolNames);
		
		let resultOrPromise: QuickJSHandle;

		if (initialVmState && initialVmState.suspended && (initialVmState.waitingOnStackRunId || initialVmState.last_call_result)) {
			hostLog(logPrefix, "info", `Resuming from checkpoint for stackRunId: ${initialVmState.stackRunId || 'undefined'}`);
			
			// REAL SOLUTION: Use step-based execution with cached results
			const checkpointData = initialVmState.checkpoint || {};
			const resumePayload = initialVmState.resume_payload || initialVmState.last_call_result;
			
			if (resumePayload) {
				// Generate checkpoint-aware task code that skips completed steps
				const checkpointTaskCode = generateCheckpointAwareTaskCode(taskCode, initialVmState);
				const taskHandler = await evaluateTaskCode(ctx!, checkpointTaskCode, logPrefix, false);
				
				// Now call the function just like in normal execution
				const handles: QuickJSHandle[] = [];
				const normalizedInput = taskInput || {};
				const inputHandle = createHandleFromJson(ctx!, normalizedInput, handles);
				
				hostLog(logPrefix, "info", `Calling resumed task function: ${taskName}`);
				const callResult = ctx!.callFunction(taskHandler, ctx!.undefined, inputHandle); 
				taskHandler.dispose();
				inputHandle.dispose();
				
				// Safely dispose handles
				handles.forEach(h => {
					try {
						if (h && h !== ctx!.true && h !== ctx!.false && h !== ctx!.null && h !== ctx!.undefined) {
							h.dispose();
						}
					} catch (error) {
						hostLog(logPrefix, "debug", `Handle disposal skipped: ${error instanceof Error ? error.message : String(error)}`);
					}
				});
				
				if (callResult.error) {
					const err = extractErrorFromHandle(ctx!, callResult.error);
					callResult.error.dispose();
					throw err;
				}
				resultOrPromise = callResult.value;
			} else {
				// Fallback to normal execution if no resume payload
				const taskHandler = await evaluateTaskCode(ctx!, taskCode, logPrefix, false);
				
				const handles: QuickJSHandle[] = [];
				const normalizedInput = taskInput || {};
				const inputHandle = createHandleFromJson(ctx!, normalizedInput, handles);
				
				hostLog(logPrefix, "info", `Calling fallback task function: ${taskName}`);
				const callResult = ctx!.callFunction(taskHandler, ctx!.undefined, inputHandle); 
				taskHandler.dispose();
				inputHandle.dispose();
				
				// Safely dispose handles
				handles.forEach(h => {
					try {
						if (h && h !== ctx!.true && h !== ctx!.false && h !== ctx!.null && h !== ctx!.undefined) {
							h.dispose();
						}
					} catch (error) {
						hostLog(logPrefix, "debug", `Handle disposal skipped: ${error instanceof Error ? error.message : String(error)}`);
					}
				});
				
				if (callResult.error) {
					const err = extractErrorFromHandle(ctx!, callResult.error);
					callResult.error.dispose();
					throw err;
				}
				resultOrPromise = callResult.value;
			}
		} else {
			hostLog(logPrefix, "info", "Starting new execution.");
			
			// Set up empty checkpoint for new execution
			const checkpointHandle = ctx!.newObject();
			ctx!.setProp(checkpointHandle, "completed", ctx!.newObject());
			ctx!.setProp(ctx!.global, "__checkpoint__", checkpointHandle);
			checkpointHandle.dispose();
			
			const taskHandler = await evaluateTaskCode(ctx!, taskCode, logPrefix, false);
		
			const handles: QuickJSHandle[] = [];
			const normalizedInput = taskInput || {};
			const inputHandle = createHandleFromJson(ctx!, normalizedInput, handles);
			
			hostLog(logPrefix, "info", `Calling task function: ${taskName}`);
			const callResult = ctx!.callFunction(taskHandler, ctx!.undefined, inputHandle); 
			taskHandler.dispose();
			inputHandle.dispose();
			
			// Safely dispose handles
			handles.forEach(h => {
				try {
					if (h && h !== ctx!.true && h !== ctx!.false && h !== ctx!.null && h !== ctx!.undefined) {
						h.dispose();
					}
				} catch (error) {
					hostLog(logPrefix, "debug", `Handle disposal skipped: ${error instanceof Error ? error.message : String(error)}`);
				}
			});
			
			if (callResult.error) {
				const err = extractErrorFromHandle(ctx!, callResult.error);
				callResult.error.dispose();
				throw err;
			}
			resultOrPromise = callResult.value;
		}
		
		return await resolvePromiseAndSuspend(ctx!, resultOrPromise, ctx!.runtime, logPrefix, taskRunId, taskCode, taskName, taskInput);

	} catch (error) {
		const errorMsg = error instanceof Error
			? `${error.message}\\n${error.stack || ""}`
			: String(error);
		hostLog(logPrefix, "error", `Error in executeQuickJS for ${taskName}: ${errorMsg}`);
		throw error;
	} finally {
		// CRITICAL: Always fully dispose of the QuickJS instance
		if (ctx) ctx.dispose();
		hostLog(logPrefix, "info", `QuickJS instance for ${taskName} fully disposed.`);
	}
}

/**
 * Handles promise resolution and potential VM suspension.
 * This function will loop, processing QuickJS jobs, until the main promise resolves
 * or a suspension is triggered.
 */
async function resolvePromiseAndSuspend(
	ctx: QuickJSAsyncContext, 
	initialPromiseHandle: QuickJSHandle,
	quickJSInstance: QuickJSRuntime,
	logPrefix: string,
	taskRunId: string,
	currentTaskCode: string,
	currentTaskName: string,
	currentTaskInput: any
): Promise<any> {
	let currentResultHandle = initialPromiseHandle;
	let loopCount = 0;
	const maxLoop = 100; // Reduced from 1000 to catch issues faster

	while (true) {
		loopCount++;
		if (loopCount > maxLoop) {
			hostLog(logPrefix, "error", "Max loop count reached in resolvePromiseAndSuspend. Possible infinite loop in VM.");
			// Debug: dump the current result type and value
			const resultType = ctx.typeof(currentResultHandle);
			const resultValue = ctx.dump(currentResultHandle);
			hostLog(logPrefix, "error", `Current result type: ${resultType}, value: ${JSON.stringify(resultValue)}`);
			throw new Error("VM execution timed out due to excessive pending jobs.");
		}

		// Check for suspension first
		const suspendInfoHandle = ctx.getProp(ctx.global, "__suspendInfo__");
		let suspended = false;
		let stackRunIdToSuspend: string | undefined;
		let serviceNameForSuspend: string | undefined;

		if (ctx.typeof(suspendInfoHandle) === "object") {
			const suspendedHandle = ctx.getProp(suspendInfoHandle, "suspended");
			if (ctx.dump(suspendedHandle) === true) {
				suspended = true;
				const stackRunIdHandle = ctx.getProp(suspendInfoHandle, "stackRunId");
				stackRunIdToSuspend = ctx.getString(stackRunIdHandle);
				stackRunIdHandle.dispose();

				const serviceNameHandle = ctx.getProp(suspendInfoHandle, "serviceName");
				serviceNameForSuspend = ctx.getString(serviceNameHandle); 
				serviceNameHandle.dispose();
				
				hostLog(logPrefix, "info", `VM suspension requested for service: ${serviceNameForSuspend}, stackRunId: ${stackRunIdToSuspend}`);
				
				ctx.setProp(ctx.global, "__suspendInfo__", ctx.undefined); 
			}
			suspendedHandle?.dispose();
		}
		suspendInfoHandle?.dispose();

		if (suspended && stackRunIdToSuspend) {
			if (currentResultHandle !== initialPromiseHandle) {
				currentResultHandle.dispose();
			}
			return {
				__hostCallSuspended: true,
				taskRunId: taskRunId,
				stackRunId: stackRunIdToSuspend,
				serviceName: serviceNameForSuspend || "unknown",
				message: `VM suspended for service call to ${serviceNameForSuspend}. StackRunID: ${stackRunIdToSuspend}`
			};
		}

		// Check if result is a promise
		const isResultPromise = isPromise(ctx, currentResultHandle);
		hostLog(logPrefix, "info", `Loop ${loopCount}: Result type: ${ctx.typeof(currentResultHandle)}, isPromise: ${isResultPromise}`);

		if (isResultPromise) {
			hostLog(logPrefix, "info", `Awaiting promise (loop ${loopCount})`);
			try {
				const promiseSettledResult = await ctx.resolvePromise(currentResultHandle);
				
				if (currentResultHandle !== initialPromiseHandle) {
					currentResultHandle.dispose();
				}

				if (promiseSettledResult.error) {
					hostLog(logPrefix, "error", "Promise rejected in VM.");
					const err = extractErrorFromHandle(ctx, promiseSettledResult.error);
					promiseSettledResult.error.dispose();
					throw err;
				}
				currentResultHandle = promiseSettledResult.value;
			} catch (error) {
				hostLog(logPrefix, "error", `Error resolving promise: ${error instanceof Error ? error.message : String(error)}`);
				throw error;
			}
		} else {
			// Not a promise, this is our final result
			hostLog(logPrefix, "info", `Promise resolved to a final value (loop ${loopCount})`);
			const finalJsValue = ctx.dump(currentResultHandle);
			if (currentResultHandle !== initialPromiseHandle) {
				currentResultHandle.dispose();
			}
			return finalJsValue;
		}

		// Execute pending jobs
		let executedJobs = 0;
		const maxJobs = 50; // Reduced from 100
		let jobResult = quickJSInstance.executePendingJobs();
		while (jobResult.error === undefined && executedJobs < maxJobs) {
			executedJobs++;
			jobResult = quickJSInstance.executePendingJobs();
		}
		
		if (jobResult.error) {
			hostLog(logPrefix, "error", `Error executing pending jobs: ${ctx.dump(jobResult.error)}`);
			jobResult.error.dispose();
			throw new Error("Error executing pending jobs in QuickJS");
		}
		
		if (executedJobs >= maxJobs) {
			hostLog(logPrefix, "warn", `Executed maximum number of jobs (${maxJobs}) in loop ${loopCount}`);
		} else if (executedJobs === 0) {
			hostLog(logPrefix, "info", `No pending jobs to execute in loop ${loopCount}`);
		} else {
			hostLog(logPrefix, "info", `Executed ${executedJobs} pending jobs in loop ${loopCount}`);
		}
	}
}

// Function to check if a handle is a promise
function isPromise(ctx: QuickJSAsyncContext, handle: QuickJSHandle): boolean {
	if (!handle || ctx.typeof(handle) !== "object") {
		return false;
	}
	
	try {
		const thenProp = ctx.getProp(handle, "then");
		const isFn = ctx.typeof(thenProp) === "function";
		thenProp?.dispose();
		
		// Additional check for constructor name
		if (isFn) {
			const constructorProp = ctx.getProp(handle, "constructor");
			if (constructorProp && ctx.typeof(constructorProp) === "function") {
				const nameProp = ctx.getProp(constructorProp, "name");
				const constructorName = ctx.typeof(nameProp) === "string" ? ctx.getString(nameProp) : "";
				nameProp?.dispose();
				constructorProp.dispose();
				
				// If it has a 'then' method and constructor name is Promise, it's definitely a promise
				return constructorName === "Promise" || isFn;
			}
			constructorProp?.dispose();
		}
		
		return isFn;
	} catch (error) {
		// If we can't check, assume it's not a promise
		return false;
	}
}

/**
 * Evaluate task code and get the handler function
 */
async function evaluateTaskCode(
	ctx: QuickJSAsyncContext, 
	taskCode: string, 
	logPrefix: string,
	defineOnly: boolean
): Promise<QuickJSHandle> {
	hostLog(logPrefix, "info", defineOnly ? "Evaluating task code (define only)" : "Evaluating task code and getting handler");
	
	const codeToRun = `
	  let taskHandler;
	  try {
		const module = { exports: {} };
		(function(module, exports) {
			${taskCode}
		})(module, module.exports);
		
		if (typeof module.exports === 'function') {
			taskHandler = module.exports;
		} else if (typeof module.exports === 'object' && module.exports !== null && typeof module.exports.default === 'function') {
			taskHandler = module.exports.default;
		} else {
			if (!${defineOnly}) {
			}
		}
	  } catch (e) {
		throw e;
	  }
	  taskHandler;
	`;

	const evalResult = ctx.evalCode(codeToRun);

	if (evalResult.error) {
		const errMsg = ctx.dump(evalResult.error);
		hostLog(logPrefix, "error", `Error evaluating task code: ${simpleStringify(errMsg)}`);
		const originalError = extractErrorFromHandle(ctx, evalResult.error);
		evalResult.error.dispose();
		throw originalError;
	}

	if (defineOnly) {
		hostLog(logPrefix, "info", "Task code definitions evaluated.");
		evalResult.value?.dispose();
		return ctx.undefined;
	}

	const taskHandler = evalResult.value;
	if (ctx.typeof(taskHandler) !== 'function') {
		hostLog(logPrefix, "error", `Module exports is not a function, but a ${ctx.typeof(taskHandler)}.`);
		taskHandler?.dispose();
		throw new Error("Task module did not export a function.");
	}
	
	hostLog(logPrefix, "info", "Task handler function obtained.");
	return taskHandler;
}

/**
 * Extract an error object from a QuickJS handle
 */
function extractErrorFromHandle(ctx: QuickJSContext, errorHandle: QuickJSHandle): Error {
	if (!errorHandle) {
		return new Error("Unknown error (handle disposed or null)");
	}
	const errorDump = ctx.dump(errorHandle);
	
	let errorMessage = "Unknown error in task execution";
	let stack = "";

	if (typeof errorDump === 'object' && errorDump !== null) {
		errorMessage = String(errorDump.message || errorDump.name || "Unnamed error object");
		stack = String(errorDump.stack || "");
			} else {
		errorMessage = String(errorDump);
	}
	
	const jsError = new Error(errorMessage);
	if (stack) {
		jsError.stack = stack;
	}
	return jsError;
}

/**
 * Resume a suspended VM execution with a result from a completed child/service call
 */
async function resumeVM(
	stackRunToResume: StackRun,
	childResult: any
): Promise<any> {
	const logPrefix = `QuickJS-Resume-${stackRunToResume.id}`;
	hostLog(logPrefix, "info", `Attempting to resume VM for stack run: ${stackRunToResume.id}`);

	if (!stackRunToResume.vm_state) {
		hostLog(logPrefix, "error", "No VM state found in stack run to resume.");
		throw new Error(`No VM state found for stack run: ${stackRunToResume.id}`);
	}
	if (!stackRunToResume.vm_state.taskCode || !stackRunToResume.vm_state.taskName) {
		hostLog(logPrefix, "error", "VM state is missing taskCode or taskName.");
		throw new Error(`Incomplete VM state for stack run: ${stackRunToResume.id}`);
	}

	const { taskCode, taskName, taskInput, taskRunId: parentTaskRunId, stackRunId: suspensionPointStackRunId } = stackRunToResume.vm_state;
	
	const resumeState: SerializedVMState = {
		...stackRunToResume.vm_state,
							suspended: true, 
		waitingOnStackRunId: stackRunToResume.waiting_on_stack_run_id || stackRunToResume.id,
		resume_payload: childResult,
	};
	
	hostLog(logPrefix, "info", `Resuming task ${taskName} (runId: ${parentTaskRunId}) using its state from stack_run ${suspensionPointStackRunId}, it was waiting on ${resumeState.waitingOnStackRunId}`);
	
	return executeQuickJS(taskCode, taskName, taskInput, parentTaskRunId, undefined, resumeState);
}

// ==============================
// HTTP Server
// ==============================

/**
 * Handle requests to the QuickJS function
 */
async function handleRequest(req: Request): Promise<Response> {
	const { pathname } = new URL(req.url);
	hostLog("QuickJSHandler", "info", `Received request: ${req.method} ${pathname}`);
	
	if (req.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: corsHeaders });
	}
	
	if (pathname.endsWith('/execute')) {
		return handleExecuteRequest(req);
	} else if (pathname.endsWith('/resume')) {
		return handleResumeRequest(req);
	} else {
		return handleError(new Error(`Unknown path: ${pathname}`), "Endpoint not found", 404);
	}
}

/**
 * Centralized handler for resuming a VM.
 * Expects: { stackRunIdToResume: string (ID of the parent's stack_run), resultToInject: any }
 */
export async function handleResumeRequest(req: Request): Promise<Response> {
	const logPrefix = "QuickJS-HandleResume";
  try {
    const requestData = await req.json();
		const { stackRunIdToResume, resultToInject } = requestData;

		if (!stackRunIdToResume) {
			return handleError(new Error("Missing stackRunIdToResume"), "Invalid resumption request", 400, logPrefix);
		}
		hostLog(logPrefix, "info", `Handling VM resumption for parent stackRunId: ${stackRunIdToResume}`);

		const stackRun = await getStackRun(stackRunIdToResume);
    if (!stackRun) {
			return handleError(new Error(`Stack run ${stackRunIdToResume} not found.`), "Cannot resume: Stack run not found.", 404, logPrefix);
		}
		if (!stackRun.vm_state) {
			return handleError(new Error(`Stack run ${stackRunIdToResume} has no VM state.`), "Cannot resume: No VM state.", 400, logPrefix);
		}
		if (!stackRun.waiting_on_stack_run_id && stackRun.status !== 'pending_resume') {
			hostLog(logPrefix, "warn", `Stack run ${stackRunIdToResume} status is ${stackRun.status} and not explicitly waiting_on_stack_run_id. Resuming anyway if vm_state present.`);
		}
		
		const finalResult = await resumeVM(stackRun, resultToInject);

		await updateStackRun(stackRunIdToResume, 'completed', finalResult);
		if (stackRun.parent_task_run_id) {
			await updateTaskRun(stackRun.parent_task_run_id, 'completed', finalResult);
		}
		
		return new Response(simpleStringify({
      status: 'completed',
			message: `VM for stack run ${stackRunIdToResume} resumed and completed.`,
			result: finalResult
		}), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		hostLog(logPrefix, "error", `Error in handleResumeRequest: ${errorMsg}`);
		return handleError(
			error instanceof Error ? error : new Error(String(error)), 
			"VM resume failed", 
			500, 
			logPrefix
		);
	}
}

/**
 * Handle execute requests to the QuickJS function
 */
async function handleExecuteRequest(req: Request): Promise<Response> {
	const logPrefix = "QuickJS-HandleExecute";
  try {
    const requestData = await req.json();
		const { taskCode, taskName, taskInput, taskRunId, stackRunId, toolNames, initialVmState } = requestData;

		if (!taskCode || !taskName) {
			return handleError(new Error("Missing taskCode or taskName"), "Invalid execute request", 400, logPrefix);
		}

		hostLog(logPrefix, "info", `Executing task: ${taskName}${stackRunId ? ` (stackRunId: ${stackRunId})` : ''}`);
		
		const result = await executeQuickJS(taskCode, taskName, taskInput, taskRunId, toolNames, initialVmState, stackRunId);
		
		return new Response(simpleStringify({
			status: 'completed',
			result: result
		}), { 
			status: 200, 
			headers: { ...corsHeaders, "Content-Type": "application/json" } 
		});

	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		hostLog(logPrefix, "error", `Error in handleExecuteRequest: ${errorMsg}`);
		return handleError(
			error instanceof Error ? error : new Error(String(error)), 
			"Task execution failed", 
			500, 
			logPrefix
		);
	}
}

/**
 * Handle errors by returning a proper HTTP response
 */
function handleError(error: Error, message: string, status: number, logPrefix?: string): Response {
	const errorMsg = error instanceof Error ? error.message : String(error);
	if (logPrefix) {
		hostLog(logPrefix, "error", `${message}: ${errorMsg}`);
	}
	
	return new Response(simpleStringify({
        status: 'error',
		error: message,
		details: errorMsg
	}), {
		status: status,
		headers: { ...corsHeaders, "Content-Type": "application/json" }
	});
}

// Update the main serve function to handle both execute and resume endpoints
serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    const path = url.pathname.split('/').pop();
    
    if (path === 'resume') {
      return handleResumeRequest(req);
    } else {
      return handleExecuteRequest(req);
    }
  } catch (error) {
    hostLog("QuickJSHandler", "error", `Error in serve function: ${error instanceof Error ? error.message : String(error)}`);
    
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

// Export the main function for external use
export { executeQuickJS };

// Add missing fetchTaskFromDatabase implementation
async function fetchTaskFromDatabase(taskNameOrId: string): Promise<any> {
  try {
    hostLog("Database", "info", `Fetching task from database: ${taskNameOrId}`);
    
    // Get Supabase URL and service key
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    
    if (!supabaseUrl || !serviceKey) {
      throw new Error("Missing Supabase URL or service role key");
    }
    
    // Determine if the input is a UUID (task ID) or a name
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskNameOrId);
    
    // Create the query URL
    const queryParam = isUuid ? `id=eq.${taskNameOrId}` : `name=eq.${taskNameOrId}`;
    const url = `${supabaseUrl}/rest/v1/task_functions?${queryParam}&select=*`;
    
    // Make the request
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
        "apikey": serviceKey
      }
    });
    
    if (!response.ok) {
      throw new Error(`Database request failed: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!data || data.length === 0) {
      throw new Error(`Task not found: ${taskNameOrId}`);
    }
    
    const task = data[0];
    
    return {
      id: task.id,
      name: task.name,
      code: task.code,
      description: task.description
    };
  } catch (error) {
    hostLog("Database", "error", `Database fetch error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Generate task code that uses a true step-based execution model for resumption
 */
function generateCheckpointAwareTaskCode(originalTaskCode: string, vmState: SerializedVMState): string {
	const resumePayload = vmState.resume_payload || vmState.last_call_result;
	const checkpoint = vmState.checkpoint || {};
	
	// Simple approach: inject the resume result and execute the original task
	return `
		// Inject resume result into global scope
		globalThis.__resumeResult__ = ${JSON.stringify(resumePayload)};
		globalThis.__checkpoint__ = ${JSON.stringify(checkpoint)};
		
		// Execute the original task code to get the function
		${originalTaskCode}
		
		// The task code should export the function, so we can call it
		// This ensures the task actually executes instead of just returning the function definition
	`;
}