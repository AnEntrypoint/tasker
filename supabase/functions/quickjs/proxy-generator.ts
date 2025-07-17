import { hostLog } from '../_shared/utils.ts';
import { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";
import { SerializedVMState, saveStackRun, _generateUUID, getSupabaseClient } from './vm-state-manager.ts';

// Global storage for promise resolvers (JavaScript functions, not QuickJS handles)
export const globalResolvers = new Map<string, {
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
  ctx: QuickJSContext, 
  taskRunId: string,
  currentTaskCode: string, 
  currentTaskName: string, 
  currentTaskInput: any
) {
  // Create the root service proxy
  const serviceProxy = ctx.newObject();
  
  // Create admin object
  const adminProxy = ctx.newObject();
  
  // Create domains object under admin
  const domainsProxy = ctx.newObject();
  
  // Create the list function that will suspend the VM
  const listFn = ctx.newFunction("list", (...argHandles: QuickJSHandle[]) => {
    const args = argHandles.map(h => ctx.dump(h));
    
    hostLog("ServiceProxy", "info", `GAPI admin.domains.list called with args:`, args);
    
    // Use __callHostTool__ pattern for suspend
    const serviceNameHandle = ctx.newString("gapi");
    const methodChainHandle = ctx.newArray();
    ctx.setProp(methodChainHandle, "0", ctx.newString("admin"));
    ctx.setProp(methodChainHandle, "1", ctx.newString("domains"));
    ctx.setProp(methodChainHandle, "2", ctx.newString("list"));
    ctx.setProp(methodChainHandle, "length", ctx.newNumber(3));
    
    const argsHandle = ctx.newArray();
    args.forEach((arg, index) => {
      const argHandle = ctx.newString(JSON.stringify(arg));
      ctx.setProp(argsHandle, index.toString(), argHandle);
      argHandle.dispose();
    });
    ctx.setProp(argsHandle, "length", ctx.newNumber(args.length));
    
    // Get the __callHostTool__ function
    const callHostToolHandle = ctx.getProp(ctx.global, "__callHostTool__");
    if (ctx.typeof(callHostToolHandle) === "function") {
      const result = ctx.callFunction(callHostToolHandle, ctx.undefined, serviceNameHandle, methodChainHandle, argsHandle);
      
      // Cleanup
      serviceNameHandle.dispose();
      methodChainHandle.dispose();
      argsHandle.dispose();
      callHostToolHandle.dispose();
      
      return result.value;
    } else {
      hostLog("ServiceProxy", "error", "__callHostTool__ not found");
      serviceNameHandle.dispose();
      methodChainHandle.dispose();
      argsHandle.dispose();
      callHostToolHandle.dispose();
      return ctx.newString("__ERROR__");
    }
  });
  
  // Set up the structure: gapi.admin.domains.list
  ctx.setProp(domainsProxy, "list", listFn);
  listFn.dispose();
  
  ctx.setProp(adminProxy, "domains", domainsProxy);
  domainsProxy.dispose();
  
  ctx.setProp(serviceProxy, "admin", adminProxy);
  adminProxy.dispose();
  
  // Also create admin.users.list for the second call in the task
  const usersProxy = ctx.newObject();
  const usersListFn = ctx.newFunction("list", (...argHandles: QuickJSHandle[]) => {
    const args = argHandles.map(h => ctx.dump(h));
    
    hostLog("ServiceProxy", "info", `GAPI admin.users.list called with args:`, args);
    
    // Use __callHostTool__ pattern for suspend
    const serviceNameHandle = ctx.newString("gapi");
    const methodChainHandle = ctx.newArray();
    ctx.setProp(methodChainHandle, "0", ctx.newString("admin"));
    ctx.setProp(methodChainHandle, "1", ctx.newString("users"));
    ctx.setProp(methodChainHandle, "2", ctx.newString("list"));
    ctx.setProp(methodChainHandle, "length", ctx.newNumber(3));
    
    const argsHandle = ctx.newArray();
    args.forEach((arg, index) => {
      const argHandle = ctx.newString(JSON.stringify(arg));
      ctx.setProp(argsHandle, index.toString(), argHandle);
      argHandle.dispose();
    });
    ctx.setProp(argsHandle, "length", ctx.newNumber(args.length));
    
    // Get the __callHostTool__ function
    const callHostToolHandle = ctx.getProp(ctx.global, "__callHostTool__");
    if (ctx.typeof(callHostToolHandle) === "function") {
      const result = ctx.callFunction(callHostToolHandle, ctx.undefined, serviceNameHandle, methodChainHandle, argsHandle);
      
      // Cleanup
      serviceNameHandle.dispose();
      methodChainHandle.dispose();
      argsHandle.dispose();
      callHostToolHandle.dispose();
      
      return result.value;
    } else {
      hostLog("ServiceProxy", "error", "__callHostTool__ not found");
      serviceNameHandle.dispose();
      methodChainHandle.dispose();
      argsHandle.dispose();
      callHostToolHandle.dispose();
      return ctx.newString("__ERROR__");
    }
  });
  
  ctx.setProp(usersProxy, "list", usersListFn);
  usersListFn.dispose();
  
  // Get the admin proxy again and add users to it
  const adminProxyAgain = ctx.getProp(serviceProxy, "admin");
  ctx.setProp(adminProxyAgain, "users", usersProxy);
  adminProxyAgain.dispose();
  usersProxy.dispose();
  
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