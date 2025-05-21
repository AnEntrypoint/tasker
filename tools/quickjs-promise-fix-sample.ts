/**
 * QuickJS Promise Handling Fix - Sample Implementation
 * 
 * This is a simplified example of how to properly handle promises in QuickJS.
 * Adapt this to your actual quickjs/index.ts implementation.
 */

// Mock QuickJS types for illustration
interface QuickJSRuntime {
  executePendingJob(): any | null;
  dispose(): void;
}

interface QuickJSContext {
  evalCode(code: string): any;
  global: any;
  newPromise(): { promise: any, resolve: any, reject: any };
  dispose(): void;
}

class QuickJS {
  static Runtime = class {
    executePendingJob(): any | null {
      // In the real implementation, this would process a pending promise job
      return null;
    }
    
    newContext(): QuickJSContext {
      // In the real implementation, this would create a new context
      return null as any;
    }
    
    dispose(): void {
      // In the real implementation, this would clean up resources
    }
  };
}

/**
 * Process all pending promise jobs in the QuickJS runtime
 * This is critical for proper promise handling
 */
function processAllPendingJobs(rt: QuickJSRuntime): number {
  let jobsProcessed = 0;
  let res;
  
  // Process jobs until none remain
  do {
    res = rt.executePendingJob();
    if (res !== null) {
      jobsProcessed++;
    }
  } while (res !== null);
  
  return jobsProcessed;
}

/**
 * Create a new async-ready context with proper promise support
 */
function newAsyncContext(rt: QuickJSRuntime): QuickJSContext {
  const ctx = rt.newContext();
  
  // Add asyncify support for promises
  ctx.global.defineFunction("__asyncify_start__", () => {
    // In actual implementation, this would prepare for yielding
    console.log("Asyncify start");
  });
  
  ctx.global.defineFunction("__asyncify_stop__", () => {
    // In actual implementation, this would resume after yielding
    console.log("Asyncify stop");
  });
  
  // Add proper Promise implementation if needed
  // In some QuickJS versions, you might need to polyfill Promise
  
  return ctx;
}

/**
 * Helper to resolve a promise in the VM
 */
function resolvePromiseInVM(ctx: QuickJSContext, promiseHandle: any, value: any): void {
  const resolveFunc = ctx.getProp(promiseHandle, "resolve");
  ctx.callFunction(resolveFunc, promiseHandle, [value]);
  ctx.freeProp(promiseHandle, "resolve");
}

/**
 * Helper to reject a promise in the VM
 */
function rejectPromiseInVM(ctx: QuickJSContext, promiseHandle: any, reason: any): void {
  const rejectFunc = ctx.getProp(promiseHandle, "reject");
  ctx.callFunction(rejectFunc, promiseHandle, [reason]);
  ctx.freeProp(promiseHandle, "reject");
}

/**
 * Create VM proxies with proper promise handling
 */
function createVMProxy(service: any, serviceName: string): any {
  return new Proxy({}, {
    get(target, prop) {
      if (typeof prop === 'string') {
        return function(...args: any[]) {
          // In the actual implementation, this would call a host function
          // and get a promise, then return the promise handle directly
          const hostPromise = callHostFunction(serviceName, prop, ...args);
          return hostPromise;
        };
      }
      return undefined;
    }
  });
}

/**
 * Mock function to simulate calling a host function
 */
function callHostFunction(serviceName: string, method: string, ...args: any[]): Promise<any> {
  return Promise.resolve(`Called ${serviceName}.${method} with ${args.length} args`);
}

/**
 * Main execution function with proper promise handling
 */
async function executeInQuickJS(code: string, input: any = {}, context: any = {}): Promise<any> {
  const rt = new QuickJS.Runtime();
  const ctx = newAsyncContext(rt); // Use our async-aware context creator
  
  try {
    // Inject globals like console, fetch, etc.
    // ... (your existing code) ...
    
    // Inject tools object with proxies
    // ... (your existing code) ...
    
    // Execute the code
    const result = ctx.evalCode(code);
    
    // Process pending jobs immediately after initial execution
    // This is crucial for handling promises that were created during execution
    let jobsProcessed = processAllPendingJobs(rt);
    console.log(`Processed ${jobsProcessed} pending jobs after initial execution`);
    
    // If the result is a promise, we need to wait for it
    if (result && typeof result === 'object' && result.then) {
      return await result;
    }
    
    return result;
  } catch (error) {
    console.error("QuickJS execution error:", error);
    throw error;
  } finally {
    // Process any remaining jobs before cleanup
    // This ensures all promises are properly settled
    processAllPendingJobs(rt);
    
    // Dispose of resources
    ctx.dispose();
    rt.dispose();
  }
}

/**
 * Example for how to call VM functions that return promises
 */
async function callVMFunctionAsync(ctx: QuickJSContext, func: any, thisObj: any, args: any[]): Promise<any> {
  // Create a new promise in the VM
  const { promise, resolve, reject } = ctx.newPromise();
  
  try {
    // Call the function (which may return a promise)
    const result = ctx.callFunction(func, thisObj, args);
    
    // If the result is a promise, wait for it to settle
    if (result && typeof result === 'object' && result.then) {
      result.then(
        (value: any) => resolvePromiseInVM(ctx, promise, value),
        (reason: any) => rejectPromiseInVM(ctx, promise, reason)
      );
    } else {
      // Resolve immediately with the result
      resolvePromiseInVM(ctx, promise, result);
    }
    
    // Return the promise handle
    return promise;
  } catch (error) {
    // Reject the promise with the error
    rejectPromiseInVM(ctx, promise, error);
    return promise;
  }
}

/**
 * Main task execution with proper VM state saving/restoring
 */
async function executeTaskWithVMStateSaving(taskCode: string, input: any, context: any): Promise<any> {
  const rt = new QuickJS.Runtime();
  const ctx = newAsyncContext(rt);
  
  try {
    // ... setup code ...
    
    // Execute task and process pending jobs
    const result = ctx.evalCode(taskCode);
    processAllPendingJobs(rt);
    
    // ... handle result ...
    
    return result;
  } catch (error) {
    // Check if this is a "sleep" request 
    if (error && error.type === 'sleep') {
      // Save VM state to database
      const vmState = saveVMState(rt, ctx);
      
      // Insert record in stack_runs with sleeping status
      await saveStackRun(error.stackRunId, vmState, 'sleeping');
      
      // Return special response indicating sleep
      return { status: 'sleeping', stackRunId: error.stackRunId };
    }
    
    throw error;
  } finally {
    // Clean up
    processAllPendingJobs(rt);
    ctx.dispose();
    rt.dispose();
  }
}

/**
 * Mock function to simulate saving VM state
 */
function saveVMState(rt: QuickJSRuntime, ctx: QuickJSContext): string {
  // In the real implementation, this would serialize the VM state
  return "serialized-vm-state";
}

/**
 * Mock function to simulate saving to stack_runs table
 */
async function saveStackRun(stackRunId: string, vmState: string, status: string): Promise<void> {
  console.log(`Saving stack run ${stackRunId} with status ${status}`);
  // In the real implementation, this would save to the database
}

// Export for use in actual implementation
export {
  processAllPendingJobs,
  newAsyncContext,
  resolvePromiseInVM,
  rejectPromiseInVM,
  createVMProxy,
  executeInQuickJS,
  callVMFunctionAsync,
  executeTaskWithVMStateSaving
}; 