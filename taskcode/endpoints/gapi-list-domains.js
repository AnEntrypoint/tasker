/**
 * @task gapi-list-domains
 * @description Lists Google Workspace domains for the organization
 * @param {object} input - Input parameters
 * @param {string} [input.customer="my_customer"] - Customer ID to list domains for
 * @returns {Object} List of domains with metadata
 */
module.exports = async function execute(input, context) {
  console.log("Starting gapi-list-domains task");
  
  try {
    // Import the gapi-helper module
    let gapiHelper;
    
    try {
      // Try to import from shared
      gapiHelper = await context.tasks.require("../shared/gapi-helper");
      console.log("Successfully loaded gapi-helper module");
    } catch (loadError) {
      console.warn(`Could not load helper module: ${loadError.message}`);
      console.log("Using direct __callHostTool__ approach instead");
      
      // Define inline helper if module loading fails
      gapiHelper = {
        callGapiService: async function(ctx, path, args) {
          console.log(`Calling GAPI directly with path: [${path.join(', ')}]`);
          if (typeof __callHostTool__ !== "function") {
            throw new Error("__callHostTool__ function is not available");
          }
          return await __callHostTool__("gapi", path, args || []);
        }
      };
    }

    // Parse and validate input
    const customer = input?.customer || "my_customer";
    console.log(`Using customer ID: ${customer}`);
    
    // Call GAPI to list domains
    console.log("Calling GAPI admin.domains.list...");
    const result = await gapiHelper.callGapiService(
      context,
      ["admin", "domains", "list"],
      [{ customer }]
    );
    
    // Process the result
    console.log("GAPI call succeeded");
    console.log("Result keys:", Object.keys(result || {}).join(", "));
    
    // Extract domains from the result
    const domains = result.domains || [];
    console.log(`Found ${domains.length} domains`);
    
    // Format and return the result
    return {
      success: true,
      timestamp: new Date().toISOString(),
      count: domains.length,
      domains: domains.map(domain => ({
        name: domain.domainName,
        isPrimary: !!domain.isPrimary,
        verified: !!domain.verified,
        creationTime: domain.creationTime || null
      }))
    };
  } catch (error) {
    console.error("Error in gapi-list-domains task:", error.message || String(error));
    console.error("Stack:", error.stack || "No stack available");
    
    return {
      success: false,
      timestamp: new Date().toISOString(),
      error: error.message || String(error)
    };
  }
} 