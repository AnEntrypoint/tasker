// console.log("[Host Pre-Init] Loading quickjs/index.ts...");

import {
	getQuickJS,
	newAsyncContext,
	QuickJSContext,
	QuickJSHandle,
	QuickJSRuntime,
	QuickJSAsyncContext,
	RELEASE_ASYNC,
	QuickJSWASMModule
} from "quickjs-emscripten";
import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";
// Import shared utils
import {
	hostLog,
	simpleStringify,
	LogEntry,
	fetchTaskFromDatabase,
	createErrorResponse,
	createSuccessResponse
} from "../_shared/utils.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2"; // Import Supabase client
// Import vm-state-manager for serialization/deserialization
import { saveStackRun, _generateUUID } from "./vm-state-manager.ts";

// Define corsHeaders here
const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
	"Access-Control-Allow-Methods": "POST, OPTIONS"
};

// Define QuickJSAsyncWASMModule type
interface QuickJSAsyncWASMModule extends QuickJSWASMModule {
	newRuntime: () => QuickJSRuntime;
}

// console.log("[Host Pre-Init] Imports completed for quickjs/index.ts.");

function createHandleFromJson(context: QuickJSContext, jsValue: any, handles: QuickJSHandle[]): QuickJSHandle {
	switch (typeof jsValue) {
		case 'string': { const handle = context.newString(jsValue); handles.push(handle); return handle; }
		case 'number': { const handle = context.newNumber(jsValue); handles.push(handle); return handle; }
		case 'boolean': { const handle = jsValue ? context.true : context.false; handles.push(handle); return handle; }
		case 'undefined': { const handle = context.undefined; handles.push(handle); return handle; }
		case 'object':
			if (jsValue === null) { const handle = context.null; handles.push(handle); return handle; }
			if (Array.isArray(jsValue)) {
				const arrayHandle = context.newArray(); handles.push(arrayHandle);
				jsValue.forEach((item, index) => {
					const itemHandle = createHandleFromJson(context, item, handles);
					context.setProp(arrayHandle, index, itemHandle);
				});
				return arrayHandle;
			} else {
				const objHandle = context.newObject(); handles.push(objHandle);
				for (const key in jsValue) {
					if (Object.prototype.hasOwnProperty.call(jsValue, key)) {
						const valueHandle = createHandleFromJson(context, jsValue[key], handles);
						context.setProp(objHandle, key, valueHandle);
					}
				}
				return objHandle;
			}
		default:
			console.warn(`[Host] Unsupported type in createHandleFromJson: ${typeof jsValue}`);
			const handle = context.undefined; handles.push(handle); return handle;
	}
}

function createHandleFromJsonNoTrack(context: QuickJSAsyncContext, jsValue: any, handles?: QuickJSHandle[] /* Optional tracking */): QuickJSHandle {
	// Implementation similar to createHandleFromJson but without pushing to handles array unless provided
	// This is a separate function to make it clearer when we're tracking or not
	const track = handles !== undefined;
	switch (typeof jsValue) {
		case 'string': { const handle = context.newString(jsValue); if (track) handles!.push(handle); return handle; }
		case 'number': { const handle = context.newNumber(jsValue); if (track) handles!.push(handle); return handle; }
		case 'boolean': { const handle = jsValue ? context.true : context.false; if (track) handles!.push(handle); return handle; }
		case 'undefined': { const handle = context.undefined; if (track) handles!.push(handle); return handle; }
		case 'object':
			if (jsValue === null) { const handle = context.null; if (track) handles!.push(handle); return handle; }
			if (Array.isArray(jsValue)) {
				const arrayHandle = context.newArray();
				if (track) handles!.push(arrayHandle);
				for (let i = 0; i < jsValue.length; i++) {
					const itemHandle = createHandleFromJsonNoTrack(context, jsValue[i], track ? handles : undefined);
					context.setProp(arrayHandle, i, itemHandle);
				}
				return arrayHandle;
			} else {
				const objHandle = context.newObject();
				if (track) handles!.push(objHandle);
				for (const key in jsValue) {
					if (Object.prototype.hasOwnProperty.call(jsValue, key)) {
						const valueHandle = createHandleFromJsonNoTrack(context, jsValue[key], track ? handles : undefined);
						context.setProp(objHandle, key, valueHandle);
					}
				}
				return objHandle;
			}
		default:
			console.warn(`[Host] Unsupported type in createHandleFromJsonNoTrack: ${typeof jsValue}`);
			const handle = context.undefined;
			if (track) handles!.push(handle);
			return handle;
	}
}

async function callNestedHostProxy(proxy: any, chain: string[], args: any[]): Promise<any> {
	// This helper remains useful for the actual invocation *after* pause/resume
	hostLog("HostHelper", "debug", `Reconstructing call: Chain=${chain.join('.')}...`); 
	let currentProxy = proxy;
	for (let i = 0; i < chain.length; i++) {
		const prop = chain[i];
		if (!currentProxy || typeof currentProxy[prop] === 'undefined') {
			throw new Error(`[Host Helper] Property '${prop}' not found in chain.`);
		}
		currentProxy = currentProxy[prop];
	}
	hostLog("HostHelper", "debug", `Invoking final proxy function with ${args.length} args.`); 
	const finalProxy = currentProxy(...args);
	hostLog("HostHelper", "debug", "Awaiting the finalProxy to trigger execution..."); 
	const finalResult = await finalProxy;
	hostLog("HostHelper", "debug", `Final result received for chain ${chain.join('.')}.`); 
	return finalResult;
}

// REMOVE synchronous hostTaskExecuteFn entirely
/* 
const hostTaskExecuteFn = (...) => { ... }; 
*/

// --- Unified Host Call Handler (Asyncified) ---
const callHostToolFn = async (
	ctx: QuickJSAsyncContext,
	_thisHandle: QuickJSHandle, 
	toolNameHandle: QuickJSHandle,
	methodChainHandle: QuickJSHandle, 
	argsHandle: QuickJSHandle,      
	hostProxies: { [key: string]: any }
): Promise<QuickJSHandle> => {
	let toolName: string | null = null;
	let methodChain: string[] | null = null;
	let args: any[] | null = null;
	let resultHandle: QuickJSHandle | null = null;

	try {
		toolName = ctx.getString(toolNameHandle);
		methodChain = ctx.dump(methodChainHandle); 
		args = ctx.dump(argsHandle); 

		if (!toolName || !Array.isArray(methodChain) || !Array.isArray(args)) {
			throw new Error("Invalid arguments passed to __callHostTool__");
		}

		hostLog("HostCall", "info", `Invoking: ${toolName}.${methodChain.join('.')}(...)`);

		// Find the actual host proxy instance
		const targetHostProxy = hostProxies[toolName];
		if (!targetHostProxy) {
			throw new Error(`Host proxy for tool '${toolName}' not found.`);
		}

		// Generate a unique stack run ID
        const stackRunId = crypto.randomUUID();
        
        // Create a stack run record and exit instead of directly executing
        // This handles all async operations as stack run boundaries
        hostLog("HostCall", "info", `Creating stack run ${stackRunId} for ${toolName}.${methodChain.join('.')}`);
        
        try {
            // Convert the method chain to a method name string (the last item in the chain)
            const methodName = methodChain.join('.');
            
            // Save the stack run to the database using saveStackRun from vm-state-manager.ts
            await saveStackRun(
                stackRunId,
                toolName,
                methodName,
                args
            );
            
            // Return a special marker that tells the VM to pause execution
            // and restore later when the stack run completes
            const pauseMarker = {
                __vmPauseMarker: true,
                stackRunId: stackRunId,
                toolName: toolName,
                methodChain: methodChain,
                args: args
            };
            
            // Convert the pause marker to a handle
            resultHandle = createHandleFromJsonNoTrack(ctx, pauseMarker);
            return resultHandle;
        } catch (saveError) {
            const errorMessage = saveError instanceof Error ? saveError.message : String(saveError);
            hostLog("HostCall", "error", `Failed to save stack run: ${errorMessage}`);
            throw new Error(`Failed to save stack run: ${errorMessage}`);
        }
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		hostLog("HostCall", "error", `Error in host call for ${toolName || 'unknown'}.${methodChain?.join('.') || 'unknown'}:`, errorMessage);
		// Create an error handle instead of throwing
        try {
            const errorObj = { __vmError: true, message: errorMessage };
            return createHandleFromJsonNoTrack(ctx, errorObj);
        } catch (handleError) {
            const handleErrorMessage = handleError instanceof Error ? handleError.message : String(handleError);
            hostLog("HostCall", "error", `Failed to create error handle: ${handleErrorMessage}`);
            throw new Error(errorMessage);
        }
	}
};

