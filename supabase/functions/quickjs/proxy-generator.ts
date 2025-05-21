import { hostLog } from '../_shared/utils.ts';
import { _generateUUID, saveStackRun, triggerStackProcessor } from './vm-state-manager.ts';

// Declare global __callHostTool__ function
declare global {
  function __callHostTool__(service: string, method: string, args: any[]): any;
}

/**
 * Generates a proxy for a service that will suspend the VM on service method calls
 */
export function generateServiceProxy(name: string, ctx: any, taskRunId: string) {
  // Create a base proxy object
  const proxyObject = ctx.newObject();

  // Add a __callHostTool__ method that will save state and suspend the VM
  ctx.setProp(
    proxyObject,
    "__callHostTool__",
    ctx.newFunction("__callHostTool__", (serviceName: string, methodPath: string, argsHandle: any) => {
      try {
        hostLog("Proxy-Generator", "info", `Call to ${serviceName}.${methodPath}`);

        // Convert the arguments from QuickJS to JS
        const args = ctx.dump(argsHandle);

        // Prepare a promise that will be manually resolved on resume
        const deferred = ctx.newPromise();

        // Store the resolver in the global scope for resume
        const resolverObj = ctx.newObject();
        ctx.setProp(resolverObj, "resolve", deferred.resolve);
        ctx.setProp(resolverObj, "reject", deferred.reject);
        ctx.setProp(ctx.global, "__resumeResolver__", resolverObj);

        // Create unique ID for this suspend point
        const stackRunId = crypto.randomUUID();
        hostLog("Proxy-Generator", "info", `Generated stack run ID: ${stackRunId}`);

        // Signal to the host that we need to suspend execution
        // In the QuickJS executor, we'll detect this and handle suspension
        ctx.setProp(ctx.global, "__suspendInfo__", ctx.dump({
          suspended: true,
          stackRunId,
          serviceName,
          methodPath,
          args
        }));

        // Return the promise to be awaited in the VM
        // This promise will be resolved when the VM is resumed
        return deferred.promise;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        hostLog("Proxy-Generator", "error", `Error calling host tool: ${message}`);
        throw message;
      }
    })
  );

  // Add a proxy creator method
  ctx.setProp(
    proxyObject,
    "__createProxy__",
    ctx.newFunction("__createProxy__", (path: string) => {
      const subProxy = ctx.newObject();
      ctx.setProp(
        subProxy,
        "__path__",
        path
      );
      ctx.setProp(
        subProxy,
        "__callHostTool__",
        ctx.getProp(proxyObject, "__callHostTool__")
      );
      ctx.setProp(
        subProxy,
        "__createProxy__",
        ctx.getProp(proxyObject, "__createProxy__")
      );
      return subProxy;
    })
  );

  // Add a path property
  ctx.setProp(proxyObject, "__path__", "");

  return proxyObject;
}

/**
 * Create a handle from a JavaScript value
 */
export function createHandleFromJson(ctx: any, value: any, handles: any[]) {
  if (value === null || value === undefined) {
    return ctx.null;
  }
  
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return ctx.newValue(value);
  }
  
  if (Array.isArray(value)) {
    const arrayHandle = ctx.newArray();
    handles.push(arrayHandle);
    
    for (let i = 0; i < value.length; i++) {
      const elementHandle = createHandleFromJson(ctx, value[i], handles);
      ctx.setProp(arrayHandle, i, elementHandle);
    }
    
    return arrayHandle;
  }
  
  if (typeof value === 'object') {
    const objectHandle = ctx.newObject();
    handles.push(objectHandle);
    
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const propHandle = createHandleFromJson(ctx, value[key], handles);
        ctx.setProp(objectHandle, key, propHandle);
      }
    }
    
    return objectHandle;
  }
  
  // Fallback for unsupported types
  return ctx.newValue(String(value));
}

// Create a function to call a host tool (e.g., for GAPI calls)
function createHostToolFn(hostLog: Logger, serviceRoleKey: string) {
  return function(ctx: QuickJSContext) {
    return ctx.newAsyncifiedFunction('__callHostTool__', async (serviceName: string, methodPath: string[], args: any[]) => {
      hostLog('HostTool', 'info', `Host call: ${serviceName}.${methodPath.join('.')}`);
      
      // Save the call in a stack run if we have a VM context to resume
      if (ctx) {
        hostLog('HostTool', 'info', `Will suspend VM for call to ${serviceName}.${methodPath.join('.')}`);
        
        // Generate a unique ID for this stack run
        const stackRunId = generateUUID();
        hostLog('HostTool', 'info', `With stack run ID: ${stackRunId}`);
        
        // Save the VM state and the call details
        await __saveEphemeralCall__(hostLog, serviceRoleKey, {
          id: stackRunId,
          service_name: serviceName,
          method_name: methodPath[methodPath.length - 1] || '',  // Last part is the method name
          method_path: methodPath.slice(0, -1),  // All but the last part is the method path
          args: args,
          status: 'pending'
        });
        
        // Return an immediate empty result (actual result will be injected on resume)
        // The VM will continue execution when resumeAfterSuspend is called
        return {};
      }
      
      // Fall back to direct execution if no VM context
      hostLog('HostTool', 'warn', `No VM context for call to ${serviceName}.${methodPath.join('.')}, calling directly`);
      return {}; // Placeholder - this would be replaced with direct execution logic
    });
  };
} 