/**
 * @task test-save-sleep-resume
 * @description Simple synchronous test task for QuickJS
 * @param {object} input - Input parameters
 * @param {boolean} [input.verbose=false] - Enable verbose logging
 * @returns {Object} Test results with simple data
 */
module.exports = function execute(input, context) {
  console.log("Starting test-save-sleep-resume task");
  console.log(`Got input: ${JSON.stringify(input)}`);
  
  // Make sure input is properly initialized as an object to avoid null reference errors
  input = input || {};
  
  const startTime = Date.now();
  const verbose = input?.verbose === true;
  
  try {
    console.log("Phase 1: Initialization");
    
    // Create a simple result object with test data
    const taskStarted = new Date().toISOString();
    
    // Create checkpoints right away
    const checkpoints = [
      { step: "initialization", timestamp: new Date().toISOString() },
      { step: "processing", timestamp: new Date().toISOString() },
      { step: "completion", timestamp: new Date().toISOString() }
    ];
    
    console.log("Added all checkpoints synchronously");
    console.log("Task complete");
    
    // Prepare the final result
    const taskFinished = new Date().toISOString();
    const executionTime = Date.now() - startTime;
    
    const result = {
      success: true,
      message: "Task executed successfully",
      checkpoints: checkpoints,
      metadata: {
        taskStarted,
        taskFinished,
        executionTimeMs: executionTime
      }
    };
    
    console.log(`RETURNING RESULT: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    console.error(`Error in test-save-sleep-resume task: ${error.message || String(error)}`);
    const errorResult = {
      success: false,
      error: `Task execution failed: ${error.message || String(error)}`,
      metadata: {
        taskStarted: new Date().toISOString(),
        taskFinished: new Date().toISOString(),
        executionTimeMs: Date.now() - startTime
      }
    };
    console.log(`RETURNING ERROR: ${JSON.stringify(errorResult)}`);
    return errorResult;
  }
} 