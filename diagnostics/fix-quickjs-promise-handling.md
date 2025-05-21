# Fixing QuickJS Promise Handling Issues

This guide addresses the QuickJS promise handling issues that can cause tasks to get "stuck" in a running state indefinitely.

## Problem Description

QuickJS requires explicit job processing via `JS_ExecutePendingJob()` to handle promises and async operations. Unlike browsers or Node.js, QuickJS has no implicit event loop in embedded environments. When promises are used in QuickJS, the pending jobs must be manually processed, or promises will never resolve/reject, causing tasks to hang indefinitely.

The current symptoms include:
- Tasks get stuck in "running" state
- VM state isn't being properly saved
- Sleep/resume cycle is incomplete

## Solution Approach

The solution involves updating the QuickJS executor in `supabase/functions/quickjs/index.ts` to properly handle promises by:

1. Implementing a job processing loop with `rt.executePendingJobs()`
2. Ensuring proper use of `newAsyncContext()` for Asyncify support
3. Using `ctx.resolvePromise()` for promise settlement
4. Making VM proxy generators correctly handle promise returns

## Implementation Steps

Here's how to fix the QuickJS promise handling in your system:

### 1. Job Processing Loop Implementation

Add a function to process all pending jobs until none remain:

```typescript
// Add this function to supabase/functions/quickjs/index.ts

/**
 * Process all pending jobs in the QuickJS runtime
 * This is critical for proper promise handling
 */
function processAllPendingJobs(rt) {
  let jobsProcessed = 0;
  let res;
  do {
    res = rt.executePendingJob();
    if (res !== null) {
      jobsProcessed++;
    }
  } while (res !== null);
  return jobsProcessed;
}
```

### 2. Update the QuickJS execution function

Modify the main execution function to call the job processor at key points:

```typescript
// Update the execution function in supabase/functions/quickjs/index.ts

async function executeInQuickJS(code, input, context) {
  const rt = new QuickJS.Runtime();
  const ctx = rt.newContext();
  
  try {
    // ... existing setup code ...
    
    // Execute the code
    const result = ctx.evalCode(code);
    
    // Process any pending jobs immediately after execution
    let jobsProcessed = processAllPendingJobs(rt);
    console.log(`Processed ${jobsProcessed} pending jobs after initial execution`);
    
    // ... handle result ...
    
    // Return the result
    return result;
  } catch (error) {
    // ... error handling ...
  } finally {
    // Make sure to process any remaining jobs before cleanup
    processAllPendingJobs(rt);
    ctx.dispose();
    rt.dispose();
  }
}
```

### 3. Ensure Proper Async Function Wrapping

Update the VM proxy generator to handle promises correctly:

```typescript
// Update the VM proxy generator in supabase/functions/quickjs/index.ts

function createVMProxy(service, serviceName) {
  return new Proxy({}, {
    get(target, prop) {
      if (typeof prop === 'string') {
        return function(...args) {
          // Call the host function and get a promise
          const promise = __callHostTool__(serviceName, prop, ...args);
          
          // Important: Return the promise handle directly
          // Let the VM's await operate on this handle via Asyncify
          return promise;
        };
      }
    }
  });
}
```

### 4. Implement Asyncify Helper Functions

Add these helper functions to support asynchronous operations:

```typescript
// Add these helper functions to supabase/functions/quickjs/index.ts

/**
 * Create a new QuickJS async context with proper promise support
 */
function newAsyncContext(rt) {
  const ctx = rt.newContext();
  
  // Add asyncify support
  ctx.global.defineFunction("__asyncify_start__", () => {
    // Implementation specific to QuickJS asyncify
  });
  
  ctx.global.defineFunction("__asyncify_stop__", () => {
    // Implementation specific to QuickJS asyncify
  });
  
  return ctx;
}

/**
 * Resolve a promise in the QuickJS context
 */
function resolvePromiseInVM(ctx, promiseHandle, value) {
  const resolveFunc = ctx.getProp(promiseHandle, "resolve");
  ctx.callFunction(resolveFunc, promiseHandle, [value]);
  ctx.freeProp(promiseHandle, "resolve");
}

/**
 * Reject a promise in the QuickJS context
 */
function rejectPromiseInVM(ctx, promiseHandle, reason) {
  const rejectFunc = ctx.getProp(promiseHandle, "reject");
  ctx.callFunction(rejectFunc, promiseHandle, [reason]);
  ctx.freeProp(promiseHandle, "reject");
}
```

## Testing the Fix

After implementing these changes:

1. Deploy the updated QuickJS edge function
2. Run the `diagnose-vm-state.ts` tool to verify VM state handling
3. Test with a simple sleep/resume task to ensure promises resolve correctly

## Additional Resources

- QuickJS Documentation: https://bellard.org/quickjs/quickjs.html
- QuickJS Promises Guide: https://bellard.org/quickjs/quickjs.pdf (Section 7.3)
- Asyncify Explanation: https://kripken.github.io/blog/wasm/2019/07/16/asyncify.html 