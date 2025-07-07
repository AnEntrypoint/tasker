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
	parentStackRunId?: string,
	taskCode?: string,
	taskName?: string
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
				taskCode: taskCode || "",
				taskName: taskName || serviceName,
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
						if (ctx.typeof(arg) === 'number') return String(ctx.getNumber(arg));
						if (ctx.typeof(arg) === 'boolean') return String(ctx.dump(arg));
						if (ctx.typeof(arg) === 'undefined') return 'undefined';
						if (ctx.typeof(arg) === 'null') return 'null';
						
						// For objects, be more careful with dump
						try {
							const dumped = ctx.dump(arg);
							return typeof dumped === 'string' ? dumped : simpleStringify(dumped);
						} catch (dumpError) {
							return `[Object dump failed: ${dumpError instanceof Error ? dumpError.message : String(dumpError)}]`;
						}
					} catch (e) {
						return `[Unloggable Object: ${e instanceof Error ? e.message : String(e)}]`;
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
	const callHostToolFn = ctx.newFunction("__callHostTool__", (
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
			
			hostLog("HostToolSuspend", "info", `🚨 TRIGGERING SUSPENSION for ${serviceName}.${methodName}`);
			hostLog("HostToolSuspend", "info", `Args: ${JSON.stringify(args)}`);
			
			const childStackRunId = _generateUUID();
			
			// Set up the __pendingServiceCall__ global for resolvePromiseAndSuspend to pick up
			const pendingCallObj = ctx.newObject();
			ctx.setProp(pendingCallObj, "stackRunId", ctx.newString(childStackRunId));
			ctx.setProp(pendingCallObj, "service", ctx.newString(serviceName));
			ctx.setProp(pendingCallObj, "method", ctx.newString(methodName));
			const argsHandleForPending = createHandleFromJson(ctx, args, []);
			ctx.setProp(pendingCallObj, "args", argsHandleForPending);
			argsHandleForPending.dispose();
			ctx.setProp(ctx.global, "__pendingServiceCall__", pendingCallObj);
			pendingCallObj.dispose();

			hostLog("HostToolSuspend", "info", `🔄 Set __pendingServiceCall__ for ${serviceName}.${methodName}. ChildStackRunID: ${childStackRunId}. VM will suspend.`);

			// FINAL WORKING FIX: Create suspension marker as QuickJS handle for proper type handling
			const suspensionMarkerObj = ctx.newObject();
			ctx.setProp(suspensionMarkerObj, "__vmSuspension__", ctx.newString("true"));
			ctx.setProp(suspensionMarkerObj, "stackRunId", ctx.newString(childStackRunId));
			ctx.setProp(suspensionMarkerObj, "reason", ctx.newString("host_service_call"));
			
			hostLog("HostToolSuspend", "info", `📤 Returning suspension marker as QuickJS handle`);
			
			return suspensionMarkerObj; // Return QuickJS handle - properly typed
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			hostLog("HostToolSuspend", "error", `Error setting up suspension: ${errorMsg}`);
			
			const qjsError = ctx.newError(errorMsg);
			const deferred = ctx.newPromise();
			deferred.reject(qjsError);
			return deferred.handle;
		} finally {
			handles.forEach(h => { 
				try {
					h?.dispose();
				} catch (e) {
					// Ignore disposal errors
				}
			});
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
		
		// Use standard service proxy for all services including GAPI to avoid lifetime issues
		try {
			if (toolName === "gapi") {
				hostLog(logPrefix, "info", `Creating GAPI service proxy using standard service proxy method...`);
			}
			const serviceProxyHandle = createServiceProxyObject(ctx, toolName, taskRunId);
			ctx.setProp(toolsObj, toolName, serviceProxyHandle);
			serviceProxyHandle.dispose();
			hostLog(logPrefix, "info", `Successfully added ${toolName} service proxy`);
		} catch (serviceError) {
			hostLog(logPrefix, "error", `Failed to create ${toolName} proxy: ${serviceError instanceof Error ? serviceError.message : String(serviceError)}`);
			// Continue without this service proxy
		}
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

			const childVmState: SerializedVMState = {
				stackRunId: childStackRunId,
				taskRunId: parentTaskRunId,
				suspended: false,
				suspendedAt: new Date().toISOString(),
				taskCode: "", // Will be populated by task execution
				taskName: targetTaskName,
				taskInput: targetTaskInput,
				parentStackRunId: callingVmState.stackRunId
			};

			const childTaskStackRun: Partial<StackRun> & {id: string} = {
				id: childStackRunId,
				parent_task_run_id: parentTaskRunId,
				parent_stack_run_id: callingVmState.stackRunId,
				service_name: "tasks",
				method_name: "execute",
				args: [targetTaskName, targetTaskInput],
				status: "pending",
				vm_state: childVmState,
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
	
	// Debug: verify tools object was set correctly
	const toolsVerifyHandle = ctx.getProp(ctx.global, "tools");
	hostLog(logPrefix, "info", `Tools object verification: ${ctx.typeof(toolsVerifyHandle)}`);
	if (ctx.typeof(toolsVerifyHandle) === 'object') {
		const gapiVerifyHandle = ctx.getProp(toolsVerifyHandle, "gapi");
		hostLog(logPrefix, "info", `Tools.gapi verification: ${ctx.typeof(gapiVerifyHandle)}`);
		gapiVerifyHandle.dispose();
	}
	toolsVerifyHandle.dispose();
	
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
 * Used for non-GAPI services (database, keystore, openai, websearch)
 */
function createServiceProxyObject(ctx: QuickJSAsyncContext, serviceName: string, taskRunId: string): QuickJSHandle {
	const logPrefix = `ServiceProxy-${serviceName}-${taskRunId}`;
	hostLog(logPrefix, "info", `Creating new dynamic suspension-aware proxy for service: ${serviceName}`);

	// This function will be called recursively to build up the proxy chain (e.g., tools.database.from(...).select(...))
	function buildProxy(methodChain: string[]): QuickJSHandle {
		const proxyTarget = ctx.newFunction(methodChain.join('.') || serviceName, (...argHandles: QuickJSHandle[]) => {
			// This is when a method in the chain is actually CALLED (e.g. select(columns) or insert(data))
			const finalArgs = argHandles.map(h => ctx.dump(h));
			const finalMethodName = methodChain.join('.');
			hostLog(logPrefix, "info", `🚨 CRITICAL: Service method ${serviceName}.${finalMethodName} invoked with args:`, finalArgs);
			hostLog(logPrefix, "info", `🚨 CRITICAL: This proves the proxy function is being called and should trigger suspension`);

			const childStackRunId = _generateUUID();

			// Set up the __pendingServiceCall__ global for resolvePromiseAndSuspend to pick up
			const pendingCallObj = ctx.newObject();
			ctx.setProp(pendingCallObj, "stackRunId", ctx.newString(childStackRunId));
			ctx.setProp(pendingCallObj, "service", ctx.newString(serviceName));
			ctx.setProp(pendingCallObj, "method", ctx.newString(finalMethodName)); // Full method chain
			const argsHandle = createHandleFromJson(ctx, finalArgs, []); // Handles are managed by createHandleFromJson
			ctx.setProp(pendingCallObj, "args", argsHandle);
			argsHandle.dispose(); // Dispose the args array handle itself after setting it
			// taskRunId is already available in resolvePromiseAndSuspend
			ctx.setProp(ctx.global, "__pendingServiceCall__", pendingCallObj);
			pendingCallObj.dispose();

			hostLog(logPrefix, "info", `Set __pendingServiceCall__ for ${serviceName}.${finalMethodName}. ChildStackRunID: ${childStackRunId}. VM will suspend.`);

			// Return a promise that will resolve to a suspension marker
			// This ensures that await properly triggers the suspension handling
			const deferred = ctx.newPromise();
			
			// Set the suspension marker as the promise result
			const suspensionMarker = ctx.newObject();
			ctx.setProp(suspensionMarker, "__vmSuspension__", ctx.true);
			ctx.setProp(suspensionMarker, "stackRunId", ctx.newString(childStackRunId));
			ctx.setProp(suspensionMarker, "reason", ctx.newString("host_service_call"));
			
			// Resolve the promise with the suspension marker immediately
			deferred.resolve(suspensionMarker);
			suspensionMarker.dispose();
			
			return deferred.handle; // This will be awaited and caught by resolvePromiseAndSuspend
		});

		return new Proxy(proxyTarget, {
			get: (target, prop, receiver) => {
				if (typeof prop === 'symbol') { // Handle symbols like Symbol.toPrimitive if necessary
					return Reflect.get(target, prop, receiver);
				}
				const propName = String(prop);
				hostLog(logPrefix, "info", `Proxy GET: ${serviceName}.${[...methodChain, propName].join('.')} - this shows tools are being accessed`);
				
				// If it's a call to .then, .catch, .finally (promise-like behavior), 
				// this means the user is trying to await the result of the proxy function call.
				// We should not return these properties on the proxy itself, only on the result
				// of calling the proxy function.
				if (propName === 'then' || propName === 'catch' || propName === 'finally') {
					hostLog(logPrefix, "info", `Promise-like property ${propName} accessed on proxy - returning undefined to allow proper execution`);
					return undefined; // Return JavaScript undefined, not ctx.undefined
				}

				// Recursively build the proxy for the next segment of the method chain
				return buildProxy([...methodChain, propName]);
			},
			// apply: is handled by the proxyTarget function itself when the chain is called.
		});
	}

	return buildProxy([]); // Start with an empty method chain for the service root
}

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
		
		hostLog(logPrefix, "debug", `Step 1: Getting QuickJS instance...`);
		quickJSInstance = await getQuickJS() as QuickJSAsyncWASMModule;
		hostLog(logPrefix, "debug", `Step 2: QuickJS instance obtained successfully`);
		
		// For async operations, create a context that supports asyncify
		hostLog(logPrefix, "debug", `Step 3: Creating async context...`);
		ctx = await newAsyncContext();
		hostLog(logPrefix, "debug", `Step 4: Async context created successfully`);
		
		const taskRunId = providedTaskRunId || initialVmState?.taskRunId || _generateUUID();
		const stackRunId = providedStackRunId || initialVmState?.stackRunId;
		
		hostLog(logPrefix, "debug", `Step 5: Setting up task environment...`);
		try {
			await setupTaskEnvironment(ctx!, taskRunId, taskCode, taskName, taskInput, stackRunId, toolNames);
			hostLog(logPrefix, "debug", `Step 6: Task environment setup complete`);
		} catch (setupError) {
			hostLog(logPrefix, "error", `Setup environment failed: ${setupError instanceof Error ? setupError.message : String(setupError)}`);
			throw setupError;
		}
		
		let resultOrPromise: QuickJSHandle;

		if (initialVmState && (initialVmState.waitingOnStackRunId || initialVmState.last_call_result || initialVmState.resume_payload)) {
			hostLog(logPrefix, "info", `Resuming from checkpoint for stackRunId: ${initialVmState.stackRunId || 'undefined'}`);
			
			// FIX: Use the resume payload to inject cached results
			const resumePayload = initialVmState.resume_payload || initialVmState.last_call_result;
			
			if (resumePayload) {
				hostLog(logPrefix, "info", `Injecting resume payload and continuing execution`);
				
				// CRITICAL FIX: Properly inject the resume result for the task's state management
				const resumeResultHandle = createHandleFromJson(ctx!, resumePayload, []);
				ctx!.setProp(ctx!.global, "__resumeResult__", resumeResultHandle);
				resumeResultHandle.dispose();
				
				// CRITICAL FIX: Determine the call type from the VM state and inject it
				let lastCallType = "unknown";
				const waitingStackRunId = initialVmState.waitingOnStackRunId || initialVmState.stackRunId;
				
				// Try to determine call type from the resume payload or method name
				if (resumePayload && typeof resumePayload === 'object') {
					if (resumePayload.domains) {
						lastCallType = "domains";
						hostLog(logPrefix, "info", `Detected domains.list result, setting lastCallType to "domains"`);
					} else if (resumePayload.users) {
						lastCallType = "users";
						hostLog(logPrefix, "info", `Detected users.list result, setting lastCallType to "users"`);
					} else if (resumePayload.messages) {
						lastCallType = "gmail";
						hostLog(logPrefix, "info", `Detected gmail search result, setting lastCallType to "gmail"`);
					}
				}
				
				const lastCallTypeHandle = ctx!.newString(lastCallType);
				ctx!.setProp(ctx!.global, "__lastCallType__", lastCallTypeHandle);
				lastCallTypeHandle.dispose();
				
				// CRITICAL FIX: Restore the actual checkpoint from VM state instead of creating empty one
				hostLog(logPrefix, "info", `DEBUG: initialVmState exists: ${!!initialVmState}`);
				if (initialVmState) {
					hostLog(logPrefix, "info", `DEBUG: initialVmState keys: ${Object.keys(initialVmState)}`);
					hostLog(logPrefix, "info", `DEBUG: initialVmState.checkpoint exists: ${!!(initialVmState as any).checkpoint}`);
					if ((initialVmState as any).checkpoint) {
						hostLog(logPrefix, "info", `DEBUG: checkpoint type: ${typeof (initialVmState as any).checkpoint}`);
					}
				}
				
				if (initialVmState && (initialVmState as any).checkpoint) {
					try {
						const checkpoint = (initialVmState as any).checkpoint;
						hostLog(logPrefix, "info", `Restoring checkpoint from initialVmState.checkpoint`);
						hostLog(logPrefix, "info", `Checkpoint data preview: ${JSON.stringify(checkpoint).substring(0, 200)}...`);
						
						// Create the checkpoint object in the VM context
						const checkpointHandle = createHandleFromJson(ctx!, checkpoint, []);
						ctx!.setProp(ctx!.global, "__checkpoint__", checkpointHandle);
						checkpointHandle.dispose();
						
						hostLog(logPrefix, "info", `Successfully restored checkpoint from VM state`);
					} catch (error) {
						hostLog(logPrefix, "warn", `Failed to restore checkpoint from VM state: ${(error as Error).message}`);
						// Fallback to empty checkpoint
						const checkpointHandle = ctx!.newObject();
						ctx!.setProp(checkpointHandle, "completed", ctx!.newObject());
						ctx!.setProp(ctx!.global, "__checkpoint__", checkpointHandle);
						checkpointHandle.dispose();
						hostLog(logPrefix, "info", `Created empty checkpoint (fallback after restore failure)`);
					}
				} else {
					// Set up empty checkpoint for new execution (only when no VM state)
					const checkpointHandle = ctx!.newObject();
					ctx!.setProp(checkpointHandle, "completed", ctx!.newObject());
					ctx!.setProp(ctx!.global, "__checkpoint__", checkpointHandle);
					checkpointHandle.dispose();
					hostLog(logPrefix, "info", `Created empty checkpoint (new execution)`);
				}
				
				// CRITICAL FIX: Also inject proper cache results for the service proxy
				// This ensures that when the task tries to call the same service again, it gets the cached result
				if (resumePayload && typeof resumePayload === 'object') {
					if (resumePayload.domains) {
						// Cache the domains.list result
						const cacheKey = `gapi_admin_domains_list_${taskRunId}`;
						const domainsResultHandle = createHandleFromJson(ctx!, resumePayload, []);
						ctx!.setProp(ctx!.global, `__cache_${cacheKey}__`, domainsResultHandle);
						domainsResultHandle.dispose();
						hostLog(logPrefix, "info", `Cached domains.list result for key: ${cacheKey}`);
					} else if (resumePayload.users) {
						// Cache the users.list result
						const cacheKey = `gapi_admin_directory_users_list_${taskRunId}`;
						const usersResultHandle = createHandleFromJson(ctx!, resumePayload, []);
						ctx!.setProp(ctx!.global, `__cache_${cacheKey}__`, usersResultHandle);
						usersResultHandle.dispose();
						hostLog(logPrefix, "info", `Cached directory.users.list result for key: ${cacheKey}`);
						
						// CRITICAL FIX: Also restore domains cache if task needs it 
						// During users.list resumption, the domains cache might be needed by the task
						if (initialVmState && (initialVmState as any).vm_state) {
							try {
								const vmState = typeof (initialVmState as any).vm_state === 'string' ? 
									JSON.parse((initialVmState as any).vm_state) : (initialVmState as any).vm_state;
								
								// Look for domains cache in the checkpoint or VM state
								const checkpoint = vmState.globalThis?.__checkpoint__;
								if (checkpoint && checkpoint.domainsCache && checkpoint.domainsCache.domains) {
									hostLog(logPrefix, "info", `Restoring domains cache from checkpoint during users resumption`);
									const domainsCacheKey = `gapi_admin_domains_list_${taskRunId}`;
									const domainsCacheHandle = createHandleFromJson(ctx!, checkpoint.domainsCache, []);
									ctx!.setProp(ctx!.global, `__cache_${domainsCacheKey}__`, domainsCacheHandle);
									domainsCacheHandle.dispose();
									hostLog(logPrefix, "info", `Restored domains cache for key: ${domainsCacheKey}`);
								}
							} catch (error) {
								hostLog(logPrefix, "warn", `Failed to restore domains cache during users resumption: ${(error as Error).message}`);
							}
						}
					} else if (resumePayload.messages) {
						// Cache the gmail messages result
						const cacheKey = `gapi_gmail_users_messages_list_${taskRunId}`;
						const messagesResultHandle = createHandleFromJson(ctx!, resumePayload, []);
						ctx!.setProp(ctx!.global, `__cache_${cacheKey}__`, messagesResultHandle);
						messagesResultHandle.dispose();
						hostLog(logPrefix, "info", `Cached gmail.messages.list result for key: ${cacheKey}`);
						
						// CRITICAL FIX: Also restore domains and users caches during Gmail resumption
						if (initialVmState && (initialVmState as any).vm_state) {
							try {
								const vmState = typeof (initialVmState as any).vm_state === 'string' ? 
									JSON.parse((initialVmState as any).vm_state) : (initialVmState as any).vm_state;
								
								const checkpoint = vmState.globalThis?.__checkpoint__;
								if (checkpoint) {
									// Restore domains cache
									if (checkpoint.domainsCache && checkpoint.domainsCache.domains) {
										const domainsCacheKey = `gapi_admin_domains_list_${taskRunId}`;
										const domainsCacheHandle = createHandleFromJson(ctx!, checkpoint.domainsCache, []);
										ctx!.setProp(ctx!.global, `__cache_${domainsCacheKey}__`, domainsCacheHandle);
										domainsCacheHandle.dispose();
										hostLog(logPrefix, "info", `Restored domains cache during Gmail resumption`);
									}
									
									// Restore users caches
									if (checkpoint.usersCache) {
										for (const [domainName, usersData] of Object.entries(checkpoint.usersCache)) {
											const usersCacheKey = `gapi_admin_directory_users_list_${taskRunId}_${JSON.stringify([{domain: domainName}])}`;
											const usersCacheHandle = createHandleFromJson(ctx!, {users: usersData}, []);
											ctx!.setProp(ctx!.global, `__cache_${usersCacheKey}__`, usersCacheHandle);
											usersCacheHandle.dispose();
											hostLog(logPrefix, "info", `Restored users cache for domain: ${domainName}`);
										}
									}
								}
	} catch (error) {
								hostLog(logPrefix, "warn", `Failed to restore caches during Gmail resumption: ${(error as Error).message}`);
							}
						}
					}
				}
				
				// Now execute the task normally - it should find the resume state and continue
				const taskHandler = await evaluateTaskCode(ctx!, taskCode, logPrefix, false);
				
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
				hostLog(logPrefix, "info", `No resume payload found, executing normally`);
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
		let errorMsg: string;
		try {
			errorMsg = error instanceof Error
				? `${error.message}${error.stack ? '\n' + error.stack : ""}`
				: String(error);
		} catch (stringifyError) {
			// If we can't even convert the error to string, there's a serious issue
			errorMsg = "Error occurred but could not be stringified (possible object conversion issue)";
		}
		hostLog(logPrefix, "error", `Error in executeQuickJS for ${taskName}: ${errorMsg}`);
		throw error;
	} finally {
		// CRITICAL: Always fully dispose of the QuickJS instance
		try {
			if (ctx) {
				ctx.dispose();
				hostLog(logPrefix, "info", `QuickJS instance for ${taskName} fully disposed.`);
			}
		} catch (disposeError) {
			hostLog(logPrefix, "warn", `Error disposing QuickJS context: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}`);
		}
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
	const maxLoop = 200; 

	const currentQjsStackRunIdHandle = ctx.getProp(ctx.global, "__currentStackRunId");
	const currentQjsStackRunId = ctx.typeof(currentQjsStackRunIdHandle) === "string" ? ctx.getString(currentQjsStackRunIdHandle) : undefined;
	currentQjsStackRunIdHandle?.dispose();

	if (!currentQjsStackRunId) {
		hostLog(logPrefix, "error", "CRITICAL: __currentStackRunId is not available in VM global scope for suspension.");
		throw new Error("Missing __currentStackRunId, cannot correctly suspend VM.");
	}

	while (true) {
		loopCount++;
		if (loopCount > maxLoop) {
			hostLog(logPrefix, "error", "Max loop count reached in resolvePromiseAndSuspend. Possible infinite loop or too many chained promises in VM.");
			const resultType = ctx.typeof(currentResultHandle);
			let resultValue: any;
			try {
				resultValue = ctx.dump(currentResultHandle);
			} catch (dumpError) {
				resultValue = `[Dump failed: ${dumpError instanceof Error ? dumpError.message : String(dumpError)}]`;
			}
			hostLog(logPrefix, "error", `Current result type: ${resultType}, value: ${simpleStringify(resultValue)}`);
			throw new Error("VM execution timed out due to excessive pending jobs or deep promise chain.");
		}

		// Function to check for suspension markers - called after promise resolution
		function checkForSuspension(resultHandle: QuickJSHandle) {
			let suspended = false;
			let childStackRunIdForHostCall: string | undefined; 
			let serviceNameForHostCall: string | undefined;
			let methodNameForHostCall: string | undefined;
			let argsForHostCall: any[] | undefined;

			// DEBUG: Log what we're checking
			hostLog(logPrefix, "debug", `checkForSuspension: result type = ${ctx.typeof(resultHandle)}`);
			
			if (ctx.typeof(resultHandle) === "object") {
				const vmSuspensionHandle = ctx.getProp(resultHandle, "__vmSuspension__");
				const vmSuspensionValue = ctx.dump(vmSuspensionHandle);
				hostLog(logPrefix, "debug", `checkForSuspension: __vmSuspension__ = ${vmSuspensionValue}`);
				
				if (vmSuspensionValue === true || vmSuspensionValue === "true") {
					suspended = true;
					const stackRunIdHandle = ctx.getProp(resultHandle, "stackRunId"); 
					childStackRunIdForHostCall = ctx.getString(stackRunIdHandle);
					stackRunIdHandle.dispose();

					const pendingCallHandle = ctx.getProp(ctx.global, "__pendingServiceCall__");
					if (ctx.typeof(pendingCallHandle) === "object") {
						const pendingCall = ctx.dump(pendingCallHandle);
						serviceNameForHostCall = pendingCall.service;
						methodNameForHostCall = pendingCall.method;
						argsForHostCall = pendingCall.args;
						hostLog(logPrefix, "info", `VM suspension marker detected. Pending call: ${serviceNameForHostCall}.${methodNameForHostCall}, ChildStackRunID: ${childStackRunIdForHostCall}`);
						ctx.setProp(ctx.global, "__pendingServiceCall__", ctx.undefined); 
					}
					pendingCallHandle?.dispose();
				}
				vmSuspensionHandle?.dispose();
			}

			if (!suspended) {
				const suspendInfoGlobalHandle = ctx.getProp(ctx.global, "__suspendInfo__");
				if (ctx.typeof(suspendInfoGlobalHandle) === "object") {
					const suspendedFlagHandle = ctx.getProp(suspendInfoGlobalHandle, "suspended");
					if (ctx.dump(suspendedFlagHandle) === true) {
						suspended = true;
						const stackRunIdHandle = ctx.getProp(suspendInfoGlobalHandle, "stackRunId"); 
						childStackRunIdForHostCall = ctx.getString(stackRunIdHandle);
						stackRunIdHandle.dispose();

						const serviceNameHandle = ctx.getProp(suspendInfoGlobalHandle, "serviceName");
						serviceNameForHostCall = ctx.getString(serviceNameHandle); 
						serviceNameHandle.dispose();

						const methodHandle = ctx.getProp(suspendInfoGlobalHandle, "method");
						methodNameForHostCall = ctx.getString(methodHandle);
						methodHandle.dispose();

						const argsHandle = ctx.getProp(suspendInfoGlobalHandle, "args");
						argsForHostCall = ctx.dump(argsHandle);
						argsHandle.dispose();
						
						hostLog(logPrefix, "info", `VM suspension via __suspendInfo__. Call: ${serviceNameForHostCall}.${methodNameForHostCall}, ChildStackRunID: ${childStackRunIdForHostCall}`);
						ctx.setProp(ctx.global, "__suspendInfo__", ctx.undefined); 
					}
					suspendedFlagHandle?.dispose();
				}
				suspendInfoGlobalHandle?.dispose();
			}

			return { suspended, childStackRunIdForHostCall, serviceNameForHostCall, methodNameForHostCall, argsForHostCall };
		}

		// CRITICAL FIX: Check for suspension markers FIRST, before promise detection
		// This prevents suspension markers from being incorrectly processed as promises
		const prePromiseCheckSuspension = checkForSuspension(currentResultHandle);
		if (prePromiseCheckSuspension.suspended && prePromiseCheckSuspension.childStackRunIdForHostCall && prePromiseCheckSuspension.serviceNameForHostCall && prePromiseCheckSuspension.methodNameForHostCall && prePromiseCheckSuspension.argsForHostCall) {
			hostLog(logPrefix, "info", `🚨 PRE-PROMISE SUSPENSION DETECTED for ${prePromiseCheckSuspension.serviceNameForHostCall}.${prePromiseCheckSuspension.methodNameForHostCall}`);
			
			// Save suspension immediately - identical to non-promise suspension path
			const parentOfCurrentQjsRunHandle = ctx.getProp(ctx.global, "__parentStackRunId__");
			const parentOfCurrentQjsRun = ctx.typeof(parentOfCurrentQjsRunHandle) === 'string' ? ctx.getString(parentOfCurrentQjsRunHandle) : undefined;
			parentOfCurrentQjsRunHandle?.dispose();

			const capturedVmState: SerializedVMState = captureVMState(
				ctx, 
				taskRunId,
				prePromiseCheckSuspension.childStackRunIdForHostCall,
				currentTaskCode,
				currentTaskName,
				currentTaskInput
			);

			await saveStackRun(
				prePromiseCheckSuspension.serviceNameForHostCall,
				prePromiseCheckSuspension.methodNameForHostCall,
				prePromiseCheckSuspension.argsForHostCall,
				capturedVmState,
				taskRunId,
				currentQjsStackRunId
			);

			await updateStackRun( 
				currentQjsStackRunId,
				'suspended_waiting_child',
				undefined,
				undefined,
				capturedVmState
			);

			hostLog(logPrefix, "info", `✅ Pre-promise suspension complete. VM state saved.`);

			if (currentResultHandle && currentResultHandle !== initialPromiseHandle) {
				currentResultHandle.dispose();
			}
			
			return { 
				__hostCallSuspended: true,
				taskRunId: taskRunId, 
				stackRunId: prePromiseCheckSuspension.childStackRunIdForHostCall, 
				serviceName: prePromiseCheckSuspension.serviceNameForHostCall,
				message: `VM suspended for service call to ${prePromiseCheckSuspension.serviceNameForHostCall}. Child StackRunID: ${prePromiseCheckSuspension.childStackRunIdForHostCall}`
			};
		}

		const isResultPromise = isPromise(ctx, currentResultHandle);
		hostLog(logPrefix, "debug", `Loop ${loopCount}: Result type: ${ctx.typeof(currentResultHandle)}, isPromise: ${isResultPromise}`);

		// Check for non-promise results or immediate suspension markers
		if (!isResultPromise) {
			// Check for immediate suspension in non-promise results
			const immediateSuspensionResult = checkForSuspension(currentResultHandle);
			if (immediateSuspensionResult.suspended && immediateSuspensionResult.childStackRunIdForHostCall && immediateSuspensionResult.serviceNameForHostCall && immediateSuspensionResult.methodNameForHostCall && immediateSuspensionResult.argsForHostCall) {
				hostLog(logPrefix, "info", `🚨 IMMEDIATE SUSPENSION DETECTED for ${immediateSuspensionResult.serviceNameForHostCall}.${immediateSuspensionResult.methodNameForHostCall}. Child StackRunID: ${immediateSuspensionResult.childStackRunIdForHostCall}`);

				const parentOfCurrentQjsRunHandle = ctx.getProp(ctx.global, "__parentStackRunId__");
				const parentOfCurrentQjsRun = ctx.typeof(parentOfCurrentQjsRunHandle) === 'string' ? ctx.getString(parentOfCurrentQjsRunHandle) : undefined;
				parentOfCurrentQjsRunHandle?.dispose();

				const capturedVmState: SerializedVMState = captureVMState(
					ctx, 
					taskRunId, 
					immediateSuspensionResult.childStackRunIdForHostCall, 
					currentTaskCode,    
					currentTaskName,    
					currentTaskInput,   
					parentOfCurrentQjsRun 
				);
				hostLog(logPrefix, "info", `✅ VM state captured for current stack run ${currentQjsStackRunId}. Waiting on ${immediateSuspensionResult.childStackRunIdForHostCall}.`);

				// Save the ephemeral call and update the parent stack run
				await __saveEphemeralCall__(
					immediateSuspensionResult.childStackRunIdForHostCall, 
					immediateSuspensionResult.serviceNameForHostCall,
					immediateSuspensionResult.methodNameForHostCall,
					immediateSuspensionResult.argsForHostCall,
					taskRunId,          
					currentQjsStackRunId,
					currentTaskCode,
					currentTaskName
				);
				hostLog(logPrefix, "info", `✅ Child stack_run ${immediateSuspensionResult.childStackRunIdForHostCall} created for host call. Parent ${currentQjsStackRunId} status updated.`);

				// Explicitly persist the captured VM state for the current (now suspending) QJS stack_run
				await updateStackRun( 
					currentQjsStackRunId,
					'suspended_waiting_child',
					undefined,                 // no result for the parent at this point
					undefined,                 // no error for the parent at this point
					capturedVmState            // Persist the full VM state as resumePayload
				);
				hostLog(logPrefix, "info", `✅ VM state for parent QJS stack_run ${currentQjsStackRunId} explicitly persisted for suspension.`);

				if (currentResultHandle && currentResultHandle !== initialPromiseHandle) {
					currentResultHandle.dispose();
				}
				
				hostLog(logPrefix, "info", `🔄 VM SUSPENDING - PROCESS WILL NOW TERMINATE for host call to ${immediateSuspensionResult.serviceNameForHostCall}.${immediateSuspensionResult.methodNameForHostCall}`);
				
				return { 
					__hostCallSuspended: true,
					taskRunId: taskRunId, 
					stackRunId: immediateSuspensionResult.childStackRunIdForHostCall, 
					serviceName: immediateSuspensionResult.serviceNameForHostCall,
					message: `VM suspended for service call to ${immediateSuspensionResult.serviceNameForHostCall}. Child StackRunID: ${immediateSuspensionResult.childStackRunIdForHostCall}`
				};
			}
		}

		if (isResultPromise) {
			// Promise detected - await it normally
			hostLog(logPrefix, "debug", `Awaiting promise (loop ${loopCount})`);
			
			
			try {
				const promiseSettledResult = await ctx.resolvePromise(currentResultHandle);
				
				if (currentResultHandle && currentResultHandle !== initialPromiseHandle) {
					currentResultHandle.dispose();
				}

				if (promiseSettledResult.error) {
					hostLog(logPrefix, "error", "Promise rejected in VM.");
					const err = extractErrorFromHandle(ctx, promiseSettledResult.error);
					promiseSettledResult.error.dispose();
					throw err;
				}
				currentResultHandle = promiseSettledResult.value; 
				
				// Check for suspension after promise resolution
				hostLog(logPrefix, "debug", `Checking for suspension after promise resolution, result type: ${ctx.typeof(currentResultHandle)}`);
				const postResolveSuspensionResult = checkForSuspension(currentResultHandle);
				hostLog(logPrefix, "debug", `Suspension check result: suspended=${postResolveSuspensionResult.suspended}, childStackRunId=${postResolveSuspensionResult.childStackRunIdForHostCall}`);
				
				if (postResolveSuspensionResult.suspended && postResolveSuspensionResult.childStackRunIdForHostCall && postResolveSuspensionResult.serviceNameForHostCall && postResolveSuspensionResult.methodNameForHostCall && postResolveSuspensionResult.argsForHostCall) {
					hostLog(logPrefix, "info", `🎉 SUSPENSION DETECTED! VM suspending after promise resolution for service call to ${postResolveSuspensionResult.serviceNameForHostCall}.${postResolveSuspensionResult.methodNameForHostCall}. Child StackRunID: ${postResolveSuspensionResult.childStackRunIdForHostCall}`);

					const parentOfCurrentQjsRunHandle = ctx.getProp(ctx.global, "__parentStackRunId__");
					const parentOfCurrentQjsRun = ctx.typeof(parentOfCurrentQjsRunHandle) === 'string' ? ctx.getString(parentOfCurrentQjsRunHandle) : undefined;
					parentOfCurrentQjsRunHandle?.dispose();

					const callingVmState: SerializedVMState = captureVMState(
						ctx, 
						taskRunId,
						postResolveSuspensionResult.childStackRunIdForHostCall,
						currentTaskCode,
						currentTaskName,
						currentTaskInput
					);

					await saveStackRun(
						postResolveSuspensionResult.serviceNameForHostCall,
						postResolveSuspensionResult.methodNameForHostCall,
						postResolveSuspensionResult.argsForHostCall,
						callingVmState,
						taskRunId,
						currentQjsStackRunId
					);

					hostLog(logPrefix, "info", `VM state for parent QJS stack_run ${currentQjsStackRunId} explicitly persisted for suspension.`);

					if (currentResultHandle && currentResultHandle !== initialPromiseHandle) {
						currentResultHandle.dispose();
					}
					
					return { 
						__hostCallSuspended: true,
						taskRunId: taskRunId, 
						stackRunId: postResolveSuspensionResult.childStackRunIdForHostCall, 
						serviceName: postResolveSuspensionResult.serviceNameForHostCall,
						message: `VM suspended for service call to ${postResolveSuspensionResult.serviceNameForHostCall}. Child StackRunID: ${postResolveSuspensionResult.childStackRunIdForHostCall}`
					};
				}
			} catch (e) {
				hostLog(logPrefix, "error", `Error during ctx.resolvePromise: ${e instanceof Error ? e.message : String(e)}`);
				throw e;
			}
		} else {
			hostLog(logPrefix, "info", `Execution complete. Final result type: ${ctx.typeof(currentResultHandle)}.`);
			const finalResult = ctx.dump(currentResultHandle);
			if (currentResultHandle && currentResultHandle !== initialPromiseHandle) {
				currentResultHandle.dispose();
			}
			return finalResult; 
		}

		hostLog(logPrefix, "debug", `Executing pending jobs in QuickJS runtime (loop ${loopCount}).`);
		const executedJobsResult = quickJSInstance.executePendingJobs();
		if (executedJobsResult.error) {
			hostLog(logPrefix, "error", "Error while executing pending jobs in VM.");
			const err = extractErrorFromHandle(ctx, executedJobsResult.error);
			executedJobsResult.error.dispose();
			throw err;
		}

		// CRITICAL FIX: Check for immediate suspension after job execution
		// The __pendingServiceCall__ flag is set synchronously by service proxies
		// and should cause immediate suspension, not wait for promise resolution
		const pendingCallHandle = ctx.getProp(ctx.global, "__pendingServiceCall__");
		if (ctx.typeof(pendingCallHandle) === "object") {
			const pendingCall = ctx.dump(pendingCallHandle);
			if (pendingCall && pendingCall.stackRunId && pendingCall.service && pendingCall.method && pendingCall.args) {
				hostLog(logPrefix, "info", `IMMEDIATE SUSPENSION: __pendingServiceCall__ detected for ${pendingCall.service}.${pendingCall.method}. StackRunID: ${pendingCall.stackRunId}`);
				
				// Clear the pending call flag
				ctx.setProp(ctx.global, "__pendingServiceCall__", ctx.undefined);
				pendingCallHandle?.dispose();

				// Capture VM state for suspension
				const parentOfCurrentQjsRunHandle = ctx.getProp(ctx.global, "__parentStackRunId__");
				const parentOfCurrentQjsRun = ctx.typeof(parentOfCurrentQjsRunHandle) === 'string' ? ctx.getString(parentOfCurrentQjsRunHandle) : undefined;
				parentOfCurrentQjsRunHandle?.dispose();

				const callingVmState: SerializedVMState = captureVMState(
					ctx, 
					taskRunId,
					pendingCall.stackRunId,
					currentTaskCode,
					currentTaskName,
					currentTaskInput
				);

				// Save the stack run for the service call
				await saveStackRun(
					pendingCall.service,
					pendingCall.method,
					pendingCall.args,
					callingVmState,
					taskRunId,
					currentQjsStackRunId
				);

				hostLog(logPrefix, "info", `VM state for parent QJS stack_run ${currentQjsStackRunId} saved for immediate suspension.`);

				// Clean up current result handle before returning
				if (currentResultHandle && currentResultHandle !== initialPromiseHandle) {
					currentResultHandle.dispose();
				}
				
				// Return suspension marker
				return { 
					__hostCallSuspended: true,
					taskRunId: taskRunId, 
					stackRunId: pendingCall.stackRunId, 
					serviceName: pendingCall.service,
					message: `VM immediately suspended for service call to ${pendingCall.service}.${pendingCall.method}. Child StackRunID: ${pendingCall.stackRunId}`
				};
			}
		}
		pendingCallHandle?.dispose();
	}
}

// Function to check if a handle is a promise
function isPromise(ctx: QuickJSAsyncContext, handle: QuickJSHandle): boolean {
	if (!handle || ctx.typeof(handle) !== "object") {
		return false;
	}
	
	try {
		// First, check if this object was created by the Promise constructor
		const constructorProp = ctx.getProp(handle, "constructor");
		if (constructorProp && ctx.typeof(constructorProp) === "function") {
			const nameProp = ctx.getProp(constructorProp, "name");
			const constructorName = ctx.typeof(nameProp) === "string" ? ctx.getString(nameProp) : "";
			
			nameProp?.dispose();
			constructorProp.dispose();
			
			// If constructor name is Promise, it's definitely a promise
			if (constructorName === "Promise") {
				return true;
			}
			
			// If constructor name is Object, it's definitely not a promise (plain object)
			if (constructorName === "Object") {
				return false;
			}
			
			// Unknown constructor name - return false for safety
			return false;
		} else {
			constructorProp?.dispose();
			return false;
		}
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
		let errMsg: any;
		try {
			errMsg = ctx.dump(evalResult.error);
		} catch (dumpError) {
			errMsg = `[Error dump failed: ${dumpError instanceof Error ? dumpError.message : String(dumpError)}]`;
		}
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
	
	// FIX: Set suspended to false when resuming, and properly inject the result
	const resumeState: SerializedVMState = {
		...stackRunToResume.vm_state,
		suspended: false, // FIX: We're resuming, not suspending
		waitingOnStackRunId: stackRunToResume.waiting_on_stack_run_id || stackRunToResume.id,
		resume_payload: childResult,
		last_call_result: childResult, // FIX: Also set this for backward compatibility
		// Add checkpoint data to properly cache the result
		checkpoint: {
			...stackRunToResume.vm_state.checkpoint,
			completed: {
				...stackRunToResume.vm_state.checkpoint?.completed,
				[suspensionPointStackRunId || stackRunToResume.id]: childResult
			}
		}
	};
	
	hostLog(logPrefix, "info", `Resuming task ${taskName} (runId: ${parentTaskRunId}) using its state from stack_run ${suspensionPointStackRunId}, it was waiting on ${resumeState.waitingOnStackRunId}`);
	hostLog(logPrefix, "info", `Resume payload:`, JSON.stringify(childResult).substring(0, 200));
	
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
	let requestData: any;
	
	try {
		// FIX: Ensure we only read the request body once
		try {
			requestData = await req.json();
		} catch (bodyError) {
			hostLog(logPrefix, "error", `Error reading request body: ${bodyError instanceof Error ? bodyError.message : String(bodyError)}`);
			return handleError(new Error("Invalid JSON in request body"), "Cannot parse request", 400, logPrefix);
		}
		
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
		
		hostLog(logPrefix, "info", `Resuming VM with result:`, JSON.stringify(resultToInject).substring(0, 200));
		
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