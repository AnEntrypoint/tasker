/**
 * A test task that uses the suspend/resume mechanism with the wrappedgapi service
 * This task will get a list of Google Workspace domains
 * 
 * @param {Object} input - The input parameters
 * @param {boolean} [input.verbose=false] - Enable verbose logging
 * @returns {Object} The result of the GAPI call with domain listing
 */
module.exports = async function testGapiDomainsService(input = {}) {
  console.log("Starting GAPI domains test with suspend/resume");
  console.log("Input:", JSON.stringify(input || {}));
  
  const verbose = input?.verbose || false;
  
  // Create a result object with checkpoints to track the process
  const result = {
    checkpoints: [
      {
        step: "start",
        timestamp: new Date().toISOString()
      }
    ],
    domains: null
  };
  
  try {
    if (verbose) console.log("About to call wrappedgapi service to list domains");
    
    // This call will cause the VM to suspend and resume
    // The explicit __callHostTool__ ensures we test the suspend/resume mechanism
    if (typeof __callHostTool__ !== "function") {
      throw new Error("__callHostTool__ function is not available");
    }
    
    // Make the GAPI call to list domains - this will suspend the VM
    console.log("Calling GAPI admin.domains.list...");
    const domainsResult = await __callHostTool__(
      "gapi", 
      ["admin", "domains", "list"], 
      [{ customer: "my_customer" }]
    );
    
    // Add checkpoint after resumption
    result.checkpoints.push({
      step: "after_gapi_call",
      timestamp: new Date().toISOString(),
      serviceResult: !!domainsResult
    });
    
    console.log("GAPI call completed after suspension/resumption");
    if (verbose) console.log("Domains result:", JSON.stringify(domainsResult, null, 2));
    
    // Process the domains result
    if (domainsResult && domainsResult.domains) {
      result.domains = domainsResult.domains.map(domain => ({
        domainName: domain.domainName,
        verified: domain.verified,
        isPrimary: domain.isPrimary
      }));
      result.domainCount = result.domains.length;
      result.success = true;
    } else {
      result.domains = [];
      result.domainCount = 0;
      result.success = false;
      result.error = "No domains returned from GAPI call";
    }
    
    // Add final checkpoint
    result.checkpoints.push({
      step: "complete",
      timestamp: new Date().toISOString()
    });
    
    return result;
  } catch (error) {
    console.error("Error in GAPI domains test:", error.message);
    
    // Add error checkpoint
    result.checkpoints.push({
      step: "error",
      timestamp: new Date().toISOString(),
      error: error.message
    });
    
    return {
      success: false,
      error: error.message,
      stack: error.stack,
      checkpoints: result.checkpoints
    };
  }
}; 