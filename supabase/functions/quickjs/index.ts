// console.log("[Host Pre-Init] Loading quickjs/index.ts...");

import { corsHeaders } from "./cors.ts";
import {
	getQuickJS,
	newAsyncContext,
	QuickJSContext,
	QuickJSHandle,
	QuickJSRuntime,
	QuickJSAsyncContext,
} from "quickjs-emscripten";
import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";

// console.log("[Host Pre-Init] Imports completed for quickjs/index.ts.");

interface LogEntry {
	level: "log" | "error" | "warn" | "info" | "debug";
	message: string;
	source: "host" | "vm";
	data?: any[];
}

function simpleStringify(obj: any, space?: number | string): string {
	try {
		return JSON.stringify(
			obj,
			(key, value) => (typeof value === "bigint" ? value.toString() : value),
			space,
		);
	} catch (e) {
		console.error("[Host] simpleStringify Error:", e);
		return `{"error": "Failed to stringify object"}`;
	}
}

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
	const jsonString = simpleStringify(jsValue);
	const evalResult = context.evalCode(`JSON.parse(${JSON.stringify(jsonString)})`);
	if (evalResult.error) {
		console.error("[Host] Error parsing JSON via evalCode:", context.dump(evalResult.error));
		evalResult.error.dispose();
		return context.undefined;
	}
	if (handles) handles.push(evalResult.value); // Track handle if array provided
	return evalResult.value;
}

async function callNestedHostProxy(proxy: any, chain: string[], args: any[]): Promise<any> {
	// console.log(`[Host Helper] Reconstructing call: Chain=${chain.join('.')}...`); // VERBOSE
	let currentProxy = proxy;
	for (let i = 0; i < chain.length; i++) {
		const prop = chain[i];
		if (!currentProxy || typeof currentProxy[prop] === 'undefined') {
			throw new Error(`[Host Helper] Property '${prop}' not found in chain.`);
		}
		// console.log(`[Host Helper] Accessing proxy property: ${prop}`); // VERY VERBOSE
		currentProxy = currentProxy[prop];
	}
	// console.log(`[Host Helper] Invoking final proxy function with ${args.length} args.`); // VERBOSE
	const finalProxy = currentProxy(...args);
	// console.log(`[Host Helper] Awaiting the finalProxy to trigger execution...`); // VERBOSE
	const finalResult = await finalProxy;
	// Avoid logging potentially large results even at debug
	// console.log(`[Host Helper] Final result received:`, finalResult); // POTENTIALLY LARGE
	// console.log("debug", "host", `[Host Helper] Final result received for chain ${chain.join('.')}. Type: ${typeof finalResult}`); // Removed - console.log not defined here
	return finalResult; // Ensure function returns
}

