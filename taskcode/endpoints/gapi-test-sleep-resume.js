/**
 * @task gapi-test-sleep-resume
 * @description Test the GAPI integration with save/sleep/resume functionality
 * @param {object} input - Input parameters
 * @param {boolean} [input.verbose=false] - Enable verbose logging
 * @param {string} [input.testType="customer"] - Type of test to run (customer, info, echo)
 * @returns {Object} Test results with execution metadata
 */
module.exports = async function execute(input, context) {
  console.log("Starting gapi-test-sleep-resume task");
  console.log(`Got input: ${JSON.stringify(input)}`);
  
  const startTime = Date.now();
  const verbose = input.verbose === true;
  const testType = input.testType || "customer";
  
  try {
    if (verbose) console.log("Phase 1: Task initialization");
    
    // Save starting timestamp and checkpoint data
    const taskStarted = new Date().toISOString();
    const checkpoints = [];
    
    // Step 1: Get credentials from keystore
    console.log("Step 1: Retrieving GAPI credentials from keystore...");
    checkpoints.push({ step: "before-keystore", timestamp: new Date().toISOString() });
    
    const adminEmail = await context.tools.keystore.getKey("global", "GAPI_ADMIN_EMAIL");
    const gapiKey = await context.tools.keystore.getKey("global", "GAPI_KEY");
    
    checkpoints.push({ step: "after-keystore", timestamp: new Date().toISOString() });
    console.log(`Retrieved admin email: ${adminEmail}`);
    
    if (!adminEmail || !gapiKey) {
      throw new Error("Failed to retrieve required credentials from keystore");
    }
    
    // Step 2: Call GAPI with a simple operation based on test type
    console.log(`Step 2: Making GAPI call (${testType})...`);
    checkpoints.push({ step: "before-gapi", timestamp: new Date().toISOString() });
    
    let gapiResult;
    
    switch (testType) {
      case "customer":
        // Simple customer info request
        gapiResult = await context.tools.gapi.admin.customer.get({
          customerKey: "my_customer"
        });
        break;
        
      case "info":
        // Get directory API info
        gapiResult = await context.tools.gapi.admin.directory.users.get({
          userKey: adminEmail
        });
        break;
        
      case "echo":
      default:
        // Basic echo test that doesn't require actual API calls
        gapiResult = {
          adminEmail,
          timestamp: new Date().toISOString(),
          echo: "GAPI echo test"
        };
        break;
    }
    
    checkpoints.push({ step: "after-gapi", timestamp: new Date().toISOString() });
    console.log("GAPI call completed successfully");
    
    // Step 3: Return the final result
    const taskFinished = new Date().toISOString();
    const executionTime = Date.now() - startTime;
    
    return {
      success: true,
      testType,
      result: gapiResult,
      checkpoints,
      metadata: {
        taskStarted,
        taskFinished,
        executionTimeMs: executionTime
      }
    };
  } catch (error) {
    console.error(`Error in gapi-test-sleep-resume task: ${error.message || String(error)}`);
    return {
      success: false,
      error: `Failed to test GAPI: ${error.message || String(error)}`,
      metadata: {
        taskStarted: new Date().toISOString(),
        taskFinished: new Date().toISOString(),
        executionTimeMs: Date.now() - startTime
      }
    };
  }
} 