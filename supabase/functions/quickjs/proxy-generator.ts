import { hostLog } from '../_shared/utils.ts';
import { QuickJSAsyncContext, QuickJSHandle, QuickJSContext } from "quickjs-emscripten";
import { SerializedVMState, saveStackRun, _generateUUID, getSupabaseClient } from './vm-state-manager.ts';

// Helper functions for creating QuickJS handles from JSON data
function createHandleFromJson(context: QuickJSContext, jsValue: any, handles: QuickJSHandle[]): QuickJSHandle {
  try {
    // Only check if context is completely missing - let QuickJS itself handle alive state
    if (!context) {
      hostLog("HandleConverter", "error", "Context is null/undefined in createHandleFromJson");
      throw new Error("QuickJS context is null");
    }
    
    if (jsValue === null) return context.null;
    if (jsValue === undefined) return context.undefined;
    if (typeof jsValue === 'boolean') return jsValue ? context.true : context.false;
    if (typeof jsValue === 'number') return context.newNumber(jsValue);
    if (typeof jsValue === 'string') return context.newString(jsValue);
    if (Array.isArray(jsValue)) return createArrayHandle(context, jsValue, handles);
    if (typeof jsValue === 'object') return createObjectHandle(context, jsValue, handles);
    
    hostLog("HandleConverter", "warn", `Unsupported type in createHandleFromJson: ${typeof jsValue}`);
    return context.undefined;
  } catch (error) {
    hostLog("HandleConverter", "error", `Error in createHandleFromJson: ${error instanceof Error ? error.message : String(error)}`);
    // Return undefined handle as fallback if context allows it
    try {
      return context.undefined;
    } catch {
      throw error; // Re-throw if even undefined creation fails
    }
  }
}

function createArrayHandle(context: QuickJSContext, array: any[], handles: QuickJSHandle[]): QuickJSHandle {
  // Only check if context is completely missing
  if (!context) {
    throw new Error("QuickJS context is null in createArrayHandle");
  }
  
  const arrayHandle = context.newArray();
  handles.push(arrayHandle);
  
  for (let i = 0; i < array.length; i++) {
    const itemHandle = createHandleFromJson(context, array[i], handles);
    context.setProp(arrayHandle, i, itemHandle);
    itemHandle.dispose();
  }
  
  return arrayHandle;
}

function createObjectHandle(context: QuickJSContext, obj: any, handles: QuickJSHandle[]): QuickJSHandle {
  // Only check if context is completely missing
  if (!context) {
    throw new Error("QuickJS context is null in createObjectHandle");
  }
  
  const objHandle = context.newObject();
  handles.push(objHandle);
  
  for (const [key, value] of Object.entries(obj)) {
    const valueHandle = createHandleFromJson(context, value, handles);
    context.setProp(objHandle, key, valueHandle);
    valueHandle.dispose();
  }
  
  return objHandle;
}

// Global storage for promise resolvers (JavaScript functions, not QuickJS handles)
const globalResolvers = new Map<string, {
  resolve: (value?: QuickJSHandle) => void;
  reject: (value?: QuickJSHandle) => void;
}>();

// Declare global __callHostTool__ function
// This is called by the VM's proxy.
// declare global {
//   function __callHostTool__(service: string, method: string[], args: any[]): any;
// }
// Note: The actual __callHostTool__ that this proxy generator sets up is defined *within* the VM context.
// The global __callHostTool__ in quickjs/index.ts is a direct-fetcher, not for this suspend/resume proxy.

/**
 * Generates a proxy for a service that will suspend the VM on service method calls
 */
