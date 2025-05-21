/**
 * @task gapi-domains-sleep-resume
 * @description Test the ephemeral call queueing system with Google Admin SDK domain listing
 * @param {object} input - Input parameters
 * @param {boolean} [input.verbose=false] - Enable verbose logging
 * @param {string} [input.customer] - Customer ID (defaults to 'my_customer')
 * @returns {Object} Domain information and execution metadata
 */
module.exports = async function execute(input, context) {
  console.log("Starting gapi-domains-sleep-resume task");
  console.log(`Got input: ${JSON.stringify(input)}`);
  
  const startTime = Date.now();
  const verbose = input.verbose === true;
  
  try {
    if (verbose) console.log("Phase 1: Task initialization");
    
    // Validate input parameters
    const customerId = input.customer || 'my_customer';
    console.log(`Using customer ID: ${customerId}`);
    
    // Save starting timestamp
    const taskStarted = new Date().toISOString();
    
    // Get admin email from keystore - this should trigger a save/sleep/resume cycle
    if (verbose) console.log("Phase 2: Calling keystore to get GAPI admin email");
    console.log("Retrieving admin email from keystore...");
    
    const adminEmail = await context.tools.keystore.getKey("global", "GAPI_ADMIN_EMAIL");
    console.log(`Retrieved admin email from keystore: ${adminEmail}`);
    
    // This should trigger another save/sleep/resume cycle
    if (verbose) console.log("Phase 3: Calling GAPI Admin SDK domains.list");
    console.log("Calling Google Admin SDK to list domains...");
    
    // Use the SDK wrapped calls
    const domainsResult = await context.tools.gapi.admin.directory.domains.list({
      customer: customerId
    });
    
    const domains = domainsResult.domains || [];
    console.log(`Found ${domains.length} domains`);
    
    if (verbose) {
      domains.forEach((domain, index) => {
        console.log(`Domain ${index + 1}: ${domain.domainName} (${domain.verified ? 'verified' : 'unverified'})`);
      });
    }
    
    // Build the final response
    const taskFinished = new Date().toISOString();
    const executionTime = Date.now() - startTime;
    
    return {
      success: true,
      domains: domains,
      count: domains.length,
      primaryDomain: domains.find(d => d.isPrimary)?.domainName,
      metadata: {
        taskStarted,
        taskFinished,
        executionTimeMs: executionTime,
        customerId,
        adminEmail
      }
    };
  } catch (error) {
    console.error(`Error in gapi-domains-sleep-resume task: ${error.message || String(error)}`);
    return {
      success: false,
      error: `Failed to list domains: ${error.message || String(error)}`,
      metadata: {
        taskStarted: new Date().toISOString(),
        taskFinished: new Date().toISOString(),
        executionTimeMs: Date.now() - startTime
      }
    };
  }
} 