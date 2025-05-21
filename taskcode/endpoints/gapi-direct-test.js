/**
 * @task gapi-direct-test
 * @description Direct test of the GAPI service using callHostTool
 * @param {object} input - Input parameters
 * @returns {Object} Raw GAPI result
 */
module.exports = async function execute(input, context) {
  console.log("Starting gapi-direct-test task");
  
  try {
    // Check if tools object is properly initialized
    if (!context.tools) {
      console.error("Error: context.tools is undefined");
      return {
        success: false,
        error: "context.tools is undefined",
        contextKeys: Object.keys(context || {})
      };
    }

    console.log("Tools available:", Object.keys(context.tools).join(", "));
    
    // Check if global scope has __callHostTool__
    const hasHostTool = typeof __callHostTool__ === "function";
    console.log("Has __callHostTool__:", hasHostTool);
    
    if (!hasHostTool) {
      return {
        success: false,
        error: "__callHostTool__ is not available in global scope",
        globalKeys: Object.getOwnPropertyNames(globalThis).join(", ")
      };
    }
    
    console.log("Calling GAPI service directly with method chain...");
    // Make a direct call to the GAPI service using __callHostTool__
    const result = __callHostTool__("gapi", ["admin", "domains", "list"], [{ customer: "my_customer" }]);
    
    console.log("Result from __callHostTool__:", result);
    
    // Check if the result is a suspension marker
    if (result.__hostCallSuspended) {
      console.log("VM suspended for host call with stack run ID:", result.stackRunId);
      console.log("This is expected behavior. The actual result will be returned when the task resumes.");
      return {
        success: true,
        status: "suspended",
        stackRunId: result.stackRunId,
        serviceName: result.serviceName,
        methodName: result.methodName,
        message: "Task execution was suspended waiting for GAPI call to complete"
      };
    }
    
    // If we got a direct result (which shouldn't happen normally in async VM)
    return {
      success: true,
      result: result
    };
  } catch (error) {
    console.error("Error:", error.message || String(error));
    console.error("Error stack:", error.stack || "No stack available");
    
    return {
      success: false,
      error: error.message || String(error),
      stack: error.stack
    };
  }
} 