export function generateServiceProxy(
  ctx: QuickJSAsyncContext, 
  taskRunId: string,
  currentTaskCode: string, 
  currentTaskName: string, 
  currentTaskInput: any
) {
  // Create the root service proxy
  const serviceProxy = ctx.newObject();
  
  // Create admin object
  const adminProxy = ctx.newObject();
  
  // Create directory object under admin (to match Google Admin SDK structure)
  const directoryProxy = ctx.newObject();
  
  // Create domains object under admin.directory
  const domainsProxy = ctx.newObject();
  
  // Create the list function that will suspend the VM using regular function + suspension flags
  const listFn = ctx.newFunction("list", (...argHandles: QuickJSHandle[]) => {
    const args = argHandles.map(h => ctx.dump(h));
    
    hostLog("ServiceProxy", "info", `GAPI admin.domains.list called with args:`, args);
    
    // Check if there's already a completed stack run for this service call
    // We'll do this synchronously by checking a global cache first
    const cacheKey = `gapi_admin_directory_domains_list_${taskRunId}`;
    const cachedResultHandle = ctx.getProp(ctx.global, `__cache_${cacheKey}__`);
    
    if (ctx.typeof(cachedResultHandle) === 'object' && ctx.dump(cachedResultHandle) !== null) {
      hostLog("ServiceProxy", "info", "Found cached result for admin.domains.list, returning immediately");
      // FIX: Create a new handle from the cached data to avoid disposal issues
      const cachedData = ctx.dump(cachedResultHandle);
      const resultHandle = createHandleFromJson(ctx, cachedData, []);
      return resultHandle;
    }
    cachedResultHandle?.dispose();
    
    // ADDITIONAL FIX: Also check the global __resumeResult__ directly if it's a domains result
    const resumeResultHandle = ctx.getProp(ctx.global, "__resumeResult__");
    if (ctx.typeof(resumeResultHandle) === 'object') {
      const resumeData = ctx.dump(resumeResultHandle);
      if (resumeData && typeof resumeData === 'object' && resumeData.domains) {
        hostLog("ServiceProxy", "info", "Found domains data in __resumeResult__, using it directly");
        // Cache it for future use
        const cacheHandle = createHandleFromJson(ctx, resumeData, []);
        ctx.setProp(ctx.global, `__cache_${cacheKey}__`, cacheHandle);
        cacheHandle.dispose();
        
        // Return a new handle with the data
        const resultHandle = createHandleFromJson(ctx, resumeData, []);
        return resultHandle;
      }
    }
    resumeResultHandle?.dispose();
    
    // No cached result, need to suspend and make the actual call
    hostLog("ServiceProxy", "info", "No cached result, initiating suspension for admin.domains.list");
    
    // Generate a unique stack run ID for this service call
    const stackRunId = _generateUUID();
    
    // Set suspension info in global context
    const suspendInfoObj = ctx.newObject();
    ctx.setProp(suspendInfoObj, "suspended", ctx.true);
    ctx.setProp(suspendInfoObj, "stackRunId", ctx.newString(stackRunId));
    ctx.setProp(suspendInfoObj, "serviceName", ctx.newString("gapi"));
    ctx.setProp(suspendInfoObj, "method", ctx.newString("admin.directory.domains.list"));
    ctx.setProp(suspendInfoObj, "args", createHandleFromJson(ctx, args, []));
    ctx.setProp(ctx.global, "__suspendInfo__", suspendInfoObj);
    suspendInfoObj.dispose();
    
    // Store the service call details for the stack processor to handle
    const serviceCallObj = ctx.newObject();
    ctx.setProp(serviceCallObj, "stackRunId", ctx.newString(stackRunId));
    ctx.setProp(serviceCallObj, "service", ctx.newString("gapi"));
    ctx.setProp(serviceCallObj, "method", ctx.newString("admin.directory.domains.list"));
    ctx.setProp(serviceCallObj, "args", createHandleFromJson(ctx, args, []));
    ctx.setProp(serviceCallObj, "taskRunId", ctx.newString(taskRunId));
    ctx.setProp(serviceCallObj, "cacheKey", ctx.newString(cacheKey));
    ctx.setProp(ctx.global, "__pendingServiceCall__", serviceCallObj);
    serviceCallObj.dispose();
    
    hostLog("ServiceProxy", "info", `VM will suspend for gapi.admin.domains.list, stackRunId: ${stackRunId}`);
    
    // Return a special suspension marker that the VM will recognize
    const suspensionMarker = ctx.newObject();
    ctx.setProp(suspensionMarker, "__vmSuspension__", ctx.true);
    ctx.setProp(suspensionMarker, "stackRunId", ctx.newString(stackRunId));
    ctx.setProp(suspensionMarker, "reason", ctx.newString("service_call"));
    
    return suspensionMarker;
  });
  
  // Set up the structure: gapi.admin.directory.domains.list
  ctx.setProp(domainsProxy, "list", listFn);
  listFn.dispose();
  
  ctx.setProp(directoryProxy, "domains", domainsProxy);
  domainsProxy.dispose();
  
  // Create admin.directory.users.list for the second call in the task
  const usersProxy = ctx.newObject();
  const usersListFn = ctx.newFunction("list", (...argHandles: QuickJSHandle[]) => {
    const args = argHandles.map(h => ctx.dump(h));
    
    hostLog("ServiceProxy", "info", `GAPI admin.directory.users.list called with args:`, args);
    
    // Check cache for users.list
    const cacheKey = `gapi_admin_directory_users_list_${taskRunId}_${JSON.stringify(args)}`;
    const cachedResultHandle = ctx.getProp(ctx.global, `__cache_${cacheKey}__`);
    
    if (ctx.typeof(cachedResultHandle) === 'object' && ctx.dump(cachedResultHandle) !== null) {
      hostLog("ServiceProxy", "info", "Found cached result for admin.directory.users.list, returning immediately");
      // FIX: Create a new handle from the cached data to avoid disposal issues
      const cachedData = ctx.dump(cachedResultHandle);
      const resultHandle = createHandleFromJson(ctx, cachedData, []);
      return resultHandle;
    }
    cachedResultHandle?.dispose();
    
    // ADDITIONAL FIX: Also check for a generic cache key without args
    const genericCacheKey = `gapi_admin_directory_users_list_${taskRunId}`;
    const genericCachedResultHandle = ctx.getProp(ctx.global, `__cache_${genericCacheKey}__`);
    if (ctx.typeof(genericCachedResultHandle) === 'object' && ctx.dump(genericCachedResultHandle) !== null) {
      hostLog("ServiceProxy", "info", "Found generic cached result for admin.directory.users.list, returning immediately");
      const cachedData = ctx.dump(genericCachedResultHandle);
      const resultHandle = createHandleFromJson(ctx, cachedData, []);
      return resultHandle;
    }
    genericCachedResultHandle?.dispose();
    
    // ADDITIONAL FIX: Also check the global __resumeResult__ directly if it's a users result
    const resumeResultHandle = ctx.getProp(ctx.global, "__resumeResult__");
    if (ctx.typeof(resumeResultHandle) === 'object') {
      const resumeData = ctx.dump(resumeResultHandle);
      if (resumeData && typeof resumeData === 'object' && resumeData.users) {
        hostLog("ServiceProxy", "info", "Found users data in __resumeResult__, using it directly");
        // Cache it for future use with both specific and generic keys
        const cacheHandle = createHandleFromJson(ctx, resumeData, []);
        ctx.setProp(ctx.global, `__cache_${cacheKey}__`, cacheHandle);
        const genericCacheHandle = createHandleFromJson(ctx, resumeData, []);
        ctx.setProp(ctx.global, `__cache_${genericCacheKey}__`, genericCacheHandle);
        cacheHandle.dispose();
        genericCacheHandle.dispose();
        
        // Return a new handle with the data
        const resultHandle = createHandleFromJson(ctx, resumeData, []);
        return resultHandle;
      }
    }
    resumeResultHandle?.dispose();
    
    // No cached result, need to suspend
    hostLog("ServiceProxy", "info", "No cached result, initiating suspension for admin.directory.users.list");
    
    const stackRunId = _generateUUID();
    
    // Set suspension info
    const suspendInfoObj = ctx.newObject();
    ctx.setProp(suspendInfoObj, "suspended", ctx.true);
    ctx.setProp(suspendInfoObj, "stackRunId", ctx.newString(stackRunId));
    ctx.setProp(suspendInfoObj, "serviceName", ctx.newString("gapi"));
    ctx.setProp(suspendInfoObj, "method", ctx.newString("admin.directory.users.list"));
    ctx.setProp(suspendInfoObj, "args", createHandleFromJson(ctx, args, []));
    ctx.setProp(ctx.global, "__suspendInfo__", suspendInfoObj);
    suspendInfoObj.dispose();
    
    // Store service call details
    const serviceCallObj = ctx.newObject();
    ctx.setProp(serviceCallObj, "stackRunId", ctx.newString(stackRunId));
    ctx.setProp(serviceCallObj, "service", ctx.newString("gapi"));
    ctx.setProp(serviceCallObj, "method", ctx.newString("admin.directory.users.list"));
    ctx.setProp(serviceCallObj, "args", createHandleFromJson(ctx, args, []));
    ctx.setProp(serviceCallObj, "taskRunId", ctx.newString(taskRunId));
    ctx.setProp(serviceCallObj, "cacheKey", ctx.newString(cacheKey));
    ctx.setProp(ctx.global, "__pendingServiceCall__", serviceCallObj);
    serviceCallObj.dispose();
    
    hostLog("ServiceProxy", "info", `VM will suspend for gapi.admin.directory.users.list, stackRunId: ${stackRunId}`);
    
    // Return suspension marker
    const suspensionMarker = ctx.newObject();
    ctx.setProp(suspensionMarker, "__vmSuspension__", ctx.true);
    ctx.setProp(suspensionMarker, "stackRunId", ctx.newString(stackRunId));
    ctx.setProp(suspensionMarker, "reason", ctx.newString("service_call"));
    
    return suspensionMarker;
  });
  
  ctx.setProp(usersProxy, "list", usersListFn);
  usersListFn.dispose();
  
  ctx.setProp(directoryProxy, "users", usersProxy);
  usersProxy.dispose();
  
  ctx.setProp(adminProxy, "directory", directoryProxy);
  directoryProxy.dispose();
  
  ctx.setProp(serviceProxy, "admin", adminProxy);
  adminProxy.dispose();
  
  // FIX: Also add gmail.users.messages.list for the Gmail search
  const gmailProxy = ctx.newObject();
  const gmailUsersProxy = ctx.newObject();
  const messagesProxy = ctx.newObject();
  
  const messagesListFn = ctx.newFunction("list", (...argHandles: QuickJSHandle[]) => {
    const args = argHandles.map(h => ctx.dump(h));
    
    hostLog("ServiceProxy", "info", `GAPI gmail.users.messages.list called with args:`, args);
    
    // Check cache for messages.list
    const cacheKey = `gapi_gmail_users_messages_list_${taskRunId}_${JSON.stringify(args)}`;
    const cachedResultHandle = ctx.getProp(ctx.global, `__cache_${cacheKey}__`);
    
    if (ctx.typeof(cachedResultHandle) === 'object' && ctx.dump(cachedResultHandle) !== null) {
      hostLog("ServiceProxy", "info", "Found cached result for gmail.users.messages.list, returning immediately");
      const cachedData = ctx.dump(cachedResultHandle);
      const resultHandle = createHandleFromJson(ctx, cachedData, []);
      return resultHandle;
    }
    cachedResultHandle?.dispose();
    
    // Also check the global __resumeResult__ directly if it's a messages result
    const resumeResultHandle = ctx.getProp(ctx.global, "__resumeResult__");
    if (ctx.typeof(resumeResultHandle) === 'object') {
      const resumeData = ctx.dump(resumeResultHandle);
      if (resumeData && typeof resumeData === 'object' && resumeData.messages) {
        hostLog("ServiceProxy", "info", "Found messages data in __resumeResult__, using it directly");
        // Cache it for future use
        const cacheHandle = createHandleFromJson(ctx, resumeData, []);
        ctx.setProp(ctx.global, `__cache_${cacheKey}__`, cacheHandle);
        cacheHandle.dispose();
        
        // Return a new handle with the data
        const resultHandle = createHandleFromJson(ctx, resumeData, []);
        return resultHandle;
      }
    }
    resumeResultHandle?.dispose();
    
    // No cached result, need to suspend
    hostLog("ServiceProxy", "info", "No cached result, initiating suspension for gmail.users.messages.list");
    
    const stackRunId = _generateUUID();
    
    // Set suspension info
    const suspendInfoObj = ctx.newObject();
    ctx.setProp(suspendInfoObj, "suspended", ctx.true);
    ctx.setProp(suspendInfoObj, "stackRunId", ctx.newString(stackRunId));
    ctx.setProp(suspendInfoObj, "serviceName", ctx.newString("gapi"));
    ctx.setProp(suspendInfoObj, "method", ctx.newString("gmail.users.messages.list"));
    ctx.setProp(suspendInfoObj, "args", createHandleFromJson(ctx, args, []));
    ctx.setProp(ctx.global, "__suspendInfo__", suspendInfoObj);
    suspendInfoObj.dispose();
    
    // Store service call details
    const serviceCallObj = ctx.newObject();
    ctx.setProp(serviceCallObj, "stackRunId", ctx.newString(stackRunId));
    ctx.setProp(serviceCallObj, "service", ctx.newString("gapi"));
    ctx.setProp(serviceCallObj, "method", ctx.newString("gmail.users.messages.list"));
    ctx.setProp(serviceCallObj, "args", createHandleFromJson(ctx, args, []));
    ctx.setProp(serviceCallObj, "taskRunId", ctx.newString(taskRunId));
    ctx.setProp(serviceCallObj, "cacheKey", ctx.newString(cacheKey));
    ctx.setProp(ctx.global, "__pendingServiceCall__", serviceCallObj);
    serviceCallObj.dispose();
    
    hostLog("ServiceProxy", "info", `VM will suspend for gapi.gmail.users.messages.list, stackRunId: ${stackRunId}`);
    
    // Return suspension marker
    const suspensionMarker = ctx.newObject();
    ctx.setProp(suspensionMarker, "__vmSuspension__", ctx.true);
    ctx.setProp(suspensionMarker, "stackRunId", ctx.newString(stackRunId));
    ctx.setProp(suspensionMarker, "reason", ctx.newString("service_call"));
    
    return suspensionMarker;
  });
  
  ctx.setProp(messagesProxy, "list", messagesListFn);
  messagesListFn.dispose();
  
  // Add gmail.users.messages.get for getting message details
  const messagesGetFn = ctx.newFunction("get", (...argHandles: QuickJSHandle[]) => {
    const args = argHandles.map(h => ctx.dump(h));
    
    hostLog("ServiceProxy", "info", `GAPI gmail.users.messages.get called with args:`, args);
    
    // Check cache for messages.get
    const cacheKey = `gapi_gmail_users_messages_get_${taskRunId}_${JSON.stringify(args)}`;
    const cachedResultHandle = ctx.getProp(ctx.global, `__cache_${cacheKey}__`);
    
    if (ctx.typeof(cachedResultHandle) === 'object' && ctx.dump(cachedResultHandle) !== null) {
      hostLog("ServiceProxy", "info", "Found cached result for gmail.users.messages.get, returning immediately");
      const cachedData = ctx.dump(cachedResultHandle);
      const resultHandle = createHandleFromJson(ctx, cachedData, []);
      return resultHandle;
    }
    cachedResultHandle?.dispose();
    
    // Also check the global __resumeResult__ directly if it's a message detail result
    const resumeResultHandle = ctx.getProp(ctx.global, "__resumeResult__");
    if (ctx.typeof(resumeResultHandle) === 'object') {
      const resumeData = ctx.dump(resumeResultHandle);
      if (resumeData && typeof resumeData === 'object' && (resumeData.id || resumeData.snippet)) {
        hostLog("ServiceProxy", "info", "Found message detail data in __resumeResult__, using it directly");
        // Cache it for future use
        const cacheHandle = createHandleFromJson(ctx, resumeData, []);
        ctx.setProp(ctx.global, `__cache_${cacheKey}__`, cacheHandle);
        cacheHandle.dispose();
        
        // Return a new handle with the data
        const resultHandle = createHandleFromJson(ctx, resumeData, []);
        return resultHandle;
      }
    }
    resumeResultHandle?.dispose();
    
    // No cached result, need to suspend
    hostLog("ServiceProxy", "info", "No cached result, initiating suspension for gmail.users.messages.get");
    
    const stackRunId = _generateUUID();
    
    // Set suspension info
    const suspendInfoObj = ctx.newObject();
    ctx.setProp(suspendInfoObj, "suspended", ctx.true);
    ctx.setProp(suspendInfoObj, "stackRunId", ctx.newString(stackRunId));
    ctx.setProp(suspendInfoObj, "serviceName", ctx.newString("gapi"));
    ctx.setProp(suspendInfoObj, "method", ctx.newString("gmail.users.messages.get"));
    ctx.setProp(suspendInfoObj, "args", createHandleFromJson(ctx, args, []));
    ctx.setProp(ctx.global, "__suspendInfo__", suspendInfoObj);
    suspendInfoObj.dispose();
    
    // Store service call details
    const serviceCallObj = ctx.newObject();
    ctx.setProp(serviceCallObj, "stackRunId", ctx.newString(stackRunId));
    ctx.setProp(serviceCallObj, "service", ctx.newString("gapi"));
    ctx.setProp(serviceCallObj, "method", ctx.newString("gmail.users.messages.get"));
    ctx.setProp(serviceCallObj, "args", createHandleFromJson(ctx, args, []));
    ctx.setProp(serviceCallObj, "taskRunId", ctx.newString(taskRunId));
    ctx.setProp(serviceCallObj, "cacheKey", ctx.newString(cacheKey));
    ctx.setProp(ctx.global, "__pendingServiceCall__", serviceCallObj);
    serviceCallObj.dispose();
    
    hostLog("ServiceProxy", "info", `VM will suspend for gapi.gmail.users.messages.get, stackRunId: ${stackRunId}`);
    
    // Return suspension marker
    const suspensionMarker = ctx.newObject();
    ctx.setProp(suspensionMarker, "__vmSuspension__", ctx.true);
    ctx.setProp(suspensionMarker, "stackRunId", ctx.newString(stackRunId));
    ctx.setProp(suspensionMarker, "reason", ctx.newString("service_call"));
    
    return suspensionMarker;
  });
  
  ctx.setProp(messagesProxy, "list", messagesListFn);
  ctx.setProp(messagesProxy, "get", messagesGetFn);
  messagesListFn.dispose();
  messagesGetFn.dispose();
  
  ctx.setProp(gmailUsersProxy, "messages", messagesProxy);
  messagesProxy.dispose();
  
  ctx.setProp(gmailProxy, "users", gmailUsersProxy);
  gmailUsersProxy.dispose();
  
  ctx.setProp(serviceProxy, "gmail", gmailProxy);
  gmailProxy.dispose();
  
  return serviceProxy;
}

