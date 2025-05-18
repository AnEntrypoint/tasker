/**
 * @task gapi-list-domains-with-nested
 * @description List all domains for a G Suite/Google Workspace account using Google Admin SDK with nested task call example
 * @param {object} input - Input parameters
 * @param {boolean} [input.includeStats] - Include usage statistics in the result
 * @param {string} [input.customer] - Customer ID (default: "my_customer")
 * @returns {Object} Domain information with optional nested task results
 */
module.exports = async function execute(input, context) {
  console.log("Starting gapi-list-domains-with-nested task");
  console.log(`Got input: ${JSON.stringify(input)}`);
  
  try {
    // Validate input parameters
    const customerId = input.customer || "my_customer";
    const includeStats = input.includeStats || false;
    
    // Authenticate with Google API (this is for testing the nested call functionality)
    console.log("Got gapi from context.tools");
    console.log("Authenticating with Google Admin SDK...");
    const authResult = await context.tools.gapi.authenticate("admin");
    
    console.log("Authentication complete");
    
    // Create hardcoded domain data instead of calling the real API
    const domains = [
      { 
        domainName: "example1.com", 
        verified: true, 
        isPrimary: true, 
        creationTime: new Date(Date.now() - 10000000000).toISOString() 
      },
      { 
        domainName: "example2.org", 
        verified: true, 
        isPrimary: false, 
        creationTime: new Date(Date.now() - 5000000000).toISOString() 
      },
      { 
        domainName: "test-example3.com", 
        verified: false, 
        isPrimary: false, 
        creationTime: new Date(Date.now() - 2000000000).toISOString() 
      },
      { 
        domainName: "dev-example4.net", 
        verified: false, 
        isPrimary: false, 
        creationTime: new Date(Date.now() - 1000000000).toISOString() 
      }
    ];
    
    console.log(`Created ${domains.length} hardcoded domains`);
    
    // Simulate domainsResult similar to what the API would return
    const domainsResult = {
      domains: domains,
      etag: "fake-etag-" + Date.now()
    };
    
    // Gather additional stats if requested through a nested task call
    let statsResult = null;
    if (includeStats) {
      console.log("Including stats by calling module-diagnostic task...");
      statsResult = await context.tools.tasks.execute("module-diagnostic", {
        checkGlobalScope: true,
        checkToolsAvailability: true
      });
      
      console.log("Received stats from nested task");
    }
    
    // Build the final response
    const result = {
      domains: domainsResult.domains || [],
      count: domainsResult.domains.length || 0,
      primaryDomain: domainsResult.domains.find(d => d.isPrimary)?.domainName,
      authenticated: true,
      customerId: customerId,
      timestamp: new Date().toISOString(),
      stats: statsResult
    };
    
    console.log(`Returning result with ${result.count} domains`);
    return result;
  } catch (error) {
    console.error(`Error in gapi-list-domains-with-nested task: ${error.message || String(error)}`);
    throw new Error(`Failed to list domains: ${error.message || String(error)}`);
  }
} 