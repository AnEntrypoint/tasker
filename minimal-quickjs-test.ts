// Simple test to verify QuickJS suspend/resume functionality
import { getQuickJS, QuickJSContext, QuickJSRuntime } from "npm:quickjs-emscripten";

// Example task with async/await
const testTask = `
module.exports = async function(input) {
  console.log("Starting test task with input:", JSON.stringify(input));
  
  // Track execution with checkpoints
  const checkpoints = [
    { step: "start", timestamp: new Date().toISOString() }
  ];
  
  // Simulate an async operation with setTimeout
  const sleepResult = await new Promise(resolve => {
    console.log("Starting sleep...");
    setTimeout(() => {
      console.log("Sleep completed");
      resolve({ slept: true, duration: 1000 });
    }, 1000);
  });
  
  // Add checkpoint after async operation
  checkpoints.push({ 
    step: "resumed", 
    timestamp: new Date().toISOString() 
  });
  
  console.log("Sleep result:", JSON.stringify(sleepResult));
  
  // Add final checkpoint
  checkpoints.push({ 
    step: "complete", 
    timestamp: new Date().toISOString() 
  });
  
  return {
    message: "Task completed successfully",
    input,
    sleepResult,
    checkpoints
  };
}`;

async function runQuickJSTest() {
  console.log("Initializing QuickJS...");
  const QuickJS = await getQuickJS();
  const rt = QuickJS.newRuntime();
  const vm = rt.newContext();
  
  // Set up console for logging
  setupConsole(vm);
  
  // Add timer functions to support async/await
  setupTimers(vm, rt);
  
  try {
    console.log("Evaluating test task...");
    
    // Create module.exports object
    const moduleObj = vm.newObject();
    const exportsObj = vm.newObject();
    vm.setProp(moduleObj, "exports", exportsObj);
    vm.setProp(vm.global, "module", moduleObj);
    
    // Evaluate the task code
    const evalResult = vm.evalCode(testTask);
    if (evalResult.error) {
      throw new Error(`Error evaluating task: ${vm.dump(evalResult.error)}`);
    }
    
    // Get the task function
    const taskFn = vm.getProp(moduleObj, "exports");
    if (vm.typeof(taskFn) !== "function") {
      throw new Error("Task is not a function");
    }
    
    // Create input object
    const input = { test: "QuickJS test" };
    const inputHandle = vm.newObject();
    vm.setProp(inputHandle, "test", vm.newString("QuickJS test"));
    
    console.log("Calling task function...");
    const resultHandle = vm.callFunction(taskFn, vm.undefined, inputHandle);
    
    // Handle Promise result
    if (vm.typeof(resultHandle) === "object") {
      console.log("Task returned a Promise, processing pending jobs...");
      
      // Process pending jobs to handle Promises
      let pendingJobs = 1;
      const maxJobs = 100;
      let jobCount = 0;
      
      while (pendingJobs > 0 && jobCount < maxJobs) {
        pendingJobs = rt.executePendingJobs();
        console.log(`Processed ${pendingJobs} pending jobs`);
        jobCount++;
        
        // Small delay to allow for async operations
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // Get the final result from the global context (if available)
      const finalResultHandle = vm.getProp(vm.global, "__result__");
      if (vm.typeof(finalResultHandle) !== "undefined") {
        const finalResult = vm.dump(finalResultHandle);
        console.log("Final result:", finalResult);
        finalResultHandle.dispose();
      } else {
        console.log("No final result available, task may not have completed");
      }
    } else {
      // Directly dump the result if not a Promise
      const result = vm.dump(resultHandle);
      console.log("Task result:", result);
    }
    
    // Clean up handles
    resultHandle.dispose();
    inputHandle.dispose();
    taskFn.dispose();
    exportsObj.dispose();
    moduleObj.dispose();
    
  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    // Dispose VM resources
    vm.dispose();
    rt.dispose();
  }
}

// Set up console object for logging
function setupConsole(vm: QuickJSContext) {
  const consoleObj = vm.newObject();
  
  const logFn = vm.newFunction("log", (...args: any[]) => {
    const stringArgs = args.map(arg => {
      if (vm.typeof(arg) === "string") {
        return vm.getString(arg);
      } else {
        try {
          return JSON.stringify(vm.dump(arg));
        } catch (e) {
          return "[Complex Object]";
        }
      }
    });
    
    console.log("[VM]", ...stringArgs);
  });
  
  vm.setProp(consoleObj, "log", logFn);
  vm.setProp(vm.global, "console", consoleObj);
  
  logFn.dispose();
}

// Set up timer functions to support async/await
function setupTimers(vm: QuickJSContext, rt: QuickJSRuntime) {
  // Create setTimeout function
  const setTimeoutFn = vm.newFunction("setTimeout", (callbackFn: any, delayHandle: any) => {
    if (vm.typeof(callbackFn) !== "function") {
      console.error("setTimeout: first argument must be a function");
      return vm.undefined;
    }
    
    const delay = vm.typeof(delayHandle) === "number" ? vm.getNumber(delayHandle) : 0;
    
    // Schedule the callback
    setTimeout(() => {
      try {
        vm.callFunction(callbackFn, vm.undefined);
        rt.executePendingJobs();
      } catch (e) {
        console.error("Error in setTimeout callback:", e);
      }
    }, delay);
    
    return vm.undefined;
  });
  
  vm.setProp(vm.global, "setTimeout", setTimeoutFn);
  setTimeoutFn.dispose();
  
  // Add Promise to global
  const evalPromisePolyfill = vm.evalCode(`
    globalThis.Promise = Promise;
    true;
  `);
  
  if (evalPromisePolyfill.error) {
    console.error("Error setting up Promise:", vm.dump(evalPromisePolyfill.error));
  }
}

// Run the test
runQuickJSTest(); 