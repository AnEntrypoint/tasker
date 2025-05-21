/**
 * A test task that uses the suspend/resume mechanism with a test service call
 * This task will always suspend and resume
 * 
 * @param {Object} input - The input parameters
 * @param {string} [input.message="Hello"] - A test message
 * @returns {Object} The result of the suspension and resumption
 */
module.exports = async function testSuspendResumeService(input = {}) {
  console.log("Starting suspend/resume test task");
  console.log("Input:", JSON.stringify(input || {}));
  
  const message = input?.message || "Hello";
  console.log(`Message: ${message}`);
  
  // Create a result object
  const result = {
    original: message,
    processed: false,
    timestamp: new Date().toISOString()
  };
  
  try {
    console.log("About to make a service call that will suspend the VM");
    
    // This service call will cause the VM to suspend
    // The __callHostTool__ function in the QuickJS environment handles this
    if (typeof __callHostTool__ !== "function") {
      throw new Error("__callHostTool__ function is not available");
    }
    
    // Make the call with explicit await to ensure we wait for the result
    console.log("Making service call now, will await result");
    const serviceResult = await __callHostTool__(
      "test-service", 
      ["echo"], 
      [{ message }]
    );
    
    console.log("Service call completed after suspension/resumption");
    console.log("Service result:", JSON.stringify(serviceResult));
    
    // Update the result with the service call response
    result.processed = true;
    result.echoedMessage = serviceResult?.message || "No message returned";
    result.resumedAt = new Date().toISOString();
    
    return result;
  } catch (error) {
    console.error("Error in suspend/resume test:", error.message);
    console.error("Stack:", error.stack);
    
    return {
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}; 