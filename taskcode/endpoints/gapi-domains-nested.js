/**
 * @task gapi-domains-nested
 * @description Lists Google Workspace domains using the proper nested method for GAPI calls
 * @param {object} input - Input parameters
 * @param {boolean} [input.verbose=false] - Enable verbose logging
 * @param {number} [input.maxResults=10] - Maximum number of results to return
 * @returns {Object} List of domains and execution metadata
 */
module.exports = async function execute(input, context) {
  console.log("Starting gapi-domains-nested task with proper suspend/resume method");
  console.log(`Got input: ${JSON.stringify(input || {})}`);
  
  // Make sure input is properly initialized
  input = input || {};
  
  const startTime = Date.now();
  const verbose = input.verbose === true;
  const maxResults = input.maxResults || 10;
  
  try {
    // Create a timestamp for task start
    const taskStarted = new Date().toISOString();
    
    // Create checkpoints to track execution flow
    const checkpoints = [
      { step: "initialization", timestamp: new Date().toISOString() }
    ];
    
    // Verify context is available
    if (!context) {
      throw new Error("Context not provided to task");
    }
    
    // Verify tools are available
    if (!context.tools) {
      throw new Error("Context.tools not available");
    }
    
    // Verify required tools exist
    const requiredTools = ['keystore', 'gapi'];
    for (const tool of requiredTools) {
      if (!context.tools[tool]) {
        throw new Error(`Required tool not available: ${tool}`);
      }
    }
    
    // Step 1: Get credentials from keystore (this will suspend/resume)
    console.log("Step 1: Retrieving GAPI admin email from keystore...");
    
    try {
      const adminEmail = await context.tools.keystore.getKey("global", "GAPI_ADMIN_EMAIL");
      
      // This code will only run after keystore call is complete
      checkpoints.push({ 
        step: "credentials-retrieved", 
        timestamp: new Date().toISOString(),
        adminEmail: adminEmail
      });
      
      console.log(`Retrieved admin email: ${adminEmail}`);
      
      if (!adminEmail) {
        throw new Error("Failed to retrieve required admin email from keystore");
      }
      
      // Step 2: Authenticate with Google API (this will suspend/resume)
      console.log("Step 2: Authenticating with Google API...");
      try {
        // Update the code to just directly call admin.domains.list
        // This will skip the authenticate step since it's handled internally by the wrapper
        
        // Step 3: Call GAPI to list domains (this will suspend/resume)
        console.log(`Step 3: Listing domains (max: ${maxResults})...`);
        
        try {
          // This will suspend VM execution until the call completes
          const domainsResult = await context.tools.gapi.admin.domains.list({
            customer: "my_customer",
            maxResults: maxResults
          });
          
          // Add more detailed debugging
          console.log("GAPI Response Type:", typeof domainsResult);
          console.log("GAPI Response Keys:", Object.keys(domainsResult || {}));
          console.log("GAPI Response JSON:", JSON.stringify(domainsResult, null, 2));
          
          if (domainsResult && typeof domainsResult === 'object') {
            // Google API typically uses 'items' for list results
            if (Array.isArray(domainsResult.items)) {
              console.log("Found domains in 'items' array:", domainsResult.items.length);
              // Normalize the response to use 'domains' property
              domainsResult.domains = domainsResult.items;
            } else if (Array.isArray(domainsResult.domains)) {
              console.log("Found domains in 'domains' array:", domainsResult.domains.length);
            } else {
              console.log("No domains array found in response");
            }
          }
          
          // This code will only run after domains list call completes
          checkpoints.push({ 
            step: "domains-listed", 
            timestamp: new Date().toISOString(),
            domainsCount: domainsResult?.domains?.length || domainsResult?.items?.length || 0
          });
          
          console.log(`Found ${domainsResult?.domains?.length || 0} domains`);
          console.log("Raw domains result:", JSON.stringify(domainsResult));
          
          // Continue with resumed execution
          console.log("Task execution resuming after GAPI call");
          checkpoints.push({ step: "completion", timestamp: new Date().toISOString() });
          
          console.log("Task complete");
          
          // Prepare the final result
          const taskFinished = new Date().toISOString();
          const executionTime = Date.now() - startTime;
          
          // Normalize domains data - the API may use either 'domains' or 'items'
          const domains = domainsResult?.domains || domainsResult?.items || [];
          
          const result = {
            success: true,
            message: "Domains retrieved successfully",
            checkpoints: checkpoints,
            domains: domains,
            rawResponse: domainsResult,
            metadata: {
              taskStarted,
              taskFinished,
              executionTimeMs: executionTime,
              adminEmail,
              responseType: typeof domainsResult,
              responseKeys: Object.keys(domainsResult || {})
            }
          };
          
          console.log(`RETURNING RESULT: ${JSON.stringify(result)}`);
          return result;
        } catch (domainsError) {
          console.error(`Error listing domains: ${domainsError.message || String(domainsError)}`);
          throw new Error(`Failed to list domains: ${domainsError.message || String(domainsError)}`);
        }
      } catch (authError) {
        console.error(`Authentication error: ${authError.message || String(authError)}`);
        throw new Error(`Failed to authenticate with Google API: ${authError.message || String(authError)}`);
      }
    } catch (keystoreError) {
      console.error(`Keystore error: ${keystoreError.message || String(keystoreError)}`);
      throw new Error(`Failed to retrieve credentials from keystore: ${keystoreError.message || String(keystoreError)}`);
    }
  } catch (error) {
    console.error(`Error in gapi-domains-nested task: ${error.message || String(error)}`);
    const errorResult = {
      success: false,
      error: `Task execution failed: ${error.message || String(error)}`,
      metadata: {
        taskStarted: new Date().toISOString(),
        taskFinished: new Date().toISOString(),
        executionTimeMs: Date.now() - startTime
      }
    };
    console.log(`RETURNING ERROR: ${JSON.stringify(errorResult)}`);
    return errorResult;
  }
} 