/**
 * @task gapi-domains-flattened
 * @description Lists Google Workspace domains using a flattened approach
 * @param {object} input - Input parameters
 * @returns {Object} List of domains
 */
module.exports = async function execute(input, context) {
  console.log("Starting gapi-domains-flattened task");
  
  try {
    if (!context.tools) {
      throw new Error("tools object is undefined");
    }
    
    if (!context.tools.gapi) {
      throw new Error("gapi service is not available");
    }
    
    // Instead of using nested properties (gapi.admin.domains.list),
    // use the __callHostTool__ function directly with the method path
    console.log("Calling __callHostTool__ with explicit method path...");
    
    const customer = "my_customer";
    const result = await __callHostTool__("gapi", ["admin", "domains", "list"], [{ customer }]);
    
    console.log("GAPI call succeeded. Result type:", typeof result);
    console.log("Result keys:", Object.keys(result || {}).join(", "));
    
    // Process the domains
    const domains = result.domains || [];
    console.log(`Found ${domains.length} domains`);
    
    // Return the formatted result
    return {
      success: true,
      count: domains.length,
      domains: domains.map(domain => ({
        name: domain.domainName,
        isPrimary: domain.isPrimary || false,
        verified: domain.verified || false
      }))
    };
  } catch (error) {
    console.error("Error:", error.message || String(error));
    console.error("Stack:", error.stack || "No stack available");
    
    return {
      success: false,
      error: error.message || String(error)
    };
  }
} 