// Helper functions for stack runs are now imported from vm-state-manager.ts

		// Define ONE function factory for all console levels
const logFn = (level: LogEntry["level"]) => (ctx: QuickJSAsyncContext) => {
	// Return the function handle directly
	return ctx.newFunction(level, (...argsHandles: QuickJSHandle[]) => {
			// Only log to host console, don't add to returned logs unless it's an error
			try {
				// --- OPTIMIZATION: Only dump args for errors ---
				if (level === 'error') {
					const args = argsHandles.map(h => ctx.dump(h));
					// Add VM errors to the main logs
					hostLog("VMConsole", "error", "[console.error]", { content: args });
				} else {
					// --- OPTIMIZATION: Assume first arg is string for non-errors, skip typeof ---
					// For other levels, log only the first argument if it's a string (the message)
					// This avoids potentially expensive dumping of complex objects for info/debug logs
					let message = `[${level.toUpperCase()}]`;
					try {
						if (argsHandles.length > 0) {
							// Directly try getString, catch if it fails (e.g., not a string)
							message += ` ${ctx.getString(argsHandles[0])}`;
						}
					} catch (_e) {
						// Just use a placeholder for non-string first arg
						message += " [Non-string argument]";
					}
					hostLog("VMConsole", level, message);
				}
			} catch (e) {
				// Don't fail if logging fails
				try {
					hostLog("VMConsole", "error", "Console logging error", { error: String(e) });
				} catch (_) { /* really last resort */ }
		}
	});
};

// Placeholder factories for console levels
const consoleLogFactory = logFn("log");
const consoleErrorFactory = logFn("error");
const consoleWarnFactory = logFn("warn");
const consoleInfoFactory = logFn("info");
const consoleDebugFactory = logFn("debug");

