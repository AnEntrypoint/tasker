/**
 * @task gapi-list-domains
 * @description List all domains for a G Suite/Google Workspace account using Google Admin SDK
 * @param {object} input - Input parameters
 * @param {boolean} [input.authOnly] - If true, only authenticate and return auth result
 * @param {boolean} [input.includeStats] - Include usage statistics in the result
 * @param {string} [input.customer] - Customer ID (defaults to admin email from keystore)
 * @returns {Object} Domain information
 */
module.exports = async function(input) {
  console.log("Starting gapi-list-domains task");
  console.log(`Got input: ${JSON.stringify(input)}`);
  
  try {
    // Check if tools is defined
    if (typeof tools === 'undefined') {
      console.error("Tools object is undefined!");
      throw new Error("Tools object is undefined. The QuickJS environment is not properly configured.");
    }
    
    // Get gapi and keystore from tools
    const gapi = tools.gapi;
    const keystore = tools.keystore;
    
    if (!gapi) {
      console.error("tools.gapi is undefined!");
      throw new Error("tools.gapi is undefined. The QuickJS environment is not properly configured.");
    }
    
    if (!keystore) {
      console.error("tools.keystore is undefined!");
      throw new Error("tools.keystore is undefined. The QuickJS environment is not properly configured.");
    }
    
    // Get admin email from keystore
    let adminEmail = null;
    try {
      adminEmail = await keystore.getKey("global", "GAPI_ADMIN_EMAIL");
      console.log(`Retrieved admin email from keystore: ${adminEmail}`);
    } catch (error) {
      console.warn(`Failed to retrieve admin email from keystore: ${error.message}`);
      console.warn("Will use any customer ID provided in input or fallback to 'my_customer'");
    }
    
    // Validate input parameters
    const customerId = input.customer || adminEmail;
    console.log(`Using customer ID: ${customerId}`);
    
    if (!customerId) {
      console.warn("No customer ID provided or found in keystore. Using 'my_customer' as fallback.");
    }
    
    const authOnly = input.authOnly || false;
    const includeStats = input.includeStats || false;
    
    // Check if gapi.authenticate exists
    if (typeof gapi.authenticate !== 'function') {
      console.error("gapi.authenticate is not a function!");
      throw new Error("gapi.authenticate is not a function. The QuickJS environment is not properly configured.");
    }
    
    // First authenticate with Google API
    console.log("Authenticating with Google API...");
    const authResult = await gapi.authenticate("admin.directory");
    
    console.log(`Authentication result: ${JSON.stringify(authResult)}`);
    
    // If authOnly is true, just return the auth result
    if (authOnly) {
      console.log("Auth only requested, returning auth result");
      const authOnlyResult = {
        success: true,
        authenticated: true,
        authResult
      };
      // Set the result in the global context for QuickJS to find
      result = authOnlyResult;
      return authOnlyResult;
    }
    
    // Check if gapi.admin is defined
    if (!gapi.admin) {
      console.error("gapi.admin is undefined!");
      throw new Error("gapi.admin is undefined. The QuickJS environment is not properly configured.");
    }
    
    // Check if gapi.admin.directory is defined
    if (!gapi.admin.directory) {
      console.error("gapi.admin.directory is undefined!");
      throw new Error("gapi.admin.directory is undefined. The QuickJS environment is not properly configured.");
    }
    
    // Check if gapi.admin.directory.domains is defined
    if (!gapi.admin.directory.domains) {
      console.error("gapi.admin.directory.domains is undefined!");
      throw new Error("gapi.admin.directory.domains is undefined. The QuickJS environment is not properly configured.");
    }
    
    // Check if gapi.admin.directory.domains.list is defined
    if (typeof gapi.admin.directory.domains.list !== 'function') {
      console.error("gapi.admin.directory.domains.list is not a function!");
      throw new Error("gapi.admin.directory.domains.list is not a function. The QuickJS environment is not properly configured.");
    }
    
    // List domains
    console.log(`Listing domains for customer: ${customerId || 'my_customer'}`);
    const domains = await gapi.admin.directory.domains.list({ 
      customer: customerId || 'my_customer' 
    });

    console.log(`Domains result: ${JSON.stringify(domains)}`);
    
    if (!domains || !domains.domains || !Array.isArray(domains.domains)) {
      console.error("Invalid domains result:", domains);
      throw new Error("Invalid domains result returned from Google API call");
    }
    
    console.log(`Found ${domains.domains.length} domains`);

    // Include usage statistics if requested
    const domainResult = {
      domains: domains.domains,
      customer: customerId || 'my_customer',
      timestamp: new Date().toISOString(),
      authInfo: {
        authenticated: true,
        scope: "admin.directory"
      }
    };

    if (includeStats) {
      console.log("Including usage statistics");
      domainResult.stats = {
        totalDomains: domains.domains.length,
        primaryDomains: domains.domains.filter(d => d.isPrimary).length,
        verifiedDomains: domains.domains.filter(d => d.verified).length
      };
    }
    
    console.log("Task completed successfully");
    console.log("Result:", JSON.stringify(domainResult));
    
    // Set the result in the global context for QuickJS to find
    result = domainResult;
    return domainResult;
    
  } catch (error) {
    console.error(`Error in gapi-list-domains task: ${error.message}`);
    console.error(`Error stack: ${error.stack}`);
    const errorResult = {
      success: false, 
      error: `Failed to list domains: ${error.message}`,
      stack: error.stack
    };
    // Set the error result in the global context
    result = errorResult;
    throw new Error(`Failed to list domains: ${error.message}`);
  }
}; 