Deno.serve(async (req: Request): Promise<Response> => {

	if (req.method === "OPTIONS") { console.log("[Host] Responding to OPTIONS request"); return new Response("ok", { headers: corsHeaders }); }

	let executionError: string | null = null;
	let executionResult: any = null;
	let finalResultHandle: QuickJSHandle | null = null;
	let runtime: QuickJSRuntime | null = null;
	let context: QuickJSAsyncContext | null = null;
	const handles: QuickJSHandle[] = [];
	const hostProxies: { [key: string]: any } = {}; // Store actual host proxies here

	// Define startTimestamp here so it's accessible in finally block
	try {
		//console.log("info", "host", "Processing request...");
		const { code, input = {}, modules = {}, serviceProxies = [], runtimeConfig = {} } = await req.json();
		const executionTimeoutSeconds = runtimeConfig.executionTimeoutSeconds ?? 360; // Default 36 seconds (doubled)
		// Removed verbose debug log of request body details
		// console.log("debug", "host", "Request body parsed.", [ ... ]); // REMOVED
		if (typeof code !== "string" || code.trim() === "") { throw new Error("Missing or empty 'code' property"); }
		if (!Array.isArray(serviceProxies)) { throw new Error("'serviceProxies' must be an array"); }
		if (!runtimeConfig || !runtimeConfig.supabaseUrl || !runtimeConfig.supabaseAnonKey) {
			console.log("error", "host", "Missing critical runtimeConfig properties (supabaseUrl, supabaseAnonKey)", [runtimeConfig]);
			throw new Error("Missing critical runtimeConfig properties");
		}

		// Reduce verbosity - initializing QuickJS is expected
		// console.log("debug", "host", "Initializing QuickJS WASM module..."); // REMOVED
		const quickjs = await getQuickJS();
		// console.log("debug", "host", "QuickJS WASM module initialized."); // REMOVED

		//console.log("debug", "host", "Setting up QuickJS Async context...");
		context = await newAsyncContext();
		if (!context) {
			throw new Error("Failed to create QuickJSAsyncContext");
		}
		const ctx: QuickJSAsyncContext = context;
		runtime = context.runtime;
		if (!runtime) {
			throw new Error("Failed to get runtime from QuickJSAsyncContext");
		}
		const rt = runtime;

		rt.setMemoryLimit(8 * 1024 * 1024); // Doubled memory limit to 512MB
		rt.setMaxStackSize(2 * 1024 * 1024); // Doubled stack size to 2MB
		// console.log("debug", "host", "Runtime limits set."); // REMOVED

		// --- Create Host-Side Service Proxies ---
		// console.log("debug", "host", "Creating host-side service proxies..."); // REMOVED
		try {
			for (const proxyConfig of serviceProxies) {
				if (!proxyConfig.name || !proxyConfig.baseUrl) {
					console.log("warn", "host", "Skipping invalid service proxy config (missing name or baseUrl)", [proxyConfig]);
					continue;
				}
				hostProxies[proxyConfig.name] = createServiceProxy(proxyConfig.name, {
					baseUrl: proxyConfig.baseUrl,
				headers: proxyConfig.headers || {},
				});
				// console.log("debug", "host", `Created host proxy for '${proxyConfig.name}'`); // REMOVED
			}
		} catch (proxyError) {
			console.log("error", "host", "Error creating host service proxies", [proxyError]);
			throw new Error(`Failed to create service proxies: ${proxyError instanceof Error ? proxyError.message : String(proxyError)}`);
		}

		// --- Inject Globals ---

		// Console Patch
		// console.log("debug", "host", "Injecting globals (console, config, input, fetch, timers, tools, require)..."); // REMOVED
		const consoleHandle = ctx.newObject(); handles.push(consoleHandle);

		// Define ONE function factory for all console levels
		const logFn = (level: LogEntry["level"]) => ctx.newFunction(level, (...argsHandles: QuickJSHandle[]) => {
			// Only log to host console, don't add to returned logs unless it's an error
			try {
				// --- OPTIMIZATION: Only dump args for errors ---
				if (level === 'error') {
					const args = argsHandles.map(h => ctx.dump(h));
					// Add VM errors to the main logs
					console.log(level, "vm", `console.error`, args);
				} else {
					// --- OPTIMIZATION: Assume first arg is string for non-errors, skip typeof ---
					// For other levels, log only the first argument if it's a string (the message)
					// This avoids potentially expensive dumping of complex objects for info/debug logs
					let message = `[VM] [${level.toUpperCase()}]`;
					try {
						if (argsHandles.length > 0) {
							// Directly try getString, catch if it fails (e.g., not a string)
							message += ` ${ctx.getString(argsHandles[0])}`;
						}
					} catch (_e) {
						// Ignore error if first arg wasn't a string
						if (argsHandles.length > 0) {
							message += ` (Non-string first arg)`;
						}
					}
					// Log other levels only to the host console for debugging - comment out by default
					// console.log(message); // REMOVED
				}
			} catch (e) {
				// Log errors during the dump itself to host console and potentially main logs
				const errorMsg = e instanceof Error ? e.message : String(e);
				console.error(`[HOST] [ERROR] Error during console.${level} dump`, errorMsg);
				console.log("error", "host", `Error during console.${level} dump`, [errorMsg]);
			}
		});

		// Create handles using the factory and track them
		const logHandle = logFn("log"); handles.push(logHandle);
		const errorHandle = logFn("error"); handles.push(errorHandle);
		const warnHandle = logFn("warn"); handles.push(warnHandle);
		const infoHandle = logFn("info"); handles.push(infoHandle);
		const debugHandle = logFn("debug"); handles.push(debugHandle);

		// Set properties on the consoleHandle using the created handles
		ctx.setProp(consoleHandle, "log", logHandle);
		ctx.setProp(consoleHandle, "error", errorHandle);
		ctx.setProp(consoleHandle, "warn", warnHandle);
		ctx.setProp(consoleHandle, "info", infoHandle);
		ctx.setProp(consoleHandle, "debug", debugHandle);

		// Set the global console object
		ctx.setProp(ctx.global, "console", consoleHandle);

		// Runtime Config
		const injectedRuntimeConfigHandle = createHandleFromJsonNoTrack(ctx, runtimeConfig, handles); handles.push(injectedRuntimeConfigHandle);
		ctx.setProp(ctx.global, "__runtimeConfig__", injectedRuntimeConfigHandle);

		// Input
		const inputObjectHandle = createHandleFromJsonNoTrack(ctx, input, handles); handles.push(inputObjectHandle);
		ctx.setProp(ctx.global, "__input__", inputObjectHandle);

		// Fetch Patch (uses Deno fetch)
		const fetchFn = (urlHandle: QuickJSHandle, optionsHandle?: QuickJSHandle): QuickJSHandle => {
			if (!ctx?.alive || !rt?.alive) {
				// Log error directly, don't add to logs array unless critical path
				console.error("[HOST] [ERROR] [fetch Patch] Runtime/Context disposed before call.");
				const earlyError = ctx.newError("Runtime disposed");
				handles.push(earlyError);
				const earlyPromise = ctx.newPromise();
				handles.push(earlyPromise.handle);
				earlyPromise.reject(earlyError);
				Promise.resolve().then(() => rt?.executePendingJobs());
				return earlyPromise.handle;
			}

			const deferred = ctx.newPromise();
			handles.push(deferred.handle);

			const runPendingJobs = () => {
				if (rt?.alive) {
					try {
						const jobResult = rt.executePendingJobs();
						if (jobResult.error) {
							let dump = "Context disposed?";
							try {
								dump = ctx?.dump(jobResult.error) ?? dump;
							} catch (_e) { /* Ignore dump errors */ }
							// Log error directly
							console.error("[HOST] [ERROR] [fetch Patch] Error executing pending jobs after fetch promise settlement:", dump);
							jobResult.error.dispose();
						}
					} catch (jobError) {
						console.error("[HOST] [ERROR] [fetch Patch] Exception during executePendingJobs after fetch promise settlement:", jobError);
					}
				} else {
					// console.warn("[HOST] [WARN] [fetch Patch] Runtime disposed before executePendingJobs after fetch promise settlement."); // REMOVED Warning
				}
			};
			deferred.settled.then(runPendingJobs);

			// Extract url and options eagerly, but perform fetch async
			let url: string;
			let options: RequestInit;
			try {
				url = ctx.getString(urlHandle);
				options = optionsHandle ? ctx.dump(optionsHandle) : {};
				// Log VM fetch calls directly - remove for less noise
				// console.log(`[VM] fetch called: ${url}`, options); // REMOVED
			} catch (dumpError) {
				if (!ctx?.alive || !deferred.handle.alive) return deferred.handle;
				const dumpErrorHandle = createHandleFromJsonNoTrack(ctx, dumpError, handles);
				handles.push(dumpErrorHandle);
				deferred.reject(dumpErrorHandle);
				return deferred.handle;
			}

			// Actual fetch happens async
			fetch(url, options).then(async response => {
				if (!ctx?.alive || !deferred.handle.alive) {
					console.warn("[HOST] [WARN] [fetch Patch] Context/Promise disposed before fetch response processing.");
					return;
				}
				const localHandles: QuickJSHandle[] = []; // Handles for this async block
				try {
					// --- OPTIMIZATION: Use evalCode to create base response object --- 
					const responseEvalResult = ctx.evalCode(`({
						status: ${response.status},
						statusText: ${JSON.stringify(response.statusText)},
						ok: ${response.ok},
						url: ${JSON.stringify(response.url)}
					})`);
					if (responseEvalResult.error) {
						localHandles.push(responseEvalResult.error);
						throw new Error(`Fetch response object creation failed: ${ctx.dump(responseEvalResult.error)}`);
					}
					const r = responseEvalResult.value; // This is our base response handle
					localHandles.push(r);
					// ----------------------------------------------------------------

					// --- OPTIMIZATION: Process Headers using JSON stringify/parse ---
					const headersObj: { [key: string]: string } = {};
					for (const [k, v] of response.headers.entries()) {
						headersObj[k] = v;
					}
					const headersJson = simpleStringify(headersObj);
					const headersEvalResult = ctx.evalCode(`JSON.parse(${JSON.stringify(headersJson)})`);
					if (headersEvalResult.error) {
						const errDump = ctx.dump(headersEvalResult.error);
						headersEvalResult.error.dispose();
						throw new Error(`Fetch headers object creation failed: ${errDump}`);
					}
					const h = headersEvalResult.value;
					localHandles.push(h);
					// -------------------------------------------------------------
					ctx.setProp(r, "headers", h);

					// Body methods need to be functions that return handles
					const bodyText = await response.text(); // Read body once
					const textFn = ctx.newFunction('text', () => {
						if (!ctx?.alive) throw new Error("Context disposed");
						const textHandle = ctx.newString(bodyText);
						handles.push(textHandle);
						return textHandle;
					});
					localHandles.push(textFn); ctx.setProp(r, 'text', textFn);
					const jsonFn = ctx.newFunction('json', () => {
						if (!ctx?.alive) throw new Error("Context disposed");
						try {
							const jsonEvalResult = ctx.evalCode(`(${bodyText})`);
							if (jsonEvalResult.error) {
								const parseErrorHandle = jsonEvalResult.error;
								handles.push(parseErrorHandle);
								throw new Error(`JSON parse error: ${JSON.stringify(ctx.dump(parseErrorHandle))}`);
							}
							handles.push(jsonEvalResult.value);
							return jsonEvalResult.value;
						} catch (e) {
							const m = e instanceof Error ? e.message : String(e);
							const qe = ctx.newError(m); handles.push(qe);
							throw qe; // Throw the QuickJS error handle
						}
					});
					localHandles.push(jsonFn); ctx.setProp(r, 'json', jsonFn);
					const responseHandle = r;

					if (ctx?.alive && deferred.handle.alive) {
						// Reduce verbosity
						// console.log("debug", "host", "[fetch Patch] Resolving VM promise.");
						deferred.resolve(responseHandle);
						try {
							if (rt?.alive) {
								// Reduce verbosity
								// console.log("debug", "host", "[fetch Patch] Running pending jobs after resolve.");
								const jobResult = rt.executePendingJobs();
								if (jobResult.error) { ctx.dump(jobResult.error); jobResult.error.dispose(); }
							} else {
								console.warn("[HOST] [WARN] [fetch Patch] Runtime not alive for post-resolve executePendingJobs.");
							}
						} catch (e) {
							console.error("[HOST] [ERROR] [fetch Patch] Exception in post-resolve executePendingJobs", e);
						}
					} else {
						console.warn("[HOST] [WARN] [fetch Patch] Context/Promise disposed before resolving.");
					}
				} catch (processError) {
					console.log("error", "host", "[fetch Patch] Error processing fetch response", [processError]);
					if (ctx?.alive && deferred.handle.alive) {
						const errorHandle = createHandleFromJsonNoTrack(ctx, processError, handles);
						handles.push(errorHandle);
						deferred.reject(errorHandle);
						try {
							if (rt?.alive) {
								// Reduce verbosity
								// console.log("debug", "host", "[fetch Patch] Running pending jobs after reject (processing error).");
								const jobResult = rt.executePendingJobs();
								if (jobResult.error) { ctx.dump(jobResult.error); jobResult.error.dispose(); }
							} else {
								console.warn("[HOST] [WARN] [fetch Patch] Runtime not alive for post-reject executePendingJobs.");
							}
						} catch (e) {
							console.error("[HOST] [ERROR] [fetch Patch] Exception in post-reject executePendingJobs", e);
						}
					} else {
						console.warn("[HOST] [WARN] [fetch Patch] Context/Promise disposed before rejecting (processing error).");
					}
				} finally {
					localHandles.forEach(h => { if (h?.alive) h.dispose(); });
				}
			}).catch(networkError => {
				console.log("error", "host", `[fetch Patch] Network error during fetch for ${url}`, [networkError]);
				if (ctx?.alive && deferred.handle.alive) {
					const errorHandle = createHandleFromJsonNoTrack(ctx, networkError, handles);
					handles.push(errorHandle);
					deferred.reject(errorHandle);
					try {
						if (rt?.alive) {
							// Reduce verbosity
							// console.log("debug", "host", "[fetch Patch] Running pending jobs after reject (network error).");
							const jobResult = rt.executePendingJobs();
							if (jobResult.error) { ctx.dump(jobResult.error); jobResult.error.dispose(); }
						} else {
							console.warn("[HOST] [WARN] [fetch Patch] Runtime not alive for post-reject executePendingJobs.");
						}
					} catch (e) {
						console.error("[HOST] [ERROR] [fetch Patch] Exception in post-reject executePendingJobs", e);
					}
				} else {
					console.warn("[HOST] [WARN] [fetch Patch] Context/Promise disposed before rejecting (network error).");
				}
			});

			return deferred.handle;
		};

		const fetchHandle = ctx.newFunction("fetch", fetchFn);
		handles.push(fetchHandle);
		ctx.setProp(ctx.global, "fetch", fetchHandle);

		// --- Timer Injection ---
		// console.log("debug", "host", "Injecting setTimeout and clearTimeout..."); // REMOVED
		const activeTimers = new Map<number, number>();
		let nextVmTimerId = 1;

		const setTimeoutVm = (
			callbackHandle: QuickJSHandle,
			delayHandle: QuickJSHandle,
			...argsHandles: QuickJSHandle[]
		) => {
			if (!ctx?.alive || !rt?.alive) {
				console.error("[HOST] [ERROR] [setTimeout] Runtime/Context disposed.");
				return ctx.newNumber(0);
			}
			if (ctx.typeof(callbackHandle) !== "function") {
				console.error("[HOST] [ERROR] [setTimeout] Provided callback is not a function.");
				return ctx.newNumber(0);
			}
			const delay = ctx.getNumber(delayHandle);
			const vmTimerId = nextVmTimerId++;

			const persistentCallbackHandle = callbackHandle.dup();
			// --- OPTIMIZATION: Don't add setTimeout handles to global list ---
			// handles.push(persistentCallbackHandle); // REMOVED from global tracking
			const persistentArgsHandles = argsHandles.map(arg => {
				const dupArg = arg.dup();
				// handles.push(dupArg); // REMOVED from global tracking
				return dupArg;
			});

			const hostTimerId = setTimeout(() => {
				activeTimers.delete(vmTimerId); // Delete timer ID immediately

				if (!ctx?.alive || !rt?.alive || !persistentCallbackHandle.alive) {
					// Reduce verbosity
					// console.warn(`[HOST] [WARN] [setTimeout Callback ${vmTimerId}] Runtime/Context/Callback disposed before execution.`);
					// --- Dispose handles locally --- 
					if (persistentCallbackHandle?.alive) persistentCallbackHandle.dispose();
					persistentArgsHandles.forEach(h => { if (h?.alive) h.dispose(); });
					return;
				}
				// Reduce verbosity
				// console.log(`[HOST] [DEBUG] [setTimeout Callback ${vmTimerId}] Executing...`);
				let result: { value?: QuickJSHandle, error?: QuickJSHandle } | null = null;
				try {
					result = ctx.callFunction(persistentCallbackHandle, ctx.undefined, ...persistentArgsHandles);
				} catch (callError) {
					console.log("error", "vm", `[setTimeout Callback ${vmTimerId}] Exception during callFunction:`, [callError]);
					// Ensure handles are disposed even if callFunction throws
				} finally {
					// --- Dispose handles locally --- 
					if (persistentCallbackHandle?.alive) persistentCallbackHandle.dispose();
					persistentArgsHandles.forEach(h => { if (h?.alive) h.dispose(); });
				}

				// Process result after handles are disposed (if result exists)
				if (result) {
					if (result.error) {
						// Only dump error if context is still alive
						const errorDump = ctx?.alive ? ctx.dump(result.error) : "Context disposed";
						console.log("error", "vm", `[setTimeout Callback ${vmTimerId}] Error during execution:`, [errorDump]);
						if (result.error.alive) result.error.dispose(); // Dispose error handle
					} else {
						// Reduce verbosity
						// console.log(`[HOST] [DEBUG] [setTimeout Callback ${vmTimerId}] Execution finished. Disposing result.`);
						if (result.value?.alive) result.value.dispose(); // Dispose success handle
					}
				}

				// Job execution after callback
				try {
					if (rt?.alive) {
						// Reduce verbosity
						// console.log(`[HOST] [DEBUG] [setTimeout Callback ${vmTimerId}] Running pending jobs after callback.`);
						const jobResult = rt.executePendingJobs();
						if (jobResult.error) {
							console.error("[HOST] [ERROR] [setTimeout Callback] Error in post-callback executePendingJobs", ctx?.dump(jobResult.error));
							jobResult.error.dispose();
						}
					} else {
						// console.warn("[HOST] [WARN] [setTimeout Callback] Runtime not alive for post-callback executePendingJobs.");
					}
				} catch (e) {
					console.error("[HOST] [ERROR] [setTimeout Callback] Exception in post-callback executePendingJobs", e);
				}

			}, delay);

			activeTimers.set(vmTimerId, hostTimerId);
			// Removed repetitive timer scheduling log
			// console.log(`[VM] setTimeout scheduled timer ${vmTimerId} (Host ID: ${hostTimerId}) for ${delay}ms`);
			return ctx.newNumber(vmTimerId);
		};

		const clearTimeoutVm = (vmTimerIdHandle: QuickJSHandle) => {
			if (!ctx?.alive) {
				console.error("[HOST] [ERROR] [clearTimeout] Context disposed.");
				return;
			}
			const vmTimerId = ctx.getNumber(vmTimerIdHandle);
			const hostTimerId = activeTimers.get(vmTimerId);
			if (hostTimerId) {
				clearTimeout(hostTimerId);
				activeTimers.delete(vmTimerId);
				// Removed repetitive timer clearing log
				// console.log(`[VM] clearTimeout cleared timer ${vmTimerId} (Host ID: ${hostTimerId})`);
			} else {
				// Log warning directly
				// console.warn(`[VM] [WARN] [clearTimeout] Timer ID ${vmTimerId} not found or already cleared.`);
			}
		};

		// Inject into global scope
		const setTimeoutHandle = ctx.newFunction("setTimeout", setTimeoutVm);
		handles.push(setTimeoutHandle);
		ctx.setProp(ctx.global, "setTimeout", setTimeoutHandle);

		const clearTimeoutHandle = ctx.newFunction("clearTimeout", clearTimeoutVm);
		handles.push(clearTimeoutHandle);
		ctx.setProp(ctx.global, "clearTimeout", clearTimeoutHandle);

		// console.log("debug", "host", "setTimeout and clearTimeout injected."); // REMOVED
		// --- End Timer Injection ---

		// Placeholder module object - Reduced verbosity
		// console.log("debug", "host", "Injecting placeholder module object..."); // REMOVED
		const moduleObjHandle = ctx.newObject(); handles.push(moduleObjHandle);
		ctx.setProp(moduleObjHandle, "exports", ctx.undefined);
		ctx.setProp(ctx.global, "module", moduleObjHandle);

		// --- Tools Injection --- (Polling based)
		// console.log("debug", "host", "Injecting 'tools' object and request polling functions..."); // REMOVED
		const toolsHandle = ctx.newObject(); handles.push(toolsHandle);
		ctx.setProp(ctx.global, "tools", toolsHandle);

		// --- Request tracking system --- No change needed here, logs are internal
		const pendingRequests = new Map();
		let requestCounter = 0;
		function generateRequestId() {
			// --- OPTIMIZATION: Remove Date.now() if only per-invocation uniqueness needed ---
			return `req_${requestCounter++}`;
		}

		// --- Inject __registerHostRequest__ function --- No change needed here, logs are internal
		const registerHostRequestFn = (serviceNameHandle: QuickJSHandle, propChainHandle: QuickJSHandle, argsHandle: QuickJSHandle) => {
			if (!ctx?.alive || !rt?.alive) { /* ... */ throw ctx.newError("Runtime disposed"); }
			let serviceName: string, propChain: any[], args: any[];
			try {
				serviceName = ctx.getString(serviceNameHandle);
				propChain = ctx.dump(propChainHandle);
				args = ctx.dump(argsHandle);
				if (!Array.isArray(propChain) || !Array.isArray(args)) { throw new Error("Invalid propChain or args"); }
			} catch (dumpError) { /* ... */ throw new Error(`Failed to get arguments: ...`); }
			const requestId = generateRequestId();
			let methodChain: string[];
			if (propChain.every(item => typeof item === 'string')) { methodChain = propChain; }
			else { methodChain = propChain.map(item => typeof item === 'object' && item !== null && 'property' in item ? item.property : String(item)); }

			// Log registration directly - Removed for less noise
			// console.log(`[HOST] [DEBUG] Registering host request: ${requestId} for ${serviceName}.${methodChain.join('.')} with ${args.length} args`); // REMOVED
			pendingRequests.set(requestId, { status: 'pending' });
			const proxy = hostProxies[serviceName];
			if (!proxy) {
				console.log("error", "host", `Host proxy not found for service: ${serviceName}`);
				pendingRequests.set(requestId, { status: 'rejected', error: `Host proxy not found for service: ${serviceName}` });
				return ctx.newString(requestId);
			}
			callNestedHostProxy(proxy, methodChain, args)
				.then(result => {
					//console.log(`[HOST] [DEBUG] Request ${requestId} fulfilled for ${serviceName}.${methodChain.join('.')}`);
					pendingRequests.set(requestId, { status: 'fulfilled', value: result });
				})
				.catch(error => {
					const message = error instanceof Error ? error.message : String(error);
					console.log("error", "host", `Request ${requestId} rejected for ${serviceName}.${methodChain.join('.')}: ${message}`);
					pendingRequests.set(requestId, { status: 'rejected', error: message });
					});
			return ctx.newString(requestId);
		};

		// --- Inject __checkHostRequestStatus__ function --- No change needed here, logs are internal
		const checkHostRequestStatusFn = (requestIdHandle: QuickJSHandle) => {
			if (!ctx?.alive || !rt?.alive) { 
				console.error("[HOST] [ERROR] checkHostRequestStatus: Context/Runtime disposed");
				throw ctx.newError("Runtime disposed"); 
			}
			let requestId: string;
			try { requestId = ctx.getString(requestIdHandle); } catch (dumpError: any) { throw new Error(`Failed to get request ID: ${dumpError?.message || dumpError}`); }
			const request = pendingRequests.get(requestId) || { status: 'pending' };
			const resultHandle = ctx.newObject(); handles.push(resultHandle);
			const statusHandle = ctx.newString(request.status); handles.push(statusHandle);
			ctx.setProp(resultHandle, 'status', statusHandle);
			if (request.status === 'fulfilled') {
				const valueHandle = createHandleFromJsonNoTrack(ctx, request.value, handles);
				handles.push(valueHandle);
				ctx.setProp(resultHandle, 'value', valueHandle);
				pendingRequests.delete(requestId);
			} else if (request.status === 'rejected') {
				const errorHandle = ctx.newString(request.error); handles.push(errorHandle);
				ctx.setProp(resultHandle, 'error', errorHandle);
				pendingRequests.delete(requestId);
			}
			return resultHandle;
		};

		// Register the functions - Reduced verbosity
		const registerHostRequestHandle = ctx.newFunction('__registerHostRequest__', registerHostRequestFn);
		handles.push(registerHostRequestHandle);
		ctx.setProp(ctx.global, "__registerHostRequest__", registerHostRequestHandle);
		const checkHostRequestStatusHandle = ctx.newFunction('__checkHostRequestStatus__', checkHostRequestStatusFn);
		handles.push(checkHostRequestStatusHandle);
		ctx.setProp(ctx.global, "__checkHostRequestStatus__", checkHostRequestStatusHandle);
		// console.log("debug", "host", "Polling functions injected."); // REMOVED

		// --- Populate VM 'tools' object --- Reduced verbosity
		// console.log("debug", "host", "Populating VM 'tools' object with service proxies..."); // REMOVED
		const vmProxyGeneratorCode = `
(serviceName) => {
  function createPropertyProxy(path = []) {
    const baseFunction = function(...args) {
       const methodName = path.length > 0 ? path[path.length - 1] : '(root)';
       const methodPath = path;
       // Log VM proxy calls directly - Remove for less noise
       // console.log('[VM] Proxy call:', serviceName + '.' + methodPath.join('.'), 'with args:', args.length); // REMOVED

       const requestId = __registerHostRequest__(serviceName, methodPath, args);
       // Log request ID directly - Remove for less noise
       // console.log('[VM] Registered request:', requestId); // REMOVED

          return new Promise((resolve, reject) => {
            let attempts = 0;
            const maxAttempts = 15000; // ~30 seconds -> Adjusted to 15000 attempts * ~20ms = ~300 seconds (5 min) - generous
            function checkResult() {
              attempts++;
              const result = __checkHostRequestStatus__(requestId);
              if (result.status === 'pending') {
                 // --- OPTIMIZATION: Increase polling interval ---
                 const interval = 2 ** (4+attempts); // Increased from 4/8 to 10/20
                 if (attempts < maxAttempts) {
                   setTimeout(checkResult, interval);
                 } else {
                   // Log timeout error directly
                   console.error('[VM] Proxy request timed out:', serviceName + '.' + methodPath.join('.'));
                   reject(new Error('Request timed out after ' + maxAttempts + ' polling attempts for ' + serviceName + '.' + methodPath.join('.')));
                 }
              } else if (result.status === 'fulfilled') {
                resolve(result.value);
              } else {
                 // Log host error directly
                 console.error('[VM] Host request failed:', serviceName + '.' + methodPath.join('.'), result.error);
                 reject(new Error('Host request failed for ' + serviceName + '.' + methodPath.join('.') + ': ' + result.error));
              }
            }
            checkResult();
          });
    };

    return new Proxy(baseFunction, {
      get: function(target, prop, receiver) {
        if (typeof prop === 'symbol' || prop === 'then' || prop === 'catch' || prop === 'finally' || prop === 'toJSON' || prop === 'apply' || prop === 'call' || prop === 'bind') {
          return Reflect.get(target, prop, receiver);
        }
        const newPath = [...path, prop];
        return createPropertyProxy(newPath);
      }
    });
  }
  return createPropertyProxy();
}
`;
		const vmProxyGeneratorResult = ctx.evalCode(vmProxyGeneratorCode);
		if (vmProxyGeneratorResult.error) {
		  console.log("error", "host", "Failed to evaluate VM proxy generator code");
		  vmProxyGeneratorResult.error.dispose();
		  throw new Error("Failed to setup VM proxies");
		}
		const vmProxyGeneratorHandle = vmProxyGeneratorResult.value;
		handles.push(vmProxyGeneratorHandle);

		for (const service of serviceProxies) {
			const serviceName = service.name;
			if (!serviceName) continue;
			// console.log("debug", "host", `Creating VM proxy for service: ${serviceName}`);
			const serviceNameHandle = ctx.newString(serviceName);
			handles.push(serviceNameHandle);
			const vmProxyResult = ctx.callFunction(vmProxyGeneratorHandle, ctx.undefined, serviceNameHandle);
			if (vmProxyResult.error) {
				console.log("error", "host", `Failed to create VM proxy for ${serviceName}`, [ctx.dump(vmProxyResult.error)]);
				vmProxyResult.error.dispose();
				serviceNameHandle.dispose();
				continue;
			}
			const vmProxyHandle = vmProxyResult.value;
			handles.push(vmProxyHandle);
			ctx.setProp(toolsHandle, serviceName, vmProxyHandle);
			// console.log("debug", "host", `VM proxy created for ${serviceName}.`);
		}
		vmProxyGeneratorHandle.dispose();
		// console.log("debug", "host", "Finished populating VM 'tools' object.");


		// Module Loader / Require Setup - Reduced verbosity
		// console.log("debug", "host", "Setting up module loader..."); // REMOVED
		const requireGeneratorFuncStr = `
			function() { // Define as a function to be called later
				const moduleCache = {};
				const injectedModules = __injectedModules__; // Assume this is globally available

				function require(id) {
					const resolvedId = id.startsWith('./') ? id.substring(2) : id;
					if (resolvedId !== 'tasks') {
						// Log error directly
						console.error('[VM require] Attempted to require unexpected module:', resolvedId);
						throw new Error("Only the tasks module can be required currently. Got: " + resolvedId);
					}

					if (moduleCache[resolvedId]) return moduleCache[resolvedId];

					const moduleCode = injectedModules[resolvedId];
					if (!moduleCode) {
						 // Log error directly
						 console.error('[VM require] Module not found:', resolvedId);
						 throw new Error('Module not found: ' + resolvedId);
					}

					const module = { exports: {} };
					// Use Function constructor - seems necessary for module scope
					const moduleWrapper = new Function('module', 'exports', 'require', moduleCode);
					moduleWrapper(module, module.exports, require);

					moduleCache[resolvedId] = module.exports;
					return module.exports;
				}
				// This inner function is what we want to return and assign to global require
				return require;
			}
		`;

		// --- OPTIMIZATION: Use NoTrack version for potentially faster module injection ---
		const modulesHandle = createHandleFromJsonNoTrack(ctx, modules, handles);
		ctx.setProp(ctx.global, "__injectedModules__", modulesHandle);

		// console.log("debug", "host", "Evaluating require generator..."); // REMOVED
		const requireGeneratorEvalResult = ctx.evalCode(`(${requireGeneratorFuncStr})`);
		if (requireGeneratorEvalResult.error) {
			handles.push(requireGeneratorEvalResult.error);
			const errDump = ctx.dump(requireGeneratorEvalResult.error);
			console.log("error", "host", "Failed to evaluate require generator function code", [errDump]);
			throw new Error("Failed to evaluate require generator");
		}
		const requireGeneratorHandle = requireGeneratorEvalResult.value;
		handles.push(requireGeneratorHandle);

		// console.log("debug", "host", "Calling require generator..."); // REMOVED
		const requireCallResult = ctx.callFunction(requireGeneratorHandle, ctx.global);
		if (requireCallResult.error) {
			handles.push(requireCallResult.error as QuickJSHandle);
			const errDump = ctx.dump(requireCallResult.error as QuickJSHandle);
			console.log("error", "host", "Failed to call require generator function", [errDump]);
			throw new Error("Failed to call require generator function");
		}
		const requireHandle = requireCallResult.value as QuickJSHandle;
		handles.push(requireHandle);

		ctx.setProp(ctx.global, "require", requireHandle);
		// console.log("debug", "host", "Global injections complete."); // REMOVED

		// --- Execute Task Code ---
		//console.log("info", "host", "Executing user code...");
		// Wrapped code remains the same - VM logs within it are now mostly console.log only
		const wrappedCode = `
(async () => {
  try {
    let taskFunction;
    const module = { exports: undefined };
    {
      ${code}
    }
    if (typeof module.exports === 'function') {
      // Log VM execution start directly - Remove for less noise
      // console.log('[VM] Task function found. Executing...');
      // Pass input AND context object { tools, require, module } as second argument
      const resultPromiseOrValue = module.exports(
          globalThis.__input__ || {},
          { 
              tools: globalThis.tools, 
              require: globalThis.require, 
              module: globalThis.module, 
              // Add other context if needed
          }
      );
      if (resultPromiseOrValue && typeof resultPromiseOrValue.then === 'function') {
        // console.log('[VM] Task returned a Promise. Awaiting...'); // REMOVED
        const finalResult = await resultPromiseOrValue;
        // console.log('[VM] Task Promise resolved. Assigning to __result__.'); // REMOVED
        globalThis.__result__ = finalResult;
    } else {
        // console.log('[VM] Task returned non-Promise. Assigning to __result__.'); // REMOVED
        globalThis.__result__ = resultPromiseOrValue;
    }
    } else {
      // console.log('[VM] module.exports not a function. Assigning to __result__.'); // REMOVED
      globalThis.__result__ = module.exports;
    }
    // console.log('[VM] Wrapper execution finished.'); // REMOVED
  } catch (err) {
    // Log VM error directly
    console.error('[VM] Task execution error:', err instanceof Error ? err.message : String(err), err instanceof Error ? err.stack : '');
    globalThis.__execution_error__ = {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
    };
  }
})();
`;
		//console.log("debug", "host", "Evaluating user code ASYNCHRONOUSLY...");

		const evalPromise = ctx.evalCodeAsync(wrappedCode, "task.js");

		// --- Wait for initial evaluation and process all subsequent jobs/timers ---
		// console.log("debug", "host", "Waiting for initial evaluation promise..."); // REMOVED
		let evalResult = await evalPromise;

		//console.log("info", "host", "Initial promise settled. Processing remaining jobs/timers (timeout: ${executionTimeoutSeconds}s)...");
		const safetyBreakMax = executionTimeoutSeconds * 100; // Approx counter limit based on 10ms yields
		let safetyBreak = safetyBreakMax;
		let jobLoopErrorHandle: QuickJSHandle | null = null;

		try {
			while (rt?.alive && safetyBreak > 0) {
				safetyBreak--;
				let jobsProcessed = 0;
				do {
					 const jobsResult = rt.executePendingJobs();
					 if (jobsResult.error) {
						 const errorDump = ctx.dump(jobsResult.error);
						 console.log("error", "host", "Error during executePendingJobs:", [errorDump]);
						 jobLoopErrorHandle = jobsResult.error;
						 executionError = `QuickJS job execution error: ${simpleStringify(errorDump)}`;
					break;
				}
					 jobsProcessed = jobsResult.value;
					 // Remove per-job log
					 // if (jobsProcessed > 0) { console.log("debug", "host", `Inner loop: Processed ${jobsProcessed} pending jobs.`); }
				} while (jobsProcessed > 0 && rt?.alive);

				if (executionError) { break; }

				if (activeTimers.size > 0 && rt?.alive) {
					// Log timer status less frequently
					// if (Date.now() - lastTimerLogTime > 15000) { // Log every 15 seconds if timers are active // REMOVED Debug log
					// 	console.log("debug", "host", `QuickJS idle but ${activeTimers.size} timers active. Yielding to host...`); // REMOVED Debug log
					// 	lastTimerLogTime = Date.now(); // REMOVED Debug log
					// }
					await new Promise(resolve => setTimeout(resolve, 10));
					continue;
				} else {
					 // console.log("debug", "host", "QuickJS idle and no active timers. Exiting job/timer loop."); // REMOVED Debug log
					 break;
				}
			} // End while loop

			if (safetyBreak <= 0) {
				console.log("warn", "host", "Safety break triggered during job/timer processing loop.");
				executionError = `Task timed out after ${executionTimeoutSeconds}s (job/timer processing loop safety break).`;
			}

		} catch (loopError) {
			console.log("error", "host", "Exception during job/timer processing loop:", [loopError]);
			executionError = `Host exception during job/timer processing: ${loopError instanceof Error ? loopError.message : String(loopError)}`;
		}
		//console.log("info", "host", "Exited job/timer processing loop.");


		// --- Process Final Result --- (Keep this logic, logging is important here)
		// console.log("debug", "host", "Processing final result..."); // REMOVED
		if (executionError) {
			 console.log("error", "host", `Task execution failed due to prior error: ${executionError}`);
			 if (jobLoopErrorHandle) {
				 finalResultHandle = jobLoopErrorHandle;
             } else { /* finalResultHandle remains null */ }
		} else if (evalResult && 'error' in evalResult) {
		    // console.log("error", "host", "Task execution failed (initial evalPromise rejected)."); // Redundant if error is dumped below
 		    // Handle potential undefined error handle
 		    const errorHandle = evalResult.error;
 		    if (errorHandle && errorHandle.alive) {
		        const errorDump = ctx.dump(errorHandle);
		        console.log("error", "host", "Task execution failed (initial eval error)", [errorDump]);
			    executionError = simpleStringify(errorDump);
			    finalResultHandle = errorHandle; // Assign only if valid
		    } else {
		        console.log("error", "host", "Task execution failed (initial eval error), but error handle was invalid/undefined.");
		        executionError = "Evaluation failed with invalid error handle";
		        finalResultHandle = null; // Ensure it's null
		    }
		} else {
            //console.log("info", "host", "Attempting to retrieve globalThis.__result__ after job loop...");
            let resultHandleAfterLoop: QuickJSHandle | undefined;
            try {
                resultHandleAfterLoop = ctx.getProp(ctx.global, "__result__");
                if (resultHandleAfterLoop && resultHandleAfterLoop.alive && ctx.typeof(resultHandleAfterLoop) !== 'undefined') {
                    // console.log("info", "host", "__result__ handle obtained. Dumping..."); // REMOVED - Less noise
                    try {
                        executionResult = ctx.dump(resultHandleAfterLoop);
						// Log success concisely
                        //console.log("info", "host", "Successfully dumped __result__.");
						// Keep preview in debug console only
						//console.log('[HOST] [DEBUG] Result Preview:', JSON.stringify(executionResult).slice(0, 200) + '...');
                        finalResultHandle = resultHandleAfterLoop;
                    } catch (dumpError: any) {
                        const msg = dumpError?.message || dumpError;
                        //console.log("error", "host", "Failed to DUMP __result__ handle after loop:", [msg]);
                        executionError = `Failed to dump final result: ${msg}`;
                        finalResultHandle = resultHandleAfterLoop;
                    }
                } else {
                    // Check for __execution_error__ from VM first, then fallback to initial value if no __result__
                    let vmErrorHandle: QuickJSHandle | undefined;
                    try {
                        vmErrorHandle = ctx.getProp(ctx.global, "__execution_error__");
                        if (vmErrorHandle && vmErrorHandle.alive && ctx.typeof(vmErrorHandle) === 'object') {
                             const vmError = ctx.dump(vmErrorHandle);
                             console.log("error", "host", "Task execution failed inside VM", [vmError]);
                             executionError = `VM Execution Error: ${vmError?.message || simpleStringify(vmError)}`;
                             finalResultHandle = vmErrorHandle;
                        } else {
                            // console.log("warn", "host", "__result__ handle not found/invalid and no __execution_error__ found."); // REMOVED Warning
                            if (vmErrorHandle) {
                                if (vmErrorHandle.alive) {
                                    vmErrorHandle!.dispose();
                                }
                            }
                            // Fallback check
                            if (evalResult && 'value' in evalResult && evalResult.value && evalResult.value.alive && ctx.typeof(evalResult.value) !== 'undefined') {
                                // console.log("warn", "host", "Falling back to initial evalPromise settlement value (unexpected). Dumping..."); // REMOVED Warning
                                try {
                                    executionResult = ctx.dump(evalResult.value);
                                    //console.log("info", "host", "Successfully dumped initial evalPromise settlement value (used as fallback result).");
                                    finalResultHandle = evalResult.value;
                                } catch (dumpError: any) { /* ... error handling ... */ }
                            } else {
                               // console.log("warn", "host", "No valid result or VM error found."); // REMOVED Warning
                                executionResult = {};
                                if (resultHandleAfterLoop?.alive) resultHandleAfterLoop.dispose();
                                if (evalResult?.value?.alive) evalResult.value.dispose();
                                finalResultHandle = null;
                            }
                        }
                    } catch (getError: any) {
                        // Handle the error from getting __execution_error__
                        const msg = getError?.message || String(getError);
                        console.log("error", "host", "Error getting __execution_error__:", [msg]);
                        // Keep executionError as it might have been set earlier or default
                        // vmErrorHandle is already known to be problematic, so don't assign it
                    } finally {
                        if (vmErrorHandle) {
                            if (vmErrorHandle.alive) {
                                vmErrorHandle!.dispose();
                            }
                        }
                    }
                    // Ensure original result handle is disposed if needed and different from the final handle
                    if (resultHandleAfterLoop) {
                        if (resultHandleAfterLoop.alive && resultHandleAfterLoop! !== finalResultHandle) {
                            // console.log("debug", "host", "Disposing original resultHandleAfterLoop as it's not the final result handle."); // REMOVED Debug
                            resultHandleAfterLoop!.dispose();
                        }
                    }
                }
            } catch (getError: any) {
                const msg = getError?.message || getError;
                console.log("error", "host", "Failed to GET __result__ handle after loop:", [msg]);
                executionError = `Failed to get final result handle: ${msg}`;
                // Check before disposing
                if (resultHandleAfterLoop && resultHandleAfterLoop.alive) resultHandleAfterLoop.dispose();
                finalResultHandle = null;
            }
        }


	} catch (setupError) {
		 const errorMessage = setupError instanceof Error ? setupError.message : String(setupError);
		 console.log("error", "host", `Unhandled exception during setup: ${errorMessage}`, setupError instanceof Error ? [setupError.stack] : []);
		executionError = errorMessage;
		executionResult = null;
	} finally {
		 // Keep final disposal logs
		 if (finalResultHandle && finalResultHandle.alive && !handles.includes(finalResultHandle)){
			 try {
				 // console.log("debug", "host", "Disposing finalResultHandle in finally block."); // REMOVED Debug
 				 finalResultHandle.dispose();
 			 } catch(e) { console.warn(`[HOST] [WARN] Error disposing finalResultHandle: ${e instanceof Error ? e.message : String(e)}`); }
		 }
		 // console.log("debug", "host", "Disposing QuickJS tracked handles..."); // REMOVED Debug
 		 while (handles.length > 0) {
 			 const h = handles.pop();
 			  try { if (h?.alive) h.dispose(); } catch (e) { console.warn(`[HOST] [WARN] Dispose handle err: ${e instanceof Error ? e.message : String(e)}`); }
		 }
 		 //console.log("info", "host", "Disposing QuickJS context and runtime...");
 		 if (context?.alive) {
 			 try { context.dispose(); } catch (e) { console.warn(`[HOST] [WARN] Dispose ctx err: ${e instanceof Error ? e.message : String(e)}`); }
 		 } else {
 			 // console.log("warn", "host", "Context already disposed before finally block."); // REMOVED Warning
 		 }
 		 context = null;
 		 runtime = null;
 		 //console.log("info", "host", `QuickJS resources cleanup finished. Total time: ${Date.now() - startTimestamp}ms`);
	}

	// --- Return Response --- (Keep final logging)
	if (executionError) {
		console.log("error", "host", "Sending error response.", [executionError]);
		return new Response( JSON.stringify({ success: false, error: executionError }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } } );
	} else {
		//console.log("info", "host", "Sending success response.");
		const finalPayload = { success: true, result: executionResult };
		try {
			const payloadString = JSON.stringify(finalPayload);
			// Log preview to console only
			// console.log(`[HOST] [DEBUG] Final success payload (stringified, length=${payloadString.length}): ${payloadString.substring(0, 500)}${payloadString.length > 500 ? '...' : ''}`); // REMOVED VERBOSE
			// console.log("[HOST] [DEBUG] Value of executionResult being sent (type:", typeof executionResult, "):", executionResult); // POTENTIALLY LARGE
		} catch (stringifyError) {
			console.log("error", "host", "Failed to stringify final success payload!", [stringifyError]);
			return new Response( JSON.stringify({ success: false, error: "Failed to stringify final result" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } } );
		}
		return new Response( JSON.stringify(finalPayload), { headers: { ...corsHeaders, "Content-Type": "application/json" } } );
	}
});