// Helper function to find, remove, and dispose a handle
function disposeTrackedHandle(handle: QuickJSHandle | undefined | null, handlesArray: QuickJSHandle[], ctxForLog?: QuickJSContext) {
	if (!handle || !handle.alive) {
		// hostLog('debug', 'Skipping disposal: Handle is null, undefined, or not alive.');
		return; 
	}

	const index = handlesArray.indexOf(handle);
	if (index > -1) {
		handlesArray.splice(index, 1); // Remove from tracking array
	} else {
		// Optional: Log if handle wasn't found in array - might indicate logic error
		// If it wasn't tracked, maybe it shouldn't be disposed here?
		// Let's log a warning for now.
		hostLog("HandleTracker", "warn", "Handle being disposed was not found in tracking array. Potential logic error.", ctxForLog?.dump(handle));
	}

	try {
		// hostLog('debug', 'Disposing handle explicitly.');
		handle.dispose();
	} catch (e) {
		hostLog("HandleTracker", "warn", `Error during explicit handle disposal: ${e instanceof Error ? e.message : String(e)}`);
	}
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

interface HostCallSuspended {
	__hostCallSuspended: true;
	stackRunId: string;
	serviceName: string;
	methodName: string;
}

function isHostCallSuspended(obj: any): obj is HostCallSuspended {
	return typeof obj === 'object' && obj !== null && obj.__hostCallSuspended === true;
}

async function serveQuickJsFunction(req: Request) {
	if (req.method === "OPTIONS") {
		return new Response("ok", { headers: corsHeaders });
	}

	let supabaseClient: SupabaseClient;
	try {
		// Corrected Supabase client initialization
		supabaseClient = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!,
			{
				global: { headers: { Authorization: req.headers.get('Authorization')! } },
				auth: { persistSession: false }
			}
		);
	} catch (e) {
		console.error("[QuickJS] Supabase client init error:", e);
		return new Response(simpleStringify({ error: "Supabase client failed to initialize", details: e.message }), {
			status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
		});
	}

	const requestBody = await req.json();
	const { taskName: taskNameOrId, input: taskInput, parentRunId: parentTaskRunId } = requestBody;

	if (!taskNameOrId) {
		return new Response(simpleStringify({ error: "taskName is required" }), {
			status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
		});
	}

	let taskRunId: string | null = null;
	let logPrefix = `[QuickJS ${taskNameOrId}]`;
	let quickJSInstance: QuickJSAsyncWASMModule | null = null;
	let vm: QuickJSAsyncContext | null = null;
	let rt: QuickJSRuntime | null = null;

	try {
		// Check if this is a direct execution request from stack-processor
		if (requestBody.directExecution && requestBody.taskName) {
			const taskName = requestBody.taskName;
			const taskInput = requestBody.taskInput || {};
			const stackRunId = requestBody.stackRunId;
			const parentRunId = requestBody.parentRunId;
			
			hostLog("[DIRECT EXECUTION REQUEST FOR TASK: " + taskName.toUpperCase() + "]", "info", "Processing direct execution request");
			
			try {
				// Get Supabase URL and key from environment
				const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
				const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
				
				if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
					throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required");
				}
				
				hostLog("[Direct Execution]", "info", `Fetching code for task: ${taskName}`);
				
				// Fetch the task code
				let taskCode;
				try {
					hostLog("[Direct Execution]", "debug", `Querying task by name: ${taskName}`);
					const task = await fetchTaskFromDatabase(supabaseClient, taskName, null, 
						(msg) => hostLog("[Direct Execution]", "debug", msg));
					
					if (!task) {
						throw new Error(`Task not found: ${taskName}`);
					}
					
					hostLog("[Direct Execution]", "debug", `Task found: ${taskName}`);
					taskCode = task;
				} catch (error) {
					hostLog("[Direct Execution]", "error", `Error fetching task: ${error instanceof Error ? error.message : String(error)}`);
					throw new Error(`Error fetching task: ${error instanceof Error ? error.message : String(error)}`);
				}
				
				// Execute the task directly
				const result = await executeTaskDirect(taskCode, taskName, taskInput, stackRunId, parentRunId);
				
				// If this request has a stackRunId, update the record status
				if (stackRunId) {
					try {
						const { error: updateError } = await supabaseClient
							.from('stack_runs')
							.update({
								status: 'completed',
								result,
								updated_at: new Date().toISOString()
							})
							.eq('id', stackRunId);
							
						if (updateError) {
							hostLog("[Direct Execution]", "error", `Failed to update stack_run status: ${updateError.message}`);
						}
					} catch (error) {
						hostLog("[Direct Execution]", "error", `Error updating stack_run: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				
				return new Response(JSON.stringify({ 
					result, 
					status: "completed"
				}), {
					status: 200, 
					headers: { 'Content-Type': 'application/json', ...corsHeaders }
				});
			} catch (error) {
				hostLog(logPrefix, 'error', "Unhandled error during QuickJS task execution:", error, error.stack);
				if (stackRunId) {
					try {
						await supabaseClient.from('task_runs').update({
							status: 'failed',
							error: { message: error.message, stack: error.stack },
							updated_at: new Date().toISOString(),
							ended_at: new Date().toISOString()
						}).eq('id', stackRunId);
					} catch (dbError) {
						hostLog(logPrefix, 'error', "Additionally, failed to update task_run with error state:", dbError);
					}
				}
				return new Response(simpleStringify({ error: error.message, stack: error.stack }), {
					status: 500,
					headers: { ...corsHeaders, "Content-Type": "application/json" }
				});
			}
		}

		const taskCode = await fetchTaskFromDatabase(supabaseClient, taskNameOrId, null, (msg) => hostLog(logPrefix, 'debug', msg));
		if (!taskCode) {
			return new Response(simpleStringify({ error: `Task code for '${taskNameOrId}' not found` }), {
				status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" }
			});
		}

		const { data: taskRunData, error: taskRunInsertError } = await supabaseClient
			.from('task_runs')
			.insert({
				task_name: taskNameOrId,
				parent_run_id: parentTaskRunId,
				status: 'processing',
				input: taskInput,
				started_at: new Date().toISOString()
			})
			.select('id')
			.single();

		if (taskRunInsertError) {
			console.error("[QuickJS] Failed to insert task_run:", taskRunInsertError);
			throw new Error(`Failed to create task_run: ${taskRunInsertError.message}`);
		}
		taskRunId = taskRunData.id;
		logPrefix = `[QuickJS ${taskRunId} (${taskNameOrId})]`;
		hostLog(logPrefix, 'info', "Task run created. Initializing VM.");

		quickJSInstance = await getQuickJS();
		rt = quickJSInstance.newRuntime();
		vm = await newAsyncContext(rt as unknown as any);

		const callHostToolFn = vm.newAsyncifiedFunction("__callHostTool__", async (
			serviceNameHandle: QuickJSHandle,
			methodChainHandle: QuickJSHandle,
			argsHandle: QuickJSHandle
		) => {
			const serviceName = vm!.getString(serviceNameHandle);
			const methodChainArray = vm!.dump(methodChainHandle) as string[];
			const methodName = methodChainArray.join('.');
			const args = vm!.dump(argsHandle);
			hostLog(logPrefix, 'info', `[Host Call Attempt] ${serviceName}.${methodName} with args:`, args);

			const { data: stackRun, error: stackRunError } = await supabaseClient
				.from('stack_runs')
				.insert({
					parent_task_run_id: taskRunId,
					service_name: serviceName,
					method_name: methodName,
					args: args,
					status: 'pending',
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString()
				})
				.select('id')
				.single();

			if (stackRunError) {
				hostLog(logPrefix, 'error', `Failed to create stack_run for ${serviceName}.${methodName}: ${stackRunError.message}`);
				// Throw an error that will reject the promise in the VM
				throw new Error(`HostError: Failed to create stack_run: ${stackRunError.message}`);
			}

			const newStackRunId = stackRun.id;
			hostLog(logPrefix, 'info', `Stack_run ${newStackRunId} created for ${serviceName}.${methodName}. Suspending task.`);

			const suspensionMarker: HostCallSuspended = {
				__hostCallSuspended: true,
				stackRunId: newStackRunId,
				serviceName,
				methodName
			};
			// newAutomaticHandle will handle the object correctly for the VM.
			// The promise returned by this asyncified function will resolve to this marker.
			return vm!.newAutomaticHandle(suspensionMarker);
		});
		vm.setProp(vm.global, "__callHostTool__", callHostToolFn);
		callHostToolFn.dispose();

		// Generic Proxy for 'tools'
		const proxyHandlerGet = vm.newFunction("get", (targetHandle: QuickJSHandle, propHandle: QuickJSHandle) => {
			const pathArray = vm!.dump(targetHandle) as string[]; // Path stored in target
			const prop = vm!.getString(propHandle);
			const newPath = [...pathArray, prop];

			// Return a new function that when called, will invoke __callHostTool__ with the path
			const methodCaller = vm!.newAsyncifiedFunction(prop, async (...argHandles: QuickJSHandle[]) => {
				const serviceName = newPath[0]; 
				const methodChain = newPath.slice(1);
				const callArgs = argHandles.map(h => vm!.dump(h));
				hostLog(logPrefix, 'debug', `[Proxy Call] ${newPath.join('.')} with args:`, callArgs);
				
				const globalCallHostTool = vm!.getProp(vm!.global, "__callHostTool__");
				const serviceNameH = vm!.newString(serviceName);
				const methodChainH = vm!.unwrapResult(vm!.newAutomaticHandle(methodChain)).handle;
				const argsH = vm!.unwrapResult(vm!.newAutomaticHandle(callArgs)).handle;

				const promiseHandle = vm!.callFunction(globalCallHostTool, vm!.undefined, serviceNameH, methodChainH, argsH);
				
				serviceNameH.dispose();
				methodChainH.dispose();
				argsH.dispose();
				globalCallHostTool.dispose();
				return promiseHandle; // This is a promise from __callHostTool__
			});
			
			// To allow further chaining, e.g., tools.service.group.method
			// we need to return an object that can be further proxied or is the callable function.
			// For simplicity, if it's not `log`, assume it could be a chain or a method.
			// A more robust proxy would distinguish better.
			if (prop === 'log') { // Special handle for synchronous tools.log
				 methodCaller.dispose(); // Dispose the async one we just made for log
				 return vm!.getProp(vm!.getProp(vm!.global, "host"),"log"); // Return host.log directly
			}
			
			// Create a new target for the next level proxy, storing the current path
			const nextTargetHandle = vm!.unwrapResult(vm!.newAutomaticHandle(newPath)).handle;
			const nextProxy = vm!.newProxy(nextTargetHandle, vm!.getProp(vm!.global, "__toolsProxyHandler")); // Assuming handler is on global
			// nextTargetHandle is now managed by nextProxy, no dispose needed here by us.
			// However, the proxy target should be an object, not an array for general use.
			// This proxy part needs to be more robust for deep chaining if methods and objects are mixed.
			// Let's simplify: any access returns a function that calls __callHostTool__.
			return methodCaller; 
		});

		const toolsProxyHandler = vm.newObject();
		vm.setProp(toolsProxyHandler, "get", proxyHandlerGet);
		proxyHandlerGet.dispose();
		vm.setProp(vm.global, "__toolsProxyHandler", toolsProxyHandler); // For recursive proxy
		toolsProxyHandler.dispose();

		// The initial target for the `tools` proxy is an empty array representing the root path.
		const rootProxyTarget = vm.unwrapResult(vm.newAutomaticHandle([])).handle; 
		const toolsProxy = vm.newProxy(rootProxyTarget, vm.getProp(vm.global, "__toolsProxyHandler"));
		rootProxyTarget.dispose();
		vm.setProp(vm.global, "tools", toolsProxy);
		// toolsProxy is now owned by global

		// Synchronous host.log for direct VM logging
		const hostObject = vm.newObject();
		const hostLogFn = vm.newFunction("log", (levelHandle, ...messageHandles) => {
			const level = vm.getString(levelHandle);
			const messages = messageHandles.map(h => vm.dump(h));
			hostLog(logPrefix, level, `[VM host.log]`, ...messages);
		});
		vm.setProp(hostObject, "log", hostLogFn);
		hostLogFn.dispose();
		vm.setProp(vm.global, "host", hostObject);
		hostObject.dispose();
		hostLog(logPrefix, 'info', "VM Initialized with __callHostTool__ and generic tools proxy.");

		// Set up global objects
		const consoleObj = vm.newObject();
		
		// Add console.log and other methods
		for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
			const logFn = vm.newFunction(level, (...args: QuickJSHandle[]) => {
				try {
					const stringArgs = args.map(arg => {
						try {
							return vm!.typeof(arg) === 'string' 
								? vm!.getString(arg) 
								: JSON.stringify(vm!.dump(arg));
						} catch (e) {
							return "[Complex Object]";
						}
					});
					hostLog(level as "info" | "debug" | "warn" | "error" | "log", 
						logPrefix, `[VM] ${stringArgs.join(' ')}`, {});
				} catch (e) {
					hostLog("error", logPrefix, `[VM Console] Error logging: ${e}`, {});
				}
			});
			vm.setProp(consoleObj, level, logFn);
			logFn.dispose();
		}
		
		vm.setProp(vm.global, "console", consoleObj);
		consoleObj.dispose();
		
		// Set up module export
		const moduleObj = vm.newObject();
		const exportsObj = vm.newObject();
		vm.setProp(moduleObj, "exports", exportsObj);
		vm.setProp(vm.global, "module", moduleObj);
		
		// Create empty tools object with task execution capability
		const toolsObj = vm.newObject();
		
		// Add tasks object with execute method
		const tasksObj = vm.newObject();
		const executeMethod = vm.newFunction("execute", (taskNameHandle, inputHandle) => {
			const nestedTaskName = vm.getString(taskNameHandle);
			const nestedInput = vm.dump(inputHandle);
			
			hostLog(logPrefix, "info", `[VM] Called tasks.execute('${nestedTaskName}')`);
			
			// Generate a unique ID for the nested task call
			const nestedStackRunId = _generateUUID();
			
			// Save the call to stack_runs table
			hostLog(logPrefix, "info", `[VM] Creating stack run for nested task: ${nestedTaskName}`);
			
			// Create a promise that will be resolved by the stack processor
			const promise = vm.newPromise();

			// Save the ephemeral call to the database
			__saveEphemeralCall__(vm, nestedStackRunId, "tasks", "execute", [nestedTaskName, nestedInput], 
				parentTaskRunId, parentTaskRunId)
				.then(() => {
					// Return a marker that this is a suspended call
					const suspensionMarker = {
						__hostCallSuspended: true,
						stackRunId: nestedStackRunId,
						serviceName: "tasks",
						methodName: "execute"
					};
					const suspensionHandle = vm.newString(JSON.stringify(suspensionMarker));
					promise.resolve(suspensionHandle);
					suspensionHandle.dispose();
				})
				.catch(err => {
					const errorHandle = vm.newError(`Error creating stack run: ${err}`);
					promise.reject(errorHandle);
					errorHandle.dispose();
				});
			
			return promise.handle;
		});
		
		vm.setProp(tasksObj, "execute", executeMethod);
		executeMethod.dispose();
		vm.setProp(toolsObj, "tasks", tasksObj);
		tasksObj.dispose();
		
		// Add basic gapi object with admin.directory.domains functionality
		const gapiObj = vm.newObject();
		const adminObj = vm.newObject();
		const directoryObj = vm.newObject();
		const domainsObj = vm.newObject();
		
		// Create a simple list method for domains
		const listMethod = trackHandle(vm.newAsyncifiedFunction("list", async (optionsHandle: QuickJSHandle) => {
			try {
				const options = vm!.dump(optionsHandle);
				hostLog(logPrefix, "info", `[VM] Called gapi.admin.directory.domains.list with options: ${JSON.stringify(options)}`);
				
				// Generate a unique ID for this stack run
				const nestedStackRunId = _generateUUID();
				
				// Save the ephemeral call to the database
				await saveStackRun(
					nestedStackRunId, 
					"gapi", 
					"admin.directory.domains.list", 
					[options], 
					stackRunId, // Use this stack run as the parent
					parentTaskRunId // Pass through the original parent task run ID
				);
				
				hostLog(logPrefix, "info", `[VM] Stack run ${nestedStackRunId} created for gapi.admin.directory.domains.list`);
				
				// Create a suspension marker as a plain object
				const suspensionMarkerObj = vm!.newObject();
				const trueHandle = vm!.true;
				const stackRunIdHandle = vm!.newString(nestedStackRunId);
				const serviceNameHandle = vm!.newString("gapi");
				const methodNameHandle = vm!.newString("admin.directory.domains.list");
				
				// Set properties on the object
				vm!.setProp(suspensionMarkerObj, "__hostCallSuspended", trueHandle);
				vm!.setProp(suspensionMarkerObj, "stackRunId", stackRunIdHandle);
				vm!.setProp(suspensionMarkerObj, "serviceName", serviceNameHandle);
				vm!.setProp(suspensionMarkerObj, "methodName", methodNameHandle);
				
				// Clean up temporary handles
				stackRunIdHandle.dispose();
				serviceNameHandle.dispose();
				methodNameHandle.dispose();
				
				return suspensionMarkerObj;
			} catch (e: unknown) {
				const errorMessage = e instanceof Error ? e.message : String(e);
				hostLog(logPrefix, "error", `[VM] Error in gapi.admin.directory.domains.list: ${errorMessage}`);
				throw new Error(`Internal error in gapi.admin.directory.domains.list: ${errorMessage}`);
			}
		}));
		
		// Create authenticate method with improved error handling
		const authenticateMethod = trackHandle(vm.newAsyncifiedFunction("authenticate", async (scopeHandle: QuickJSHandle) => {
			try {
				const scope = vm!.getString(scopeHandle);
				hostLog(logPrefix, "info", `[VM] Called gapi.authenticate with scope: ${scope}`);
				
				// Generate a unique ID for this stack run
				const nestedStackRunId = _generateUUID();
				
				// Save the ephemeral call to the database
				await saveStackRun(
					nestedStackRunId, 
					"gapi", 
					"authenticate", 
					[scope], 
					stackRunId, // Use this stack run as the parent
					parentTaskRunId // Pass through the original parent task run ID
				);
				
				hostLog(logPrefix, "info", `[VM] Stack run ${nestedStackRunId} created for gapi.authenticate`);
				
				// Create a suspension marker as a plain object
				const suspensionMarkerObj = vm!.newObject();
				const trueHandle = vm!.true;
				const stackRunIdHandle = vm!.newString(nestedStackRunId);
				const serviceNameHandle = vm!.newString("gapi");
				const methodNameHandle = vm!.newString("authenticate");
				
				// Set properties on the object
				vm!.setProp(suspensionMarkerObj, "__hostCallSuspended", trueHandle);
				vm!.setProp(suspensionMarkerObj, "stackRunId", stackRunIdHandle);
				vm!.setProp(suspensionMarkerObj, "serviceName", serviceNameHandle);
				vm!.setProp(suspensionMarkerObj, "methodName", methodNameHandle);
				
				// Clean up temporary handles
				stackRunIdHandle.dispose();
				serviceNameHandle.dispose();
				methodNameHandle.dispose();
				
				return suspensionMarkerObj;
			} catch (e: unknown) {
				const errorMessage = e instanceof Error ? e.message : String(e);
				hostLog(logPrefix, "error", `[VM] Error in gapi.authenticate: ${errorMessage}`);
				throw new Error(`Internal error in gapi.authenticate: ${errorMessage}`);
			}
		}));
		
		// Set up the object hierarchy
		vm.setProp(domainsObj, "list", listMethod);
		listMethod.dispose(); // Safe to dispose after setProp
		
		vm.setProp(directoryObj, "domains", domainsObj);
		domainsObj.dispose(); // Safe to dispose after setProp
		
		vm.setProp(adminObj, "directory", directoryObj);
		directoryObj.dispose(); // Safe to dispose after setProp
		
		vm.setProp(gapiObj, "admin", adminObj);
		adminObj.dispose(); // Safe to dispose after setProp
		
		vm.setProp(gapiObj, "authenticate", authenticateMethod);
		authenticateMethod.dispose(); // Safe to dispose after setProp
		
		vm.setProp(toolsObj, "gapi", gapiObj);
		gapiObj.dispose(); // Safe to dispose after setProp
		
		vm.setProp(vm.global, "tools", toolsObj);
		toolsObj.dispose(); // Safe to dispose after setProp
		
		// Evaluate the task code
		hostLog(logPrefix, "info", "Evaluating task code");
		const evalResult = vm.evalCode(wrapTaskCode(taskCode));
		
		if (evalResult.error) {
			throw new Error(`Error evaluating task code: ${vm.dump(evalResult.error)}`);
		}
		
		evalResult.value.dispose();
		
		// Get the exported function
		const exports = vm.getProp(moduleObj, "exports");
		
		// Check if exports is a function
		if (vm.typeof(exports) !== 'function') {
			throw new Error("Module exports is not a function");
		}
		
		// Convert task input to VM value
		const handles: QuickJSHandle[] = [];
		const inputHandle = createHandleFromJson(vm, taskInput, handles);
		
		// Create context object with tools
		const contextObj = trackHandle(vm.newObject());
		const toolsContextHandle = vm.getProp(vm.global, "tools");
		vm.setProp(contextObj, "tools", toolsContextHandle);
		
		// Call the task function
		hostLog(logPrefix, "info", `Calling task function with input: ${JSON.stringify(taskInput)}`);
		const resultHandle = vm.callFunction(exports, vm.undefined, inputHandle, contextObj);

		// Handle promise result if it's a promise
		let taskResult: any;
		
		if (resultHandle.error) {
			// Better error extraction
			try {
				const errorObj = vm.dump(resultHandle.error);
				const errorMessage = typeof errorObj === 'object' && errorObj.message ? 
					errorObj.message : 
					typeof errorObj === 'string' ? 
						errorObj : 
						'Unknown error';
				
				hostLog(logPrefix, "error", `Error calling task function: ${errorMessage}`);
				throw new Error(`Error in task execution: ${errorMessage}`);
			} catch (dumpError: unknown) {
				// Fallback if we can't dump the error
				hostLog(logPrefix, "error", `Error calling task function (dump failed): ${dumpError instanceof Error ? dumpError.message : String(dumpError)}`);
				throw new Error(`Error in task execution (dump failed): ${dumpError instanceof Error ? dumpError.message : String(dumpError)}`);
			}
		}
		
		const valueType = vm.typeof(resultHandle.value);
		hostLog(logPrefix, "info", `Extracting result of type: ${valueType}`);
		
		// Simple approach - just dump the value directly
		try {
			// Direct extraction
			taskResult = vm.dump(resultHandle.value);
			hostLog(logPrefix, "debug", `Raw task result: ${JSON.stringify(taskResult)}`);
			
			// Clean up handles
			resultHandle.value.dispose();
			handles.forEach(h => h.dispose());
			exports.dispose();
			
			if (taskRunId) {
				// Update stack run record with result
				const supabaseClient = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);
				await supabaseClient.from('stack_runs').update({
				status: 'completed',
					result: taskResult,
					updated_at: new Date().toISOString()
			}).eq('id', taskRunId);
		}

			return taskResult;
		} catch (error: unknown) {
			hostLog(logPrefix, "error", `Error extracting result: ${error instanceof Error ? error.message : String(error)}`);
			throw new Error(`Error extracting result: ${error instanceof Error ? error.message : String(error)}`);
		}
	} catch (error) {
		hostLog(logPrefix, 'error', "Unhandled error during QuickJS task execution:", error, error.stack);
		if (taskRunId) {
			try {
				await supabaseClient.from('task_runs').update({
					status: 'failed',
					error: { message: error.message, stack: error.stack },
					updated_at: new Date().toISOString(),
					ended_at: new Date().toISOString()
				}).eq('id', taskRunId);
			} catch (dbError) {
				hostLog(logPrefix, 'error', "Additionally, failed to update task_run with error state:", dbError);
			}
		}
		return new Response(simpleStringify({ error: error.message, stack: error.stack }), {
			status: 500,
			headers: { ...corsHeaders, "Content-Type": "application/json" }
		});
	} finally {
		if (vm) {
			vm.dispose();
			hostLog(logPrefix, 'info', "VM disposed.");
		}
		if (rt) {
			rt.dispose();
			hostLog(logPrefix, 'info', "Runtime disposed.");
		}
		hostLog(logPrefix, 'info', "QuickJS processing finished.");
	}
}

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
serve(serveQuickJsFunction);

/*
 Placeholder for saveEphemeralCallFn - REMOVED
 const saveEphemeralCallFn = async (...) => { ... };
*/

// Remove vm-state-manager import if not used for serialization/deserialization directly here
// import { saveVMState } from "./vm-state-manager.ts"; 

// --- VM Proxy Builder ---
function buildVmProxy(
	ctx: QuickJSAsyncContext,
	toolName: string,
	hostProxy: any, 
	callHostToolHandle: QuickJSHandle, 
	parentStackRunId: string | null, 
	handles: QuickJSHandle[] 
): QuickJSHandle {
	hostLog("debug", `[VM Proxy Builder] Building proxy for tool: ${toolName}`);

	const proxyTarget = ctx.newObject(); // The object VM code interacts with
	handles.push(proxyTarget);

	// Store handles needed inside the proxy trap closures
	const toolNameHandle = ctx.newString(toolName); handles.push(toolNameHandle);
	const parentStackRunIdHandle = parentStackRunId ? ctx.newString(parentStackRunId) : ctx.null;
	if(parentStackRunId) handles.push(parentStackRunIdHandle); // Only track if not null

	// Use QuickJS Proxy to intercept property access and calls
	const handler = ctx.newObject(); handles.push(handler);

	// Trap for property access (e.g., tools.openai.chat)
	const getTrap = ctx.newFunction("get", (targetHandle: QuickJSHandle, propNameHandle: QuickJSHandle /* , receiverHandle */) => {
		const propName = ctx.getString(propNameHandle);
		hostLog("debug", `[VM Proxy Trap] GET trap: ${toolName}.${propName}`);

		// Check if the property exists on the *host* proxy to decide if it's a callable method or another object level
		// This is a simplified check; a real implementation might need more robust introspection
		let currentHostProp = hostProxy;
		const chain = [propName]; // Start building the potential chain
		try {
			currentHostProp = currentHostProp[propName];
		} catch { currentHostProp = undefined; }


		if (typeof currentHostProp === 'function') {
			// If it's a function on the host, return a VM function that triggers the host call
			const vmFunction = ctx.newFunction(propName, (...argHandles: QuickJSHandle[]) => {
				hostLog("debug", `[VM Proxy Trap] CALL trap invoked for: ${toolName}.${propName}`);
				const argsArrayHandle = ctx.newArray();
				argHandles.forEach((argHandle, index) => {
					// Use setProp with index instead of pushValue
					ctx.setProp(argsArrayHandle, index, argHandle);
				});
				handles.push(argsArrayHandle); 

				// Convert args to real JS values for saving to stack_runs table
				const args = ctx.dump(argsArrayHandle);
				
				// Generate a unique ID for this stack run
				const stackRunId = _generateUUID();
				
				// Call the __saveEphemeralCall__ function to save the call to the stack_runs table
				const saveEphemeralCallHandle = ctx.getProp(ctx.global, "__saveEphemeralCall__");
				const serviceNameHandle = ctx.newString(toolName);
				const methodNameHandle = ctx.newString(propName);
				
				// Create promise to save call and get result
				const savePromiseHandle = ctx.callFunction(
					saveEphemeralCallHandle,
					ctx.undefined,
					serviceNameHandle,
					methodNameHandle,
					argsArrayHandle,
					parentStackRunIdHandle
				);
				
				// Clean up temporary handles
				serviceNameHandle.dispose();
				methodNameHandle.dispose();
				
				// Return the promise from __saveEphemeralCall__
				return savePromiseHandle;
			});
			handles.push(vmFunction);
			return vmFunction;
		} else if (typeof currentHostProp === 'object' && currentHostProp !== null) {
			// If it's an object, recursively build another proxy level
			// TODO: Implement recursive proxy building if needed (e.g., tools.openai.chat.completions)
			// For now, return undefined for deeper levels
			 hostLog("warn", `[VM Proxy Trap] GET for non-function property ${toolName}.${propName}. Returning undefined (recursion not implemented).`);
			return ctx.undefined;
		} else {
			// Property doesn't exist or is not a function/object
			hostLog("warn", `[VM Proxy Trap] Property '${propName}' not found or invalid type on host proxy for '${toolName}'. Returning undefined.`);
			return ctx.undefined;
		}
	});
	handles.push(getTrap);
	ctx.setProp(handler, "get", getTrap);

	// TODO: Add 'set' trap if needed, usually not for tool proxies

	// --- Create Proxy using evalCode --- 
	// We need to expose the target and handler to the evalCode scope
	const tempGlobalPropTarget = `__proxyTarget_${toolName}`;
	const tempGlobalPropHandler = `__proxyHandler_${toolName}`;
	ctx.setProp(ctx.global, tempGlobalPropTarget, proxyTarget);
	ctx.setProp(ctx.global, tempGlobalPropHandler, handler);

	const evalResult = ctx.evalCode(`new Proxy(${tempGlobalPropTarget}, ${tempGlobalPropHandler})`);

	// Clean up temporary globals immediately
	ctx.setProp(ctx.global, tempGlobalPropTarget, ctx.undefined); // Or delete if possible/safe
	ctx.setProp(ctx.global, tempGlobalPropHandler, ctx.undefined);

	if (evalResult.error) {
		hostLog("error", `[VM Proxy Builder] Error creating proxy for ${toolName} via evalCode`, ctx.dump(evalResult.error));
		evalResult.error.dispose();
		// Return the original target as a fallback? Or throw?
		// Throwing might be better to indicate failure.
		throw new Error(`Failed to create VM proxy for tool ${toolName}`);
	}

	// --- End Proxy Creation ---

	// The result of evalCode is the proxy handle
	const proxyHandle = evalResult.value;
	handles.push(proxyHandle); // Track the proxy handle itself

	hostLog("debug", `[VM Proxy Builder] Finished building proxy for ${toolName}`);
	return proxyHandle;
}

// --- Implementation of __saveEphemeralCall__ for the VM ---
const saveEphemeralCallFn = async (
	ctx: QuickJSAsyncContext,
	_thisHandle: QuickJSHandle,
	serviceNameHandle: QuickJSHandle,
	methodNameHandle: QuickJSHandle, 
	argsHandle: QuickJSHandle,
	parentStackRunIdHandle: QuickJSHandle
): Promise<QuickJSHandle> => {
	const serviceName = ctx.getString(serviceNameHandle);
	const methodName = ctx.getString(methodNameHandle);
	const args = ctx.dump(argsHandle);
	const parentStackRunId = parentStackRunIdHandle !== ctx.null ? ctx.getString(parentStackRunIdHandle) : null;
	
	// Generate a unique ID for this stack run
	const stackRunId = _generateUUID();
	
	hostLog("info", `[saveEphemeralCall] Creating stack run for ${serviceName}.${methodName} with ID ${stackRunId}`, {});
	
	// Capture the current VM state
	try {
		// Initialize Supabase client
		const supabaseClient = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);
		
		// Save to stack_runs table
		const { data, error } = await supabaseClient
			.from('stack_runs')
			.insert({
				id: stackRunId,
				parent_task_run_id: parentStackRunId,
				module_name: serviceName,
				method_name: methodName,
				args: args,
				status: 'pending',
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString()
			})
			.select('id');
		
		if (error) {
			throw new Error(`Failed to create stack run: ${error.message}`);
		}
		
		// Try to trigger the stack processor
		try {
			const response = await fetch(`${SUPABASE_URL}/functions/v1/stack-processor`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
				},
				body: JSON.stringify({ stack_run_id: stackRunId })
			});
			
			if (!response.ok) {
				console.error(`[saveEphemeralCall] Failed to trigger stack processor: ${await response.text()}`);
			}
		} catch (e) {
			console.error(`[saveEphemeralCall] Error triggering stack processor: ${e}`);
		}
		
		// Poll for stack run completion
		let result;
		let pollCount = 0;
		const maxPolls = 30;
		const pollInterval = 500; // ms
		
		while (pollCount < maxPolls) {
			pollCount++;
			
			// Wait for next poll
			await new Promise(resolve => setTimeout(resolve, pollInterval));
			
			// Check stack run status
			const { data: stackRun, error: pollError } = await supabaseClient
				.from('stack_runs')
				.select('*')
				.eq('id', stackRunId)
				.single();
			
			if (pollError) {
				console.error(`[saveEphemeralCall] Error polling stack run: ${pollError.message}`);
				continue;
			}
			
			if (stackRun.status === 'completed') {
				result = stackRun.result;
				break;
			} else if (stackRun.status === 'failed') {
				throw new Error(`Stack run failed: ${JSON.stringify(stackRun.error)}`);
			}
			
			// Continue polling
			console.log(`[saveEphemeralCall] Polling stack run ${stackRunId}, status: ${stackRun.status}, poll ${pollCount}/${maxPolls}`);
		}
		
		if (pollCount >= maxPolls) {
			throw new Error(`Polling timeout for stack run ${stackRunId}`);
		}
		
		// Return the result
		return createHandleFromJsonNoTrack(ctx, result);
	} catch (error) {
		hostLog("error", `[saveEphemeralCall] Error: ${error instanceof Error ? error.message : String(error)}`, {});
		
		// Create error handle
		const errorHandle = ctx.newError(error instanceof Error ? error.message : String(error));
		const promise = ctx.newPromise();
		promise.reject(errorHandle);
		errorHandle.dispose();
		
		return promise.handle;
	}
};

// Handle direct task execution
async function executeTaskDirect(taskCode: string, taskName: string, taskInput: any, stackRunId?: string, parentRunId?: string): Promise<any> {
	const logPrefix = `[executeTaskDirect:${taskName}]`;
	hostLog(logPrefix, "info", `Direct task execution for ${taskName}`);
	
	let vm: QuickJSAsyncContext | null = null;
	let quickjs = null;
	let runtime = null;
	let activeHandles: QuickJSHandle[] = [];
	
	try {
		// Initialize QuickJS
		quickjs = await getQuickJS();
		runtime = quickjs.newRuntime();
		// Fix type issues by casting
		vm = await newAsyncContext(runtime as unknown as any);
		
		// Track all active handles for cleanup
		const trackHandle = (handle: QuickJSHandle): QuickJSHandle => {
			if (handle && handle.alive) {
				activeHandles.push(handle);
			}
			return handle;
		};
		
		// These will be used by ephemeral calls
		const parentStackRunId = parentRunId || null;
		const parentTaskRunId = parentRunId || null;
		
		// Get Supabase URL and key from environment 
		const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
		const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
		
		if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
			throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required");
		}
		
		// Set up global objects
		const consoleObj = trackHandle(vm.newObject());
		
		// Add console methods
		for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
			const logFn = trackHandle(vm.newFunction(level, (...args: QuickJSHandle[]) => {
				try {
					const stringArgs = args.map(arg => {
						try {
							return vm!.typeof(arg) === 'string' 
								? vm!.getString(arg) 
								: JSON.stringify(vm!.dump(arg));
						} catch (e) {
							return "[Complex Object]";
						}
					});
					hostLog(logPrefix, level as LogEntry["level"], `[VM] ${stringArgs.join(' ')}`);
				} catch (e) {
					hostLog(logPrefix, "error", `[VM Console] Error logging: ${e instanceof Error ? e.message : String(e)}`);
				}
			}));
			vm.setProp(consoleObj, level, logFn);
			logFn.dispose(); // Safe to dispose after setProp
			activeHandles = activeHandles.filter(h => h !== logFn);
		}
		
		vm.setProp(vm.global, "console", consoleObj);
		consoleObj.dispose(); // Safe to dispose after setProp
		activeHandles = activeHandles.filter(h => h !== consoleObj);
		
		// Set up module export
		const moduleObj = trackHandle(vm.newObject());
		const exportsObj = trackHandle(vm.newObject());
		vm.setProp(moduleObj, "exports", exportsObj);
		vm.setProp(vm.global, "module", moduleObj);
		
		// Create empty tools object with task execution capability
		const toolsObj = trackHandle(vm.newObject());
		
		// Add tasks object with execute method
		const tasksObj = trackHandle(vm.newObject());
		const executeMethod = trackHandle(vm.newAsyncifiedFunction("execute", async (taskNameHandle: QuickJSHandle, inputHandle: QuickJSHandle) => {
			// Always dispose handles created by methods within other methods
			try {
				const nestedTaskName = vm!.getString(taskNameHandle);
				const nestedInput = vm!.dump(inputHandle);
				
				hostLog(logPrefix, "info", `[VM] Called tasks.execute('${nestedTaskName}')`);
				
				// Generate a unique ID for the nested task call
				const nestedStackRunId = _generateUUID();
				
				// Save the ephemeral call to the database
				await saveStackRun(
					nestedStackRunId,
					"tasks", 
					"execute", 
					[nestedTaskName, nestedInput], 
					stackRunId, // Use this stack run as the parent
					parentTaskRunId // Pass through the original parent task run ID
				);
				
				hostLog(logPrefix, "info", `[VM] Stack run ${nestedStackRunId} created for nested task ${nestedTaskName}`);
				
				// Create a suspension marker as a plain object
				const suspensionMarkerObj = vm!.newObject();
				const trueHandle = vm!.true;
				const stackRunIdHandle = vm!.newString(nestedStackRunId);
				const serviceNameHandle = vm!.newString("tasks");
				const methodNameHandle = vm!.newString("execute");
				
				// Set properties on the object
				vm!.setProp(suspensionMarkerObj, "__hostCallSuspended", trueHandle);
				vm!.setProp(suspensionMarkerObj, "stackRunId", stackRunIdHandle);
				vm!.setProp(suspensionMarkerObj, "serviceName", serviceNameHandle);
				vm!.setProp(suspensionMarkerObj, "methodName", methodNameHandle);
				
				// Clean up temporary handles
				stackRunIdHandle.dispose();
				serviceNameHandle.dispose();
				methodNameHandle.dispose();
				
				return suspensionMarkerObj;
			} catch (e: unknown) {
				const errorMessage = e instanceof Error ? e.message : String(e);
				hostLog(logPrefix, "error", `[VM] Error in tasks.execute: ${errorMessage}`);
				throw new Error(`Internal error in tasks.execute: ${errorMessage}`);
			}
		}));
		
		vm.setProp(tasksObj, "execute", executeMethod);
		executeMethod.dispose(); // Safe to dispose after setProp
		activeHandles = activeHandles.filter(h => h !== executeMethod);
		
		vm.setProp(toolsObj, "tasks", tasksObj);
		tasksObj.dispose(); // Safe to dispose after setProp
		activeHandles = activeHandles.filter(h => h !== tasksObj);
		
		// Add basic gapi object with admin.directory.domains functionality
		const gapiObj = trackHandle(vm.newObject());
		const adminObj = trackHandle(vm.newObject());
		const directoryObj = trackHandle(vm.newObject());
		const domainsObj = trackHandle(vm.newObject());
		
		// Create a simple list method for domains
		const listMethod = trackHandle(vm.newAsyncifiedFunction("list", async (optionsHandle: QuickJSHandle) => {
			try {
				const options = vm!.dump(optionsHandle);
				hostLog(logPrefix, "info", `[VM] Called gapi.admin.directory.domains.list with options: ${JSON.stringify(options)}`);
				
				// Generate a unique ID for this stack run
				const nestedStackRunId = _generateUUID();
				
				// Save the ephemeral call to the database
				await saveStackRun(
					nestedStackRunId, 
					"gapi", 
					"admin.directory.domains.list", 
					[options], 
					stackRunId, // Use this stack run as the parent
					parentTaskRunId // Pass through the original parent task run ID
				);
				
				hostLog(logPrefix, "info", `[VM] Stack run ${nestedStackRunId} created for gapi.admin.directory.domains.list`);
				
				// Create a suspension marker as a plain object
				const suspensionMarkerObj = vm!.newObject();
				const trueHandle = vm!.true;
				const stackRunIdHandle = vm!.newString(nestedStackRunId);
				const serviceNameHandle = vm!.newString("gapi");
				const methodNameHandle = vm!.newString("admin.directory.domains.list");
				
				// Set properties on the object
				vm!.setProp(suspensionMarkerObj, "__hostCallSuspended", trueHandle);
				vm!.setProp(suspensionMarkerObj, "stackRunId", stackRunIdHandle);
				vm!.setProp(suspensionMarkerObj, "serviceName", serviceNameHandle);
				vm!.setProp(suspensionMarkerObj, "methodName", methodNameHandle);
				
				// Clean up temporary handles
				stackRunIdHandle.dispose();
				serviceNameHandle.dispose();
				methodNameHandle.dispose();
				
				return suspensionMarkerObj;
			} catch (e: unknown) {
				const errorMessage = e instanceof Error ? e.message : String(e);
				hostLog(logPrefix, "error", `[VM] Error in gapi.admin.directory.domains.list: ${errorMessage}`);
				throw new Error(`Internal error in gapi.admin.directory.domains.list: ${errorMessage}`);
			}
		}));
		
		// Create authenticate method with improved error handling
		const authenticateMethod = trackHandle(vm.newAsyncifiedFunction("authenticate", async (scopeHandle: QuickJSHandle) => {
			try {
				const scope = vm!.getString(scopeHandle);
				hostLog(logPrefix, "info", `[VM] Called gapi.authenticate with scope: ${scope}`);
				
				// Generate a unique ID for this stack run
				const nestedStackRunId = _generateUUID();
				
				// Save the ephemeral call to the database
				await saveStackRun(
					nestedStackRunId, 
					"gapi", 
					"authenticate", 
					[scope], 
					stackRunId, // Use this stack run as the parent
					parentTaskRunId // Pass through the original parent task run ID
				);
				
				hostLog(logPrefix, "info", `[VM] Stack run ${nestedStackRunId} created for gapi.authenticate`);
				
				// Create a suspension marker as a plain object
				const suspensionMarkerObj = vm!.newObject();
				const trueHandle = vm!.true;
				const stackRunIdHandle = vm!.newString(nestedStackRunId);
				const serviceNameHandle = vm!.newString("gapi");
				const methodNameHandle = vm!.newString("authenticate");
				
				// Set properties on the object
				vm!.setProp(suspensionMarkerObj, "__hostCallSuspended", trueHandle);
				vm!.setProp(suspensionMarkerObj, "stackRunId", stackRunIdHandle);
				vm!.setProp(suspensionMarkerObj, "serviceName", serviceNameHandle);
				vm!.setProp(suspensionMarkerObj, "methodName", methodNameHandle);
				
				// Clean up temporary handles
				stackRunIdHandle.dispose();
				serviceNameHandle.dispose();
				methodNameHandle.dispose();
				
				return suspensionMarkerObj;
			} catch (e: unknown) {
				const errorMessage = e instanceof Error ? e.message : String(e);
				hostLog(logPrefix, "error", `[VM] Error in gapi.authenticate: ${errorMessage}`);
				throw new Error(`Internal error in gapi.authenticate: ${errorMessage}`);
			}
		}));
		
		// Set up the object hierarchy
		vm.setProp(domainsObj, "list", listMethod);
		listMethod.dispose(); // Safe to dispose after setProp
		
		vm.setProp(directoryObj, "domains", domainsObj);
		domainsObj.dispose(); // Safe to dispose after setProp
		
		vm.setProp(adminObj, "directory", directoryObj);
		directoryObj.dispose(); // Safe to dispose after setProp
		
		vm.setProp(gapiObj, "admin", adminObj);
		adminObj.dispose(); // Safe to dispose after setProp
		
		vm.setProp(gapiObj, "authenticate", authenticateMethod);
		authenticateMethod.dispose(); // Safe to dispose after setProp
		
		vm.setProp(toolsObj, "gapi", gapiObj);
		gapiObj.dispose(); // Safe to dispose after setProp
		
		vm.setProp(vm.global, "tools", toolsObj);
		toolsObj.dispose(); // Safe to dispose after setProp
		
		// Evaluate the task code
		hostLog(logPrefix, "info", "Evaluating task code");
		const evalResult = vm.evalCode(wrapTaskCode(taskCode));
		
		if (evalResult.error) {
			throw new Error(`Error evaluating task code: ${vm.dump(evalResult.error)}`);
		}
		
		evalResult.value.dispose();
		
		// Get the exported function
		const exports = vm.getProp(moduleObj, "exports");
		
		// Check if exports is a function
		if (vm.typeof(exports) !== 'function') {
			throw new Error("Module exports is not a function");
		}
		
		// Convert task input to VM value
		const handles: QuickJSHandle[] = [];
		const inputHandle = createHandleFromJson(vm, taskInput, handles);
		
		// Create context object with tools
		const contextObj = trackHandle(vm.newObject());
		const toolsContextHandle = vm.getProp(vm.global, "tools");
		vm.setProp(contextObj, "tools", toolsContextHandle);
		
		// Call the task function
		hostLog(logPrefix, "info", `Calling task function with input: ${JSON.stringify(taskInput)}`);
		const resultHandle = vm.callFunction(exports, vm.undefined, inputHandle, contextObj);
		
		if (resultHandle.error) {
			// Better error extraction
			try {
				const errorObj = vm.dump(resultHandle.error);
				const errorMessage = typeof errorObj === 'object' && errorObj.message ? 
					errorObj.message : 
					typeof errorObj === 'string' ? 
						errorObj : 
						'Unknown error';
				
				hostLog(logPrefix, "error", `Error calling task function: ${errorMessage}`);
				throw new Error(`Error in task execution: ${errorMessage}`);
			} catch (dumpError: unknown) {
				// Fallback if we can't dump the error
				hostLog(logPrefix, "error", `Error calling task function (dump failed): ${dumpError instanceof Error ? dumpError.message : String(dumpError)}`);
				throw new Error(`Error in task execution (dump failed): ${dumpError instanceof Error ? dumpError.message : String(dumpError)}`);
			}
		}
		
		const valueType = vm.typeof(resultHandle.value);
		hostLog(logPrefix, "info", `Extracting result of type: ${valueType}`);
		
		// Handle Promise results
		if (valueType === 'object') {
			try {
				// Check if it's likely a Promise (QuickJS promises are objects with then/catch methods)
				const isThenMethodPresent = vm.evalCode(`
					(function() { 
						const result = globalThis.__checkResult;
						return result && typeof result.then === 'function'; 
					})()
				`);
				
				// Set the result handle on global scope for the check
				vm.setProp(vm.global, "__checkResult", resultHandle.value);
				
				if (!isThenMethodPresent.error && vm.typeof(isThenMethodPresent.value) === 'boolean' && vm.dump(isThenMethodPresent.value) === true) {
					hostLog(logPrefix, "info", "Result is a Promise, awaiting resolution");
					
					// Set up promise handlers using a new promise in the VM
					const resultPromise = vm.newPromise();
					
					// Add then/catch handlers to the returned promise
					const thenFn = vm.newFunction("then", (valueHandle) => {
						resultPromise.resolve(valueHandle);
						return vm.undefined;
					});
					
					const catchFn = vm.newFunction("catch", (errorHandle) => {
						resultPromise.reject(errorHandle);
						return vm.undefined;
					});
					
					// Set the handlers in global scope for the evalCode to use
					vm.setProp(vm.global, "__thenFn", thenFn);
					vm.setProp(vm.global, "__catchFn", catchFn);
					
					// Call the then and catch methods on the result using evalCode
					const callThenResult = vm.evalCode(`
						globalThis.__checkResult.then(globalThis.__thenFn).catch(globalThis.__catchFn);
					`);
					
					if (callThenResult.error) {
						throw new Error(`Error setting up promise handlers: ${vm.dump(callThenResult.error)}`);
					}
					
					// Now process pending jobs until our promise settles or we timeout
					let attempts = 0;
					const MAX_ATTEMPTS = 1000;
					let promiseSettled = false;
					let finalResult: any;
					let error: any;
					
					// Set up the promise resolution callbacks
					resultPromise.settled.then((settled) => {
						promiseSettled = true;
						if (settled.fulfilled) {
							finalResult = vm.dump(settled.value);
						} else {
							error = vm.dump(settled.reason);
						}
					});
					
					// Process pending jobs until the promise settles
					while (!promiseSettled && attempts < MAX_ATTEMPTS) {
						attempts++;
						
						// Execute pending jobs in the runtime
						const jobResult = runtime.executePendingJobs();
						
						if (jobResult.error) {
							throw new Error(`Error executing pending jobs: ${jobResult.error}`);
						}
						
						// Give a short timeout to allow promise callbacks to execute
						if (attempts % 10 === 0) {
							await new Promise(resolve => setTimeout(resolve, 1));
						}
					}
					
					// Clean up the global references
					vm.setProp(vm.global, "__checkResult", vm.undefined);
					vm.setProp(vm.global, "__thenFn", vm.undefined);
					vm.setProp(vm.global, "__catchFn", vm.undefined);
					
					// Dispose the function handles
					thenFn.dispose();
					catchFn.dispose();
					
					if (!promiseSettled) {
						throw new Error(`Promise did not settle after ${MAX_ATTEMPTS} job processing attempts`);
					}
					
					if (error) {
						throw new Error(`Promise rejected: ${typeof error === 'object' && error.message ? error.message : String(error)}`);
					}
					
					// Return the final result
					hostLog(logPrefix, "info", "Promise resolved successfully");
					
					// Clean up handles
					resultHandle.value.dispose();
					handles.forEach(h => {
						try {
							if (h.alive) h.dispose();
						} catch (e) {
							// Ignore errors in cleanup
							hostLog(logPrefix, "warn", `Error disposing handle: ${e}`);
						}
					});
					
					exports.dispose();
					contextObj.dispose();
					
					// Update stack run record with result
					if (stackRunId) {
						// Update stack run record with result
						const supabaseClient = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
						try {
							await supabaseClient.from('stack_runs').update({
								status: 'completed',
								result: finalResult,
								updated_at: new Date().toISOString()
							}).eq('id', stackRunId);
						} catch (dbError) {
							hostLog(logPrefix, "error", `Database error updating stack run: ${dbError}`);
							// Continue even with database error
						}
					}
					
					return finalResult;
				}
			} catch (promiseError: unknown) {
				hostLog(logPrefix, "error", `Error handling promise: ${promiseError instanceof Error ? promiseError.message : String(promiseError)}`);
				throw new Error(`Error handling promise: ${promiseError instanceof Error ? promiseError.message : String(promiseError)}`);
			}
		}
		
		// If not a promise, just extract the value directly
		try {
			// Direct extraction
			let taskResult = vm.dump(resultHandle.value);
			hostLog(logPrefix, "debug", `Raw task result: ${typeof taskResult === 'object' ? JSON.stringify(taskResult) : String(taskResult)}`);
			
			// Clean up handles
			resultHandle.value.dispose();
			handles.forEach(h => {
				try {
					if (h.alive) h.dispose();
				} catch (e) {
					// Ignore errors in cleanup
					hostLog(logPrefix, "warn", `Error disposing handle: ${e}`);
				}
			});
			exports.dispose();
			contextObj.dispose();
			
			// Remove disposed handles from active handles
			activeHandles = activeHandles.filter(h => h.alive);
			
			// Update stack run record with result
			if (stackRunId) {
				// Update stack run record with result
				const supabaseClient = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
				try {
					await supabaseClient.from('stack_runs').update({
						status: 'completed',
						result: taskResult,
						updated_at: new Date().toISOString()
					}).eq('id', stackRunId);
				} catch (dbError) {
					hostLog(logPrefix, "error", `Database error updating stack run: ${dbError}`);
					// Continue even with database error
				}
			}
			
			return taskResult;
		} catch (error: unknown) {
			hostLog(logPrefix, "error", `Error extracting result: ${error instanceof Error ? error.message : String(error)}`);
			throw new Error(`Error extracting result: ${error instanceof Error ? error.message : String(error)}`);
		}
	} catch (error: unknown) {
		// Update stack run record with error if it exists
		if (stackRunId) {
			try {
				const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
				const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
				
				if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
					const supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
					await supabaseClient.from('stack_runs').update({
						status: 'failed',
						error: { message: error instanceof Error ? error.message : String(error) },
						updated_at: new Date().toISOString()
					}).eq('id', stackRunId);
				}
			} catch (updateError) {
				hostLog(logPrefix, "error", `Failed to update stack_run status: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
			}
		}
		
		hostLog(logPrefix, "error", `Error executing task: ${error instanceof Error ? error.message : String(error)}`);
		throw error;
	} finally {
		// Clean up any remaining active handles
		try {
			if (activeHandles.length > 0) {
				hostLog(logPrefix, "info", `Cleaning up ${activeHandles.length} remaining handles`);
				
				for (const handle of activeHandles) {
					try {
						if (handle && handle.alive) {
							handle.dispose();
						}
					} catch (e) {
						// Ignore errors in final cleanup
						hostLog(logPrefix, "warn", `Error in handle cleanup: ${e}`);
					}
				}
			}
		} catch (e) {
			hostLog(logPrefix, "warn", `Error in active handles cleanup: ${e}`);
		}
		
		// Clean up QuickJS resources
		if (vm) {
			try {
				vm.dispose();
				hostLog(logPrefix, "info", "VM disposed");
			} catch (e) {
				hostLog(logPrefix, "warn", `Error disposing VM: ${e}`);
			}
		}
		if (runtime) {
			try {
				runtime.dispose();
				hostLog(logPrefix, "info", "Runtime disposed");
			} catch (e) {
				hostLog(logPrefix, "warn", `Error disposing runtime: ${e}`);
			}
		}
	}
}

/**
 * Helper function to save an ephemeral call to the stack_runs table
 * This standardizes how we handle all ephemeral calls throughout the codebase
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
		const logPrefix = "[__saveEphemeralCall__]";
		hostLog(logPrefix, "info", `Saving ephemeral call ${stackRunId} for ${serviceName}.${methodName}`);
		
		// Use the vm-state-manager to save the stack run
		const result = await saveVMState(
			vm, 
			stackRunId, 
			serviceName, 
			methodName, 
			args, 
			parentStackRunId, 
			parentTaskRunId
		);
		
		if (!result) {
			hostLog(logPrefix, "error", `Failed to save VM state for stack run ${stackRunId}`);
			return false;
		}
		
		hostLog(logPrefix, "info", `Successfully saved stack run ${stackRunId}`);
		return true;
	} catch (error: unknown) {
		hostLog("[__saveEphemeralCall__]", "error", `Error saving ephemeral call: ${error instanceof Error ? error.message : String(error)}`);
		// Don't throw to prevent the QuickJS VM from crashing
		return false;
	}
}

// Wrap task code in a module pattern
function wrapTaskCode(code: string): string {
  return `
    "use strict";
    const _module = { exports: null };
    const module = _module;
    const exports = {};
    const require = function(mod) { 
      if (mod === 'async') return { async: true };
      throw new Error('Cannot require ' + mod);
    };
    
    // Add additional context for debugging
    console.debug = console.log;
    console.warn = console.log;
    console.error = console.log;
    
    // Add Promise.allSettled if not available
    if (typeof Promise.allSettled !== 'function') {
      Promise.allSettled = function(promises) {
        return Promise.all(
          promises.map(p => 
            p
              .then(value => ({ status: 'fulfilled', value }))
              .catch(reason => ({ status: 'rejected', reason }))
          )
        );
      };
    }

    // Execute the task code
    ${code}
    
    // Set the exports
    _module.exports = exports;
    
    // Return the task function
    module.exports;
  `;
}

