console.log("[Host Pre-Init] Loading quickjs/index.ts...");

import { corsHeaders } from "./cors.ts";
import {
	getQuickJS,
	newAsyncContext,
	QuickJSContext,
	QuickJSHandle,
	QuickJSRuntime,
	QuickJSAsyncContext,
} from "quickjs-emscripten";
import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.9/client";

console.log("[Host Pre-Init] Imports completed for quickjs/index.ts.");

console.log("[Host] Starting QuickJS function initialization...");

interface LogEntry {
	timestamp: string;
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

function createHandleFromJsonNoTrack(context: QuickJSAsyncContext, jsValue: any): QuickJSHandle {
	const jsonString = simpleStringify(jsValue);
	const evalResult = context.evalCode(`JSON.parse(${JSON.stringify(jsonString)})`);
	if (evalResult.error) {
		console.error("[Host] Error parsing JSON via evalCode:", context.dump(evalResult.error));
		evalResult.error.dispose();
		return context.undefined;
	}
	return evalResult.value;
}

async function callNestedHostProxy(proxy: any, chain: string[], args: any[]): Promise<any> {
	console.log(`[Host Helper] Reconstructing call: Chain=${chain.join('.')}, Args=${args.length}`);
	let currentProxy = proxy;

	for (let i = 0; i < chain.length; i++) {
		const prop = chain[i];
		if (!currentProxy || typeof currentProxy[prop] === 'undefined') {
			 throw new Error(`[Host Helper] Property '${prop}' not found in chain.`);
		}
		 console.log(`[Host Helper] Accessing proxy property: ${prop}`);
		currentProxy = currentProxy[prop];
	}

	console.log(`[Host Helper] Invoking final proxy function with ${args.length} args.`);
	const finalProxy = currentProxy(...args);

	console.log(`[Host Helper] Awaiting the finalProxy to trigger execution...`);
	const finalResult = await finalProxy;

	console.log(`[Host Helper] Final result received:`, finalResult);
	return finalResult;
}

Deno.serve(async (req: Request): Promise<Response> => {
	const logs: LogEntry[] = [];
	const addLog = (level: LogEntry["level"], source: "host" | "vm", message: string, data?: any[]) => {
		// Only push logs of level 'info' or higher, or 'error'
		// Keep 'debug' logs in console output only for local debugging if needed
		if (level === 'info' || level === 'warn' || level === 'error') {
		logs.push({ timestamp: new Date().toISOString(), level, source, message, data });
		}
		// Always log to console for visibility during development/debugging
		console[level === "error" ? "error" : "log"](`[${source.toUpperCase()}] [${level.toUpperCase()}] ${message}`, ...(data || []));
	};

	if (req.method === "OPTIONS") { console.log("[Host] Responding to OPTIONS request"); return new Response("ok", { headers: corsHeaders }); }

	let executionError: string | null = null;
	let executionResult: any = null;
	let finalResultHandle: QuickJSHandle | null = null;
	let runtime: QuickJSRuntime | null = null;
	let context: QuickJSAsyncContext | null = null;
	const handles: QuickJSHandle[] = [];
	const hostProxies: { [key: string]: any } = {}; // Store actual host proxies here

	// Define startTimestamp here so it's accessible in finally block
	const startTimestamp = Date.now();

	try {
		addLog("info", "host", "Processing request...");
		const { code, input = {}, modules = {}, serviceProxies = [], runtimeConfig = {} } = await req.json();
		const executionTimeoutSeconds = runtimeConfig.executionTimeoutSeconds ?? 60; // Default 60 seconds
		addLog("info", "host", "Request body parsed.", [
			`Code length: ${code?.length}`,
			`Input keys: ${Object.keys(input)}`,
			`Service Proxies: ${serviceProxies.map((p:any) => p.name).join(', ')}`,
			`Timeout: ${executionTimeoutSeconds}s`
		]);
		if (typeof code !== "string" || code.trim() === "") { throw new Error("Missing or empty 'code' property"); }
		if (!Array.isArray(serviceProxies)) { throw new Error("'serviceProxies' must be an array"); }
		if (!runtimeConfig || !runtimeConfig.supabaseUrl || !runtimeConfig.supabaseAnonKey) {
			addLog("error", "host", "Missing critical runtimeConfig properties (supabaseUrl, supabaseAnonKey)", [runtimeConfig]);
			throw new Error("Missing critical runtimeConfig properties");
		}

		// Reduce verbosity - initializing QuickJS is expected
		addLog("debug", "host", "Initializing QuickJS WASM module...");
		const quickjs = await getQuickJS();
		addLog("debug", "host", "QuickJS WASM module initialized.");

		addLog("info", "host", "Setting up QuickJS Async context...");
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

		rt.setMemoryLimit(256 * 1024 * 1024);
		rt.setMaxStackSize(1 * 1024 * 1024);
		addLog("debug", "host", "Runtime limits set.");

		// --- Create Host-Side Service Proxies ---
		addLog("info", "host", "Creating host-side service proxies...");
		try {
			for (const proxyConfig of serviceProxies) {
				if (!proxyConfig.name || !proxyConfig.baseUrl) {
					addLog("warn", "host", "Skipping invalid service proxy config (missing name or baseUrl)", [proxyConfig]);
					continue;
				}
				hostProxies[proxyConfig.name] = createServiceProxy(proxyConfig.name, {
					baseUrl: proxyConfig.baseUrl,
				headers: proxyConfig.headers || {},
				});
				addLog("debug", "host", `Created host proxy for '${proxyConfig.name}'`);
			}
		} catch (proxyError) {
			addLog("error", "host", "Error creating host service proxies", [proxyError]);
			throw new Error(`Failed to create service proxies: ${proxyError instanceof Error ? proxyError.message : String(proxyError)}`);
		}

		// --- Inject Globals ---

		// Console Patch
		addLog("debug", "host", "Injecting globals (console, config, input, fetch, timers, tools, require)...");
		const consoleHandle = ctx.newObject(); handles.push(consoleHandle);

		// Define ONE function factory for all console levels
		const logFn = (level: LogEntry["level"]) => ctx.newFunction(level, (...argsHandles: QuickJSHandle[]) => {
			// Only log to host console, don't add to returned logs unless it's an error
			try {
				const args = argsHandles.map(h => ctx.dump(h));
				if (level === 'error') {
					// Add VM errors to the main logs
					addLog(level, "vm", `console.error`, args);
				} else {
					// Log other levels only to the host console for debugging
					console.log(`[VM] [${level.toUpperCase()}]`, ...args);
				}
			} catch (e) {
				// Log errors during the dump itself to host console and potentially main logs
				const errorMsg = e instanceof Error ? e.message : String(e);
				console.error(`[HOST] [ERROR] Error during console.${level} dump`, errorMsg);
				addLog("error", "host", `Error during console.${level} dump`, [errorMsg]);
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
		const injectedRuntimeConfigHandle = createHandleFromJsonNoTrack(ctx, runtimeConfig); handles.push(injectedRuntimeConfigHandle);
		ctx.setProp(ctx.global, "__runtimeConfig__", injectedRuntimeConfigHandle);

		// Input
		const inputObjectHandle = createHandleFromJsonNoTrack(ctx, input); handles.push(inputObjectHandle);
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
					console.warn("[HOST] [WARN] [fetch Patch] Runtime disposed before executePendingJobs after fetch promise settlement.");
				}
			};
			deferred.settled.then(runPendingJobs);

			// Extract url and options eagerly, but perform fetch async
			let url: string;
			let options: RequestInit;
			try {
				url = ctx.getString(urlHandle);
				options = optionsHandle ? ctx.dump(optionsHandle) : {};
				// Log VM fetch calls directly
				console.log(`[VM] fetch called: ${url}`, options);
			} catch (dumpError) {
				if (!ctx?.alive || !deferred.handle.alive) return deferred.handle;
				const dumpErrorHandle = createHandleFromJsonNoTrack(ctx, dumpError);
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
					const r = ctx.newObject(); localHandles.push(r);
					const statusNum = ctx.newNumber(response.status); localHandles.push(statusNum); ctx.setProp(r, "status", statusNum);
					const statusTextStr = ctx.newString(response.statusText); localHandles.push(statusTextStr); ctx.setProp(r, "statusText", statusTextStr);
					ctx.setProp(r, "ok", response.ok ? ctx.true : ctx.false);
					const urlStr = ctx.newString(response.url); localHandles.push(urlStr); ctx.setProp(r, "url", urlStr);
					// Process Headers
					const h = ctx.newObject(); localHandles.push(h);
					for (const [k, v] of response.headers.entries()){
						const vh = ctx.newString(v); localHandles.push(vh);
						ctx.setProp(h, k, vh);
					}
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
						// addLog("debug", "host", "[fetch Patch] Resolving VM promise.");
						deferred.resolve(responseHandle);
						try {
							if (rt?.alive) {
								// Reduce verbosity
								// addLog("debug", "host", "[fetch Patch] Running pending jobs after resolve.");
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
					addLog("error", "host", "[fetch Patch] Error processing fetch response", [processError]);
					if (ctx?.alive && deferred.handle.alive) {
						const errorHandle = createHandleFromJsonNoTrack(ctx, processError);
						handles.push(errorHandle);
						deferred.reject(errorHandle);
						try {
							if (rt?.alive) {
								// Reduce verbosity
								// addLog("debug", "host", "[fetch Patch] Running pending jobs after reject (processing error).");
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
				addLog("error", "host", `[fetch Patch] Network error during fetch for ${url}`, [networkError]);
				if (ctx?.alive && deferred.handle.alive) {
					const errorHandle = createHandleFromJsonNoTrack(ctx, networkError);
					handles.push(errorHandle);
					deferred.reject(errorHandle);
					try {
						if (rt?.alive) {
							// Reduce verbosity
							// addLog("debug", "host", "[fetch Patch] Running pending jobs after reject (network error).");
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
		addLog("debug", "host", "Injecting setTimeout and clearTimeout...");
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
			handles.push(persistentCallbackHandle);
			const persistentArgsHandles = argsHandles.map(arg => {
				const dupArg = arg.dup();
				handles.push(dupArg);
				return dupArg;
			});

			const hostTimerId = setTimeout(() => {
				if (!ctx?.alive || !rt?.alive || !persistentCallbackHandle.alive) {
					// Reduce verbosity
					// console.warn(`[HOST] [WARN] [setTimeout Callback ${vmTimerId}] Runtime/Context/Callback disposed before execution.`);
					activeTimers.delete(vmTimerId);
					persistentArgsHandles.forEach(h => { if (h?.alive) h.dispose(); });
					return;
				}
				// Reduce verbosity
				// console.log(`[HOST] [DEBUG] [setTimeout Callback ${vmTimerId}] Executing...`);
				const result = ctx.callFunction(persistentCallbackHandle, ctx.undefined, ...persistentArgsHandles);

				persistentCallbackHandle.dispose();
				persistentArgsHandles.forEach(h => { if (h?.alive) h.dispose(); });

				activeTimers.delete(vmTimerId);

				if (result.error) {
					const errorDump = ctx.dump(result.error);
					addLog("error", "vm", `[setTimeout Callback ${vmTimerId}] Error during execution:`, [errorDump]);
					result.error.dispose();
				} else {
					// Reduce verbosity
					// console.log(`[HOST] [DEBUG] [setTimeout Callback ${vmTimerId}] Execution finished. Disposing result.`);
					result.value.dispose();
				}

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
				console.warn(`[VM] [WARN] [clearTimeout] Timer ID ${vmTimerId} not found or already cleared.`);
			}
		};

		// Inject into global scope
		const setTimeoutHandle = ctx.newFunction("setTimeout", setTimeoutVm);
		handles.push(setTimeoutHandle);
		ctx.setProp(ctx.global, "setTimeout", setTimeoutHandle);

		const clearTimeoutHandle = ctx.newFunction("clearTimeout", clearTimeoutVm);
		handles.push(clearTimeoutHandle);
		ctx.setProp(ctx.global, "clearTimeout", clearTimeoutHandle);

		addLog("debug", "host", "setTimeout and clearTimeout injected.");
		// --- End Timer Injection ---

		// Placeholder module object - Reduced verbosity
		addLog("debug", "host", "Injecting placeholder module object...");
		const moduleObjHandle = ctx.newObject(); handles.push(moduleObjHandle);
		ctx.setProp(moduleObjHandle, "exports", ctx.undefined);
		ctx.setProp(ctx.global, "module", moduleObjHandle);

		// --- Tools Injection --- (Polling based)
		addLog("debug", "host", "Injecting 'tools' object and request polling functions...");
		const toolsHandle = ctx.newObject(); handles.push(toolsHandle);
		ctx.setProp(ctx.global, "tools", toolsHandle);

		// --- Request tracking system --- No change needed here, logs are internal
		const pendingRequests = new Map();
		let requestCounter = 0;
		function generateRequestId() { return `req_${Date.now()}_${requestCounter++}`; }

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

			// Log registration directly
			console.log(`[HOST] [DEBUG] Registering host request: ${requestId} for ${serviceName}.${methodChain.join('.')} with ${args.length} args`);
			pendingRequests.set(requestId, { status: 'pending' });
			const proxy = hostProxies[serviceName];
			if (!proxy) {
				addLog("error", "host", `Host proxy not found for service: ${serviceName}`);
				pendingRequests.set(requestId, { status: 'rejected', error: `Host proxy not found for service: ${serviceName}` });
				return ctx.newString(requestId);
			}
			callNestedHostProxy(proxy, methodChain, args)
				.then(result => {
					console.log(`[HOST] [DEBUG] Request ${requestId} fulfilled for ${serviceName}.${methodChain.join('.')}`);
					pendingRequests.set(requestId, { status: 'fulfilled', value: result });
				})
				.catch(error => {
					const message = error instanceof Error ? error.message : String(error);
					addLog("error", "host", `Request ${requestId} rejected for ${serviceName}.${methodChain.join('.')}: ${message}`);
					pendingRequests.set(requestId, { status: 'rejected', error: message });
					});
			return ctx.newString(requestId);
		};

		// --- Inject __checkHostRequestStatus__ function --- No change needed here, logs are internal
		const checkHostRequestStatusFn = (requestIdHandle: QuickJSHandle) => {
			if (!ctx?.alive || !rt?.alive) { /* ... */ throw ctx.newError("Runtime disposed"); }
			let requestId: string;
			try { requestId = ctx.getString(requestIdHandle); } catch (dumpError: any) { throw new Error(`Failed to get request ID: ${dumpError?.message || dumpError}`); }
			const request = pendingRequests.get(requestId) || { status: 'pending' };
			const resultHandle = ctx.newObject(); handles.push(resultHandle);
			const statusHandle = ctx.newString(request.status); handles.push(statusHandle);
			ctx.setProp(resultHandle, 'status', statusHandle);
			if (request.status === 'fulfilled') {
				const valueHandle = createHandleFromJsonNoTrack(ctx, request.value);
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
		addLog("debug", "host", "Polling functions injected.");

		// --- Populate VM 'tools' object --- Reduced verbosity
		addLog("debug", "host", "Populating VM 'tools' object with service proxies...");
		const vmProxyGeneratorCode = `
(serviceName) => {
  function createPropertyProxy(path = []) {
    const baseFunction = function(...args) {
       const methodName = path.length > 0 ? path[path.length - 1] : '(root)';
       const methodPath = path;
       // Log VM proxy calls directly
       console.log('[VM] Proxy call:', serviceName + '.' + methodPath.join('.'), 'with args:', args.length);

       // --- Optimizations - Keep these logs --- 
       if (serviceName === 'openai' && args.length > 0 && args[0] && typeof args[0] === 'object') {
            if (methodPath.includes('chat') && methodPath.includes('completions') && methodPath.includes('create')) {
                if (!args[0].max_tokens || args[0].max_tokens > 150) {
                  args[0].max_tokens = 150;
                  console.log('[VM Proxy] Limiting max_tokens to 150 for OpenAI chat completion');
                }
                if (!args[0].model || args[0].model.includes('gpt-4')) {
                  args[0].model = 'gpt-3.5-turbo';
                  console.log('[VM Proxy] Using gpt-3.5-turbo model for faster response');
                }
                if (args[0].temperature === undefined || args[0].temperature > 0.3) {
                  args[0].temperature = 0.3;
                  console.log('[VM Proxy] Setting temperature to 0.3 for faster response');
                }
                if (args[0].messages && Array.isArray(args[0].messages)) {
                  let hasSystemMessage = false;
                  for (const msg of args[0].messages) {
                    if (msg.role === 'system') {
                      hasSystemMessage = true;
                      msg.content = msg.content + ' Keep your response very brief and concise.';
                      break;
                    }
                  }
                  if (!hasSystemMessage) {
                    args[0].messages.unshift({ role: 'system', content: 'Keep your response very brief and concise.' });
                  }
                }
            }
       }
       // ------------------------------------

       const requestId = __registerHostRequest__(serviceName, methodPath, args);
       // Log request ID directly
       console.log('[VM] Registered request:', requestId);

          return new Promise((resolve, reject) => {
            let attempts = 0;
            const maxAttempts = 15000; // ~30 seconds
            function checkResult() {
              attempts++;
              const result = __checkHostRequestStatus__(requestId);
              if (result.status === 'pending') {
                const interval = attempts < 50 ? 0 : 2;
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
		  addLog("error", "host", "Failed to evaluate VM proxy generator code");
		  vmProxyGeneratorResult.error.dispose();
		  throw new Error("Failed to setup VM proxies");
		}
		const vmProxyGeneratorHandle = vmProxyGeneratorResult.value;
		handles.push(vmProxyGeneratorHandle);

		for (const service of serviceProxies) {
			const serviceName = service.name;
			if (!serviceName) continue;
			addLog("debug", "host", `Creating VM proxy for service: ${serviceName}`);
			const serviceNameHandle = ctx.newString(serviceName);
			handles.push(serviceNameHandle);
			const vmProxyResult = ctx.callFunction(vmProxyGeneratorHandle, ctx.undefined, serviceNameHandle);
			if (vmProxyResult.error) {
				addLog("error", "host", `Failed to create VM proxy for ${serviceName}`);
				vmProxyResult.error.dispose();
				serviceNameHandle.dispose();
				continue;
			}
			const vmProxyHandle = vmProxyResult.value;
			handles.push(vmProxyHandle);
			ctx.setProp(toolsHandle, serviceName, vmProxyHandle);
			addLog("debug", "host", `VM proxy created for ${serviceName}.`);
		}
		vmProxyGeneratorHandle.dispose();
		addLog("debug", "host", "Finished populating VM 'tools' object.");


		// Module Loader / Require Setup - Reduced verbosity
		addLog("debug", "host", "Setting up module loader...");
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
					try {
						// Use Function constructor - seems necessary for module scope
						const moduleWrapper = new Function('module', 'exports', 'require', moduleCode);
						moduleWrapper(module, module.exports, require);
					} catch (e) {
						const errMsg = e instanceof Error ? e.message : String(e);
						const errStack = e instanceof Error ? e.stack : '';
						// Log error directly
						console.error('[VM require] Error executing module:', resolvedId, errMsg, errStack);
						throw new Error('Module execution error in ' + resolvedId + ': ' + errMsg);
					}

					moduleCache[resolvedId] = module.exports;
					return module.exports;
				}
				// This inner function is what we want to return and assign to global require
				return require;
			}
		`;

		const modulesHandle = createHandleFromJson(ctx, modules, handles);
		ctx.setProp(ctx.global, "__injectedModules__", modulesHandle);

		addLog("debug", "host", "Evaluating require generator...");
		const requireGeneratorEvalResult = ctx.evalCode(`(${requireGeneratorFuncStr})`);
		if (requireGeneratorEvalResult.error) {
			handles.push(requireGeneratorEvalResult.error);
			const errDump = ctx.dump(requireGeneratorEvalResult.error);
			addLog("error", "host", "Failed to evaluate require generator function code", [errDump]);
			throw new Error("Failed to evaluate require generator");
		}
		const requireGeneratorHandle = requireGeneratorEvalResult.value;
		handles.push(requireGeneratorHandle);

		addLog("debug", "host", "Calling require generator...");
		const requireCallResult = ctx.callFunction(requireGeneratorHandle, ctx.global);
		if (requireCallResult.error) {
			handles.push(requireCallResult.error as QuickJSHandle);
			const errDump = ctx.dump(requireCallResult.error as QuickJSHandle);
			addLog("error", "host", "Failed to call require generator function", [errDump]);
			throw new Error("Failed to call require generator function");
		}
		const requireHandle = requireCallResult.value as QuickJSHandle;
		handles.push(requireHandle);

		ctx.setProp(ctx.global, "require", requireHandle);
		addLog("debug", "host", "Global injections complete.");

		// --- Execute Task Code ---
		addLog("info", "host", "Executing user code...");
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
      // Log VM execution start directly
      console.log('[VM] Task function found. Executing...');
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
        console.log('[VM] Task returned a Promise. Awaiting...');
        const finalResult = await resultPromiseOrValue;
        console.log('[VM] Task Promise resolved. Assigning to __result__.');
        globalThis.__result__ = finalResult;
    } else {
        console.log('[VM] Task returned non-Promise. Assigning to __result__.');
        globalThis.__result__ = resultPromiseOrValue;
    }
    } else {
      console.log('[VM] module.exports not a function. Assigning to __result__.');
      globalThis.__result__ = module.exports;
    }
    console.log('[VM] Wrapper execution finished.');
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
		addLog("debug", "host", "Evaluating user code ASYNCHRONOUSLY...");

		const evalPromise = ctx.evalCodeAsync(wrappedCode, "task.js");

		// --- Wait for initial evaluation and process all subsequent jobs/timers ---
		addLog("debug", "host", "Waiting for initial evaluation promise...");
		let evalResult = await evalPromise;

		addLog("info", "host", "Initial promise settled. Processing remaining jobs/timers (timeout: ${executionTimeoutSeconds}s)...");
		const safetyBreakMax = executionTimeoutSeconds * 100; // Approx counter limit based on 10ms yields
		let safetyBreak = safetyBreakMax;
		let jobLoopErrorHandle: QuickJSHandle | null = null;
		let lastTimerLogTime = Date.now();

		try {
			while (rt?.alive && safetyBreak > 0) {
				safetyBreak--;
				let jobsProcessed = 0;
				do {
					 const jobsResult = rt.executePendingJobs();
					 if (jobsResult.error) {
						 const errorDump = ctx.dump(jobsResult.error);
						 addLog("error", "host", "Error during executePendingJobs:", [errorDump]);
						 jobLoopErrorHandle = jobsResult.error;
						 executionError = `QuickJS job execution error: ${simpleStringify(errorDump)}`;
					break;
				}
					 jobsProcessed = jobsResult.value;
					 // Remove per-job log
					 // if (jobsProcessed > 0) { addLog("debug", "host", `Inner loop: Processed ${jobsProcessed} pending jobs.`); }
				} while (jobsProcessed > 0 && rt?.alive);

				if (executionError) { break; }

				if (activeTimers.size > 0) {
					// Log timer status less frequently
					if (Date.now() - lastTimerLogTime > 5000) { // Log every 5 seconds if timers are active
						addLog("debug", "host", `QuickJS idle but ${activeTimers.size} timers active. Yielding to host...`);
						lastTimerLogTime = Date.now();
					}
					await new Promise(resolve => setTimeout(resolve, 10));
					continue;
				} else {
					 addLog("debug", "host", "QuickJS idle and no active timers. Exiting job/timer loop.");
					 break;
				}
			} // End while loop

			if (safetyBreak <= 0) {
				addLog("warn", "host", "Safety break triggered during job/timer processing loop.");
				executionError = `Task timed out after ${executionTimeoutSeconds}s (job/timer processing loop safety break).`;
			}

		} catch (loopError) {
			addLog("error", "host", "Exception during job/timer processing loop:", [loopError]);
			executionError = `Host exception during job/timer processing: ${loopError instanceof Error ? loopError.message : String(loopError)}`;
		}
		addLog("info", "host", "Exited job/timer processing loop.");


		// --- Process Final Result --- (Keep this logic, logging is important here)
		addLog("debug", "host", "Processing final result...");
		if (executionError) {
			 addLog("error", "host", `Task execution failed due to prior error: ${executionError}`);
			 if (jobLoopErrorHandle) {
				 finalResultHandle = jobLoopErrorHandle;
             } else { /* finalResultHandle remains null */ }
		} else if (evalResult && 'error' in evalResult) {
		    addLog("error", "host", "Task execution failed (initial evalPromise rejected).");
		    // Handle potential undefined error handle
		    const errorHandle = evalResult.error;
		    if (errorHandle && errorHandle.alive) {
		        const errorDump = ctx.dump(errorHandle);
		        addLog("error", "host", "Task execution failed (eval error)", [errorDump]);
			    executionError = simpleStringify(errorDump);
			    finalResultHandle = errorHandle; // Assign only if valid
		    } else {
		        addLog("error", "host", "Task execution failed (eval error), but error handle was invalid/undefined.");
		        executionError = "Evaluation failed with invalid error handle";
		        finalResultHandle = null; // Ensure it's null
		    }
		} else {
            addLog("info", "host", "Attempting to retrieve globalThis.__result__ after job loop...");
            let resultHandleAfterLoop: QuickJSHandle | undefined;
            try {
                resultHandleAfterLoop = ctx.getProp(ctx.global, "__result__");
                if (resultHandleAfterLoop && resultHandleAfterLoop.alive && ctx.typeof(resultHandleAfterLoop) !== 'undefined') {
                    addLog("info", "host", "__result__ handle obtained. Dumping...");
                    try {
                        executionResult = ctx.dump(resultHandleAfterLoop);
						// Log success concisely
                        addLog("info", "host", "Successfully dumped __result__.");
						// Keep preview in debug console only
						console.log("[HOST] [DEBUG] Result Preview:", JSON.stringify(executionResult).slice(0, 200) + '...');
                        finalResultHandle = resultHandleAfterLoop;
                    } catch (dumpError: any) {
                        const msg = dumpError?.message || dumpError;
                        addLog("error", "host", "Failed to DUMP __result__ handle after loop:", [msg]);
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
                             addLog("error", "host", "Task execution failed inside VM", [vmError]);
                             executionError = `VM Execution Error: ${vmError?.message || simpleStringify(vmError)}`;
                             finalResultHandle = vmErrorHandle;
                        } else {
                            addLog("warn", "host", "__result__ handle not found/invalid and no __execution_error__ found.");
                            if (vmErrorHandle) {
                                if (vmErrorHandle.alive) {
                                    vmErrorHandle!.dispose();
                                }
                            }
                            // Fallback check
                            if (evalResult && 'value' in evalResult && evalResult.value && evalResult.value.alive && ctx.typeof(evalResult.value) !== 'undefined') {
                                addLog("warn", "host", "Falling back to initial evalPromise settlement value (unexpected). Dumping...");
                                try {
                                    executionResult = ctx.dump(evalResult.value);
                                    addLog("info", "host", "Successfully dumped initial evalPromise value.");
                                    finalResultHandle = evalResult.value;
                                } catch (dumpError: any) { /* ... error handling ... */ }
                            } else {
                               addLog("warn", "host", "No valid result or VM error found.");
                               executionResult = {};
                               if (resultHandleAfterLoop?.alive) resultHandleAfterLoop.dispose();
                               if (evalResult?.value?.alive) evalResult.value.dispose();
                               finalResultHandle = null;
                            }
                        }
                    } catch (getError: any) {
                        // Handle the error from getting __execution_error__
                        const msg = getError?.message || String(getError);
                        addLog("error", "host", "Error getting __execution_error__:", [msg]);
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
                            addLog("debug", "host", "Disposing original resultHandleAfterLoop as it's not the final result handle.");
                            resultHandleAfterLoop!.dispose();
                        }
                    }
                }
            } catch (getError: any) {
                const msg = getError?.message || getError;
                addLog("error", "host", "Failed to GET __result__ handle after loop:", [msg]);
                executionError = `Failed to get final result handle: ${msg}`;
                // Check before disposing
                if (resultHandleAfterLoop && resultHandleAfterLoop.alive) resultHandleAfterLoop.dispose();
                finalResultHandle = null;
            }
        }


	} catch (setupError) {
		 const errorMessage = setupError instanceof Error ? setupError.message : String(setupError);
		 addLog("error", "host", `Unhandled exception during setup: ${errorMessage}`, setupError instanceof Error ? [setupError.stack] : []);
		executionError = errorMessage;
		executionResult = null;
	} finally {
		 // Keep final disposal logs
		 if (finalResultHandle && finalResultHandle.alive && !handles.includes(finalResultHandle)){
			 try {
				 addLog("debug", "host", "Disposing finalResultHandle in finally block.");
				 finalResultHandle.dispose();
			} catch(e) { console.warn(`[HOST] [WARN] Error disposing finalResultHandle: ${e}`); }
		 }
		 addLog("debug", "host", "Disposing QuickJS tracked handles...");
		while (handles.length > 0) {
			const h = handles.pop();
			 try { if (h?.alive) h.dispose(); } catch (e) { console.warn(`[HOST] [WARN] Dispose handle err: ${e instanceof Error ? e.message : String(e)}`); }
		 }
		 addLog("info", "host", "Disposing QuickJS context and runtime...");
		 if (context?.alive) {
			 try { context.dispose(); addLog("debug", "host", "QuickJS context disposed."); } catch (e) { console.warn(`[HOST] [WARN] Dispose ctx err: ${e instanceof Error ? e.message : String(e)}`); }
		 } else {
			  addLog("warn", "host", "Context already disposed before finally block.");
		}
		context = null;
		 runtime = null;
		 addLog("info", "host", `QuickJS resources cleanup finished. Total time: ${Date.now() - startTimestamp}ms`);
	}

	// --- Return Response --- (Keep final logging)
	if (executionError) {
		addLog("error", "host", "Sending error response.", [executionError]);
		return new Response( JSON.stringify({ success: false, error: executionError, logs }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } } );
	} else {
		addLog("info", "host", "Sending success response.");
		const finalPayload = { success: true, result: executionResult, logs };
		try {
			const payloadString = JSON.stringify(finalPayload);
			// Log preview to console only
			console.log(`[HOST] [DEBUG] Final success payload (stringified, length=${payloadString.length}): ${payloadString.substring(0, 500)}${payloadString.length > 500 ? '...' : ''}`);
			console.log("[HOST] [DEBUG] Value of executionResult being sent (type:", typeof executionResult, "):", executionResult);
		} catch (stringifyError) {
			addLog("error", "host", "Failed to stringify final success payload!", [stringifyError]);
			return new Response( JSON.stringify({ success: false, error: "Failed to stringify final result", logs }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } } );
		}
		return new Response( JSON.stringify(finalPayload), { headers: { ...corsHeaders, "Content-Type": "application/json" } } );
	}
});

console.log("[Host] QuickJS function initialized and server started.");