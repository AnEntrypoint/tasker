/**
 * @task gapi-domains-helper
 * @description Lists Google Workspace domains using a helper function
 * @param {object} input - Input parameters
 * @returns {Object} List of domains
 */
module.exports = async function execute(input, context) {
  console.log("Starting gapi-domains-helper task");
  
  /**
   * Helper function to safely call GAPI services with nested paths
   * @param {string[]} path - Array of path segments (e.g., ["admin", "domains", "list"])
   * @param {Array<any>} args - Arguments to pass to the method
   * @returns {Promise<any>} - The result of the GAPI call
   */
  async function callGapiSafely(path, args) {
    console.log(`Calling GAPI with path: [${path.join(", ")}]`);
    
    if (typeof __callHostTool__ === "function") {
      // Direct approach using the global __callHostTool__ function
      console.log("Using __callHostTool__ for direct GAPI call");
      return await __callHostTool__("gapi", path, args || []);
    } else {
      // Fallback approach navigating the object tree
      console.log("__callHostTool__ not available, using object navigation");
      
      let current = context.tools.gapi;
      if (!current) {
        throw new Error("GAPI service is not available");
      }
      
      // Navigate to the nested property
      for (let i = 0; i < path.length - 1; i++) {
        current = current[path[i]];
        if (!current) {
          throw new Error(`GAPI path segment '${path[i]}' is not available`);
        }
      }
      
      // Call the final method
      const method = current[path[path.length - 1]];
      if (typeof method !== "function") {
        throw new Error(`GAPI method '${path[path.length - 1]}' is not a function`);
      }
      
      return await method.apply(current, args || []);
    }
  }
  
  try {
    if (!context.tools) {
      throw new Error("tools object is undefined");
    }
    
    // Call the domains.list method using our helper
    const result = await callGapiSafely(["admin", "domains", "list"], [{ customer: "my_customer" }]);
    
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