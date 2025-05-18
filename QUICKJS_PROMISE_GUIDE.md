# Guide to Properly Handling Promises in QuickJS

This guide explains how to properly handle promises in the QuickJS environment used by Tasker, especially in the context of task execution.

## Understanding QuickJS Promise Execution

QuickJS, unlike browser JavaScript engines or Node.js, doesn't have an implicit event loop that automatically processes pending promise jobs. Instead, promises must be explicitly processed by calling `runtime.executePendingJob()`. This has important implications for asynchronous code execution.

## Key Concepts

1. **Explicit Job Processing**: In QuickJS, pending promise operations need to be explicitly processed.
2. **Asyncify Bridging**: When a host function returns a promise, QuickJS needs to use asyncify to bridge between the host's promise and the VM's promise.
3. **Promise Resolution**: Promises must be properly awaited and their pending jobs must be processed.

## Best Practices for Promise Handling in Tasks

### 1. Always Use Async/Await for Asynchronous Operations

```javascript
// ✅ Good:
async function runTask(input) {
  const result = await tools.someService.someMethod();
  return { success: true, data: result };
}

// ❌ Bad:
function runTask(input) {
  return tools.someService.someMethod().then(result => {
    return { success: true, data: result };
  });
}
```

### 2. Properly Handle Promise Errors with Try/Catch

```javascript
// ✅ Good:
async function runTask(input) {
  try {
    const result = await tools.someService.someMethod();
    return { success: true, data: result };
  } catch (error) {
    console.error("Error:", error.message);
    return { success: false, error: error.message };
  }
}

// ❌ Bad:
async function runTask(input) {
  const result = await tools.someService.someMethod();  // Unhandled promise rejection if this fails
  return { success: true, data: result };
}
```

### 3. Sequential vs. Parallel Promise Execution

```javascript
// Sequential execution - one after the other
async function sequential() {
  const result1 = await tools.service.method1();
  const result2 = await tools.service.method2();
  return [result1, result2];
}

// Parallel execution - all at once
async function parallel() {
  const promises = [
    tools.service.method1(),
    tools.service.method2()
  ];
  return await Promise.all(promises);
}
```

### 4. Avoid Missing Await

```javascript
// ✅ Good:
async function runTask(input) {
  const result = await tools.someService.someMethod();
  return result;
}

// ❌ Bad:
async function runTask(input) {
  const result = tools.someService.someMethod();  // Missing await!
  return result;  // Returns a promise, not the resolved value
}
```

## How QuickJS Handles Promises in the VM

When using promises in QuickJS:

1. The VM executes your JavaScript code.
2. When an async function or promise is encountered, it creates pending jobs.
3. The VM needs to explicitly process these pending jobs by calling `runtime.executePendingJob()`.
4. When a promise resolves, its `.then()` handlers are queued as pending jobs.
5. The VM processes these jobs to continue execution.

The Tasker system handles this complexity for you by:

1. Using asyncified functions to bridge between host promises and VM promises.
2. Explicitly processing pending jobs after promises are resolved.
3. Properly handling suspended tasks when calling external services.

## Implementation in the Executor

The QuickJS executor in Tasker handles promises by:

1. Creating an async context for the VM.
2. Properly awaiting promise results with `vm.resolvePromise()`.
3. Processing any pending jobs after the promise resolves with `runtime.executePendingJob()`.
4. Handling suspensions and resumptions for nested async calls.

## Example Task with Proper Promise Handling

See the `promise-handling-example.js` task for complete examples of proper promise handling in QuickJS.

To run the example, use the `test-promise-example.ts` script:

```bash
deno run --allow-read --allow-env --allow-net test-promise-example.ts
```

## Common Issues and Solutions

### Issue: Unhandled Promise Rejection

**Cause**: Missing try/catch around await or not handling promise rejections.

**Solution**: Always wrap async operations in try/catch blocks.

### Issue: Promise Result Not Available

**Cause**: Missing await when calling async functions.

**Solution**: Always use await when calling any function that returns a promise.

### Issue: Task Hangs

**Cause**: Pending promise jobs not being processed.

**Solution**: This is handled by the executor, but make sure your async code properly awaits all promises.

### Issue: Promise Resolution in Nested Calls

**Cause**: Complex nested promises can cause issues with job processing.

**Solution**: Use async/await with clean sequential code rather than complex promise chains.

## Further Reading

- [QuickJS Documentation](https://bellard.org/quickjs/quickjs.html)
- [MDN: Using Promises](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Using_promises)
- [MDN: Async/Await](https://developer.mozilla.org/en-US/docs/Learn/JavaScript/Asynchronous/Async_await) 