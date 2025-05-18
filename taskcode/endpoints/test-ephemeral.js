/**
 * @task test-ephemeral
 * @description A simple test task to debug ephemeral execution with nested calls
 * @param {object} input - Input parameters
 * @param {boolean} [input.failStep1] - Whether to fail the first step
 * @param {boolean} [input.failStep2] - Whether to fail the second step
 * @returns {object} Results from both steps
 */
module.exports = async function execute(input, context) {
  console.log("Starting test-ephemeral task");
  
  try {
    // Verify tools are available
    if (!context || !context.tools || !context.tools.tasks) {
      throw new Error("Tasks service not available in context.tools");
    }
    
    // Step 1: Call another task (using the built-in module-diagnostic)
    console.log("STEP 1: Calling module-diagnostic task");
    const step1Result = await context.tools.tasks.execute("module-diagnostic", { testData: "from-test-ephemeral" });
    console.log("STEP 1 COMPLETED:", JSON.stringify(step1Result));
    
    // Optionally fail after step 1
    if (input.failStep1) {
      throw new Error("Deliberate failure after step 1");
    }
    
    // Step 2: Call a fake GAPI method to test another service
    console.log("STEP 2: Calling GAPI authenticate");
    
    // Check if GAPI is available
    if (!context.tools.gapi) {
      return { 
        step1: step1Result, 
        step2: null, 
        error: "GAPI service not available" 
      };
    }
    
    try {
      const step2Result = await context.tools.gapi.authenticate("test-scope");
      console.log("STEP 2 COMPLETED:", JSON.stringify(step2Result));
      
      // Optionally fail after step 2
      if (input.failStep2) {
        throw new Error("Deliberate failure after step 2");
      }
      
      return {
        step1: step1Result,
        step2: step2Result,
        success: true
      };
    } catch (step2Error) {
      console.error("Error in step 2:", step2Error);
      return {
        step1: step1Result,
        step2: null,
        error: `Step 2 failed: ${step2Error.message || String(step2Error)}`
      };
    }
  } catch (error) {
    console.error("Error in test-ephemeral task:", error);
    throw new Error(`Error: ${error.message || String(error)}`);
  }
} 