/**
 * @task gapi-domains-debug
 * @description Simple debug task for GAPI domain calls
 * @param {object} input - Input parameters
 * @param {boolean} [input.verbose=false] - Enable verbose logging
 * @returns {Object} Debug information
 */
module.exports = async function execute(input, context) {
  console.log("Starting gapi-domains-debug task with enhanced tracing");
  
  // Use a better debug format for objects
  function debugStringify(obj) {
    try {
      return JSON.stringify(obj, null, 2);
    } catch (e) {
      return `[Cannot stringify: ${e.message}]`;
    }
  }
  
  try {
    // Create debug info collection
    const debugInfo = {
      steps: [],
      results: {}
    };
    
    // Step 1: Check if context and tools are available
    console.log("Step 1: Checking context and tools");
    debugInfo.steps.push({
      step: "check-context",
      hasContext: !!context,
      hasTools: !!(context && context.tools),
      hasGapi: !!(context && context.tools && context.tools.gapi),
      timestamp: new Date().toISOString()
    });
    
    if (!context || !context.tools || !context.tools.gapi) {
      throw new Error("Missing required context or tools");
    }
    
    console.log("Context and tools are available");
    
    // Step 2: Log admin email from keystore for verification
    console.log("Step 2: Getting admin email from keystore");
    try {
      const adminEmail = await context.tools.keystore.getKey("global", "GAPI_ADMIN_EMAIL");
      console.log(`Admin email retrieved: ${adminEmail}`);
      
      debugInfo.steps.push({
        step: "keystore-admin-email",
        adminEmail: adminEmail,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      console.error(`Error getting admin email: ${e.message}`);
      debugInfo.steps.push({
        step: "keystore-error",
        error: e.message,
        timestamp: new Date().toISOString()
      });
    }
    
    // Step 3: Make direct call to GAPI
    console.log("Step 3: Calling GAPI admin.domains.list");
    debugInfo.steps.push({
      step: "calling-gapi",
      timestamp: new Date().toISOString()
    });
    
    try {
      // Make the direct call
      console.log("Making GAPI call...");
      const result = await context.tools.gapi.admin.domains.list({
        customer: "my_customer"
      });
      console.log("GAPI call completed");
      
      // Immediate logging of result
      console.log(`GAPI result type: ${typeof result}`);
      console.log(`GAPI result keys: ${result ? Object.keys(result).join(", ") : "undefined"}`);
      console.log(`GAPI result stringified: ${debugStringify(result)}`);
      
      // Log detailed info about the result
      debugInfo.steps.push({
        step: "gapi-result-received",
        resultType: typeof result,
        resultKeys: result ? Object.keys(result) : [],
        hasDomainsArray: !!(result && result.domains),
        hasItemsArray: !!(result && result.items),
        domainsLength: result && result.domains ? result.domains.length : 0,
        itemsLength: result && result.items ? result.items.length : 0,
        resultStringified: debugStringify(result),
        timestamp: new Date().toISOString()
      });
      
      // Store full result for analysis
      debugInfo.results.raw = result;
      
      // Try to extract domains with fallbacks
      console.log("Extracting domains from result");
      const domains = result?.domains || result?.items || [];
      console.log(`Extracted domains count: ${domains.length}`);
      
      if (domains.length > 0) {
        console.log(`First domain: ${debugStringify(domains[0])}`);
      }
      
      debugInfo.results.domains = domains;
      
      return {
        success: true,
        debugInfo: debugInfo,
        domains: domains,
        message: `Found ${domains.length} domains`
      };
    } catch (gapiError) {
      console.error(`GAPI error: ${gapiError.message || String(gapiError)}`);
      debugInfo.steps.push({
        step: "gapi-error",
        error: gapiError.message || String(gapiError),
        stack: gapiError.stack,
        timestamp: new Date().toISOString()
      });
      
      return {
        success: false,
        debugInfo: debugInfo,
        error: `GAPI call failed: ${gapiError.message || String(gapiError)}`
      };
    }
  } catch (error) {
    console.error(`Task error: ${error.message || String(error)}`);
    
    return {
      success: false,
      error: `Task failed: ${error.message || String(error)}`
    };
  }
} 