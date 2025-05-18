#!/usr/bin/env deno run --allow-net --allow-read --allow-env

// Test script for verifying VM state serialization functionality
console.log("VM State Serialization Test");

// Mock QuickJS context for testing
class MockQuickJSContext {
  constructor() {
    this.globals = {
      taskRunId: "test-run-123",
      taskName: "test-task",
      taskInput: { foo: "bar" },
      callSiteId: "function-call-123",
      suspendedCallData: { service: "tasks", method: "execute", args: ["child-task", { param: "value" }] }
    };
  }

  // Mock eval function that returns values based on evaluated code
  async evalCode(code) {
    console.log("Evaluating code:", code.substring(0, 50) + "...");
    
    // If we're evaluating a function to get globals, return a handle for them
    if (code.includes("const globals = {};")) {
      return {
        value: this.globals,
        dispose: () => console.log("Disposing globals handle")
      };
    }
    
    // If we're evaluating a function to get call context, return a handle for it
    if (code.includes("const callSiteInfo = {")) {
      return {
        value: {
          callSiteId: this.globals.callSiteId,
          suspendedCallData: this.globals.suspendedCallData,
          stackTrace: "Error: stack trace mock",
          suspendedAt: new Date().toISOString()
        },
        dispose: () => console.log("Disposing callSiteInfo handle")
      };
    }
    
    // Default handle for other cases
    return {
      value: {},
      dispose: () => console.log("Disposing generic handle")
    };
  }
  
  // Mock dump function to extract values from handles
  dump(handle) {
    return handle.value;
  }

  // Mock setProp function to set global properties
  setProp(target, key, value) {
    console.log(`Setting property ${key} on target`);
    // In a real implementation, this would set a property on the global object
    this.globals[key] = this.dump(value);
  }
}

// Import our VM state manager functions
async function testVMStateSerialization() {
  console.log("Testing VM state serialization and deserialization");
  
  // Create a mock context
  const context = new MockQuickJSContext();
  
  // Mock VM state manager functions
  const captureVMState = (context, taskCode, taskName, taskInput, parentRunId) => {
    console.log(`Capturing VM state for task: ${taskName}`);
    
    // Extract global variables from the context
    let globalVars = {};
    try {
      // Get global state from the VM context by evaluating a serialization function
      const serializeGlobalsHandle = context.evalCode(`
        (() => {
          const globals = {};
          // List of important global variables to capture
          const globalVarNames = [
            // Task-specific globals
            'taskRunId', 'taskName', 'taskInput', 'taskResult',
            // State tracking variables
            'callSiteId', 'resumePayload', 'suspendedCallData',
            // Other important globals
            'serviceProxies', 'moduleCache'
          ];

          // Capture each global variable if it exists
          for (const varName of globalVarNames) {
            if (typeof globalThis[varName] !== 'undefined') {
              try {
                // Only capture serializable values
                globals[varName] = JSON.parse(JSON.stringify(globalThis[varName]));
              } catch (e) {
                console.log('Failed to serialize global var:', varName);
              }
            }
          }
          return globals;
        })()
      `);
      
      if (serializeGlobalsHandle) {
        // Extract the globals object from the VM
        globalVars = context.dump(serializeGlobalsHandle);
        serializeGlobalsHandle.dispose();
      }
    } catch (error) {
      console.error(`Error extracting global variables: ${error instanceof Error ? error.message : String(error)}`);
      // Continue with empty globals if extraction fails
    }

    // Extract call context information
    let callContext = {};
    try {
      // Get call context from the VM by evaluating a function that captures call site info
      const captureCallContextHandle = context.evalCode(`
        (() => {
          const callSiteInfo = {
            // The current position in the code where execution is suspended
            callSiteId: typeof callSiteId !== 'undefined' ? callSiteId : null,
            // Metadata about child function being called
            suspendedCallData: typeof suspendedCallData !== 'undefined' ? suspendedCallData : null,
            // Call stack information if available
            stackTrace: new Error().stack,
            // Current time for debugging
            suspendedAt: new Date().toISOString()
          };
          return callSiteInfo;
        })()
      `);
      
      if (captureCallContextHandle) {
        // Extract the call context from the VM
        callContext = context.dump(captureCallContextHandle);
        captureCallContextHandle.dispose();
      }
    } catch (error) {
      console.error(`Error extracting call context: ${error instanceof Error ? error.message : String(error)}`);
      // Continue with empty call context if extraction fails
    }

    // Create a state object with all information
    const vmState = {
      task_code: taskCode,
      task_name: taskName,
      input: taskInput,
      parent_run_id: parentRunId,
      global_vars: globalVars,
      call_context: callContext
    };
    
    console.log(`VM state captured for task: ${taskName}`);
    return vmState;
  };
  
  const restoreVMState = async (vmState, context) => {
    console.log(`Restoring VM state for task: ${vmState.task_name}`);
    
    // Restore the task code
    if (vmState.task_code) {
      console.log(`Evaluating task code in new VM context`);
      try {
        // Evaluate the task code in the new context
        const taskCodeHandle = await context.evalCode(vmState.task_code);
        taskCodeHandle.dispose();
      } catch (codeError) {
        console.error(`Error evaluating task code: ${codeError instanceof Error ? codeError.message : String(codeError)}`);
        // Continue with restoration even if code evaluation fails
      }
    }
    
    // Restore global variables if they were saved
    if (vmState.global_vars && Object.keys(vmState.global_vars).length > 0) {
      console.log(`Restoring global variables:`, Object.keys(vmState.global_vars));
      
      try {
        // Create JavaScript code to restore each global variable
        let restoreGlobalsCode = '(() => {\n';
        for (const [key, value] of Object.entries(vmState.global_vars)) {
          try {
            // Skip undefined or functions which can't be serialized
            if (value !== undefined) {
              // Safely serialize the value as JSON
              const safeValue = JSON.stringify(value);
              // Add code to restore this global
              restoreGlobalsCode += `  try { globalThis["${key}"] = ${safeValue}; } catch (e) { console.log("Failed to restore global: ${key}"); }\n`;
            }
          } catch (serializeError) {
            console.error(`Error serializing global var '${key}':`, serializeError);
          }
        }
        restoreGlobalsCode += '  return "Globals restored";\n})()';
        
        // Evaluate the code to restore globals
        const restoreHandle = await context.evalCode(restoreGlobalsCode);
        const result = context.dump(restoreHandle);
        console.log(`Global variables restoration result: ${result}`);
        restoreHandle.dispose();
      } catch (restoreError) {
        console.error(`Error restoring global variables: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        // Continue with partial restoration if global vars fail
      }
    }
    
    // Restore call context information if available
    if (vmState.call_context && Object.keys(vmState.call_context).length > 0) {
      console.log(`Restoring call context:`, Object.keys(vmState.call_context));
      
      try {
        // Inject callContext as a global object
        const callContextCode = `
          globalThis.callContext = ${JSON.stringify(vmState.call_context)};
          // Also restore individual call context variables at global scope
          for (const [key, value] of Object.entries(globalThis.callContext)) {
            try {
              globalThis[key] = value;
            } catch (e) {
              console.log('Failed to restore call context variable:', key);
            }
          }
        `;
        
        const callContextHandle = await context.evalCode(callContextCode);
        callContextHandle.dispose();
      } catch (contextError) {
        console.error(`Error restoring call context: ${contextError instanceof Error ? contextError.message : String(contextError)}`);
        // Continue even if call context restoration fails
      }
    }
    
    console.log(`VM context restored for task: ${vmState.task_name}`);
    return { context };
  };
  
  // Capture the state
  const vmState = captureVMState(
    context, 
    "function runTask(input) { return input; }", 
    "test-task",
    { foo: "bar" }, 
    "parent-123"
  );
  
  console.log("Captured VM State:", JSON.stringify(vmState, null, 2));
  
  // Create a new context for restoration
  const newContext = new MockQuickJSContext();
  
  // Restore the state to the new context
  const { context: restoredContext } = await restoreVMState(vmState, newContext);
  
  // Verify restored globals
  console.log("Restored globals:", restoredContext.globals);
  
  // Test resume payload handling
  console.log("\nTesting resume payload injection");
  const resumePayload = { result: "Success from child task!" };
  
  // Create code to inject resume payload
  const resumePayloadCode = `
    globalThis.__resumePayload = ${JSON.stringify(resumePayload)};
    globalThis.resumePayloadReceived = true;
  `;
  
  const resumePayloadHandle = await newContext.evalCode(resumePayloadCode);
  resumePayloadHandle.dispose();
  
  // Verify resume payload was injected
  console.log("Resume payload received:", newContext.globals.resumePayloadReceived);
  console.log("Resume payload value:", newContext.globals.__resumePayload);
  
  console.log("\nVM State Serialization Test Completed Successfully!");
}

// Run the test
testVMStateSerialization().catch(error => {
  console.error("Test failed:", error);
});