/**
 * Resolve a promise for a specific stack run ID with a result
 */
export function resolvePromiseForStackRun(stackRunId: string, result: any): void {
  const resolvers = globalResolvers.get(stackRunId);
  if (resolvers) {
    hostLog("Proxy-Generator", "info", `Resolving promise for stackRunId: ${stackRunId}`);
    resolvers.resolve(result);
    globalResolvers.delete(stackRunId);
  } else {
    hostLog("Proxy-Generator", "warn", `No promise resolver found for stackRunId: ${stackRunId}`);
  }
}

/**
 * Reject a promise for a specific stack run ID with an error
 */
export function rejectPromiseForStackRun(stackRunId: string, error: any): void {
  const resolvers = globalResolvers.get(stackRunId);
  if (resolvers) {
    hostLog("Proxy-Generator", "info", `Rejecting promise for stackRunId: ${stackRunId}`);
    resolvers.reject(error);
    globalResolvers.delete(stackRunId);
  } else {
    hostLog("Proxy-Generator", "warn", `No promise resolver found for stackRunId: ${stackRunId}`);
  }
}

// Removed createHandleFromJson as it's not directly used by generateServiceProxy here
// and a similar one exists in quickjs/index.ts. If needed, it should be consolidated.

// Removed createHostToolFn as it's unused and has unresolved issues.
// The primary proxy generation is handled by generateServiceProxy. 