/**
 * @task gapi-domains-custom
 * @description Lists Google Workspace domains with a workaround for the suspend/resume mechanism
 * @param {object} input - Input parameters
 * @param {boolean} [input.verbose=false] - Enable verbose logging
 * @param {number} [input.maxResults=10] - Maximum number of results to return
 * @returns {Object} List of domains and execution metadata
 */
module.exports = async function execute(input, context) {
  console.log("Starting gapi-domains-custom task");
  console.log(`Got input: ${JSON.stringify(input || {})}`);
  console.log(`Context provided: ${context ? 'yes' : 'no'}`);
  console.log(`Context.tools available: ${context && context.tools ? 'yes' : 'no'}`);
  
  // Make sure input is properly initialized
  input = input || {};
  
  const startTime = Date.now();
  const verbose = input.verbose === true;
  const maxResults = input.maxResults || 10;
  
  try {
    if (verbose) console.log("Phase 1: Task initialization");
    
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
    const requiredTools = ['keystore'];
    for (const tool of requiredTools) {
      if (!context.tools[tool]) {
        throw new Error(`Required tool not available: ${tool}`);
      }
    }
    
    // Step 1: Get admin email from keystore (this will suspend/resume)
    console.log("Step 1: Retrieving GAPI admin email from keystore...");
    
    try {
      // This will suspend VM execution
      const adminEmail = await context.tools.keystore.getKey("global", "GAPI_ADMIN_EMAIL");
      
      checkpoints.push({ 
        step: "credentials-retrieved", 
        timestamp: new Date().toISOString(),
        adminEmail: adminEmail
      });
      
      console.log(`Retrieved admin email: ${adminEmail}`);
      
      if (!adminEmail) {
        throw new Error("Failed to retrieve admin email from keystore");
      }
      
      // Step 2: Make a direct call to the wrappedgapi endpoint using fetch
      // This is a workaround for the stack processor's limitations
      console.log("Step 2: Calling wrappedgapi endpoint directly to list domains...");
      
      try {
        // This call doesn't use the suspend/resume mechanism
        // Instead, it makes a direct HTTP request to the wrappedgapi endpoint
        // This mimics what test-direct-gapi-domains.ts does, but within the task
        
        // Get anon key and service role key from keystore for authorization
        console.log("Retrieving SUPABASE_ANON_KEY from keystore...");
        const anonKey = await context.tools.keystore.getKey("global", "SUPABASE_ANON_KEY");
        console.log(`Retrieved SUPABASE_ANON_KEY: ${anonKey ? "Present (masked)" : "Not found"}`);
        
        console.log("Retrieving SUPABASE_SERVICE_ROLE_KEY from keystore...");
        const serviceRoleKey = await context.tools.keystore.getKey("global", "SUPABASE_SERVICE_ROLE_KEY");
        console.log(`Retrieved SUPABASE_SERVICE_ROLE_KEY: ${serviceRoleKey ? "Present (masked)" : "Not found"}`);
        
        // Get SUPABASE_URL from environment
        const supabaseUrl = Deno?.env?.get("SUPABASE_URL") || "http://kong:8000";
        console.log(`Using SUPABASE_URL: ${supabaseUrl}`);
        
        const url = `${supabaseUrl}/functions/v1/wrappedgapi`;
        console.log(`Making direct request to: ${url}`);
        
        // Prepare request headers with authorization
        const headers = {
          "Content-Type": "application/json"
        };
        
        if (serviceRoleKey) {
          headers["Authorization"] = `Bearer ${serviceRoleKey}`;
        }
        
        if (anonKey) {
          headers["apikey"] = anonKey;
        }
        
        console.log(`Request headers: ${JSON.stringify(Object.keys(headers))}`);
        
        // Prepare request body
        const requestBody = {
          chain: [
            { type: "get", property: "admin" },
            { type: "get", property: "domains" },
            { type: "call", property: "list", args: [{ customer: "my_customer", maxResults: maxResults }] }
          ]
        };
        
        console.log(`Request body: ${JSON.stringify(requestBody)}`);
        
        // Make the request with extra error handling
        try {
          console.log("Sending request to wrappedgapi...");
          const response = await fetch(url, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(requestBody)
          });
          
          console.log(`Response status: ${response.status}`);
          console.log(`Response status text: ${response.statusText}`);
          
          checkpoints.push({ 
            step: "api-call-completed", 
            timestamp: new Date().toISOString(),
            status: response.status
          });
          
          if (!response.ok) {
            const errorText = await response.text();
            console.error(`GAPI domains list failed with status ${response.status}: ${errorText}`);
            throw new Error(`GAPI domains list failed with status ${response.status}: ${errorText}`);
          }
          
          console.log("Response OK, parsing JSON...");
          
          // Parse the response
          let domainsResult;
          try {
            domainsResult = await response.json();
            console.log(`Response parsed successfully: ${JSON.stringify(domainsResult)}`);
          } catch (jsonError) {
            console.error(`Error parsing JSON response: ${jsonError.message}`);
            const rawText = await response.text();
            console.log(`Raw response text: ${rawText}`);
            throw new Error(`Failed to parse response as JSON: ${jsonError.message}`);
          }
          
          checkpoints.push({ 
            step: "domains-listed", 
            timestamp: new Date().toISOString(),
            domainsCount: domainsResult?.domains?.length || 0
          });
          
          console.log(`Found ${domainsResult?.domains?.length || 0} domains`);
          
          // Continue with resumed execution
          console.log("Task execution continuing after GAPI call");
          checkpoints.push({ step: "completion", timestamp: new Date().toISOString() });
          
          console.log("Task complete");
          
          // Prepare the final result
          const taskFinished = new Date().toISOString();
          const executionTime = Date.now() - startTime;
          
          const result = {
            success: true,
            message: "Domains retrieved successfully",
            checkpoints: checkpoints,
            domains: domainsResult?.domains || [],
            metadata: {
              taskStarted,
              taskFinished,
              executionTimeMs: executionTime,
              adminEmail
            }
          };
          
          console.log(`RETURNING RESULT: ${JSON.stringify(result)}`);
          return result;
        } catch (fetchError) {
          console.error(`Fetch error: ${fetchError.message}`);
          throw new Error(`Fetch error: ${fetchError.message}`);
        }
      } catch (domainsError) {
        console.error(`Error listing domains: ${domainsError.message || String(domainsError)}`);
        throw new Error(`Failed to list domains: ${domainsError.message || String(domainsError)}`);
      }
    } catch (keystoreError) {
      console.error(`Keystore error: ${keystoreError.message || String(keystoreError)}`);
      throw new Error(`Failed to retrieve credentials from keystore: ${keystoreError.message || String(keystoreError)}`);
    }
  } catch (error) {
    console.error(`Error in gapi-domains-custom task: ${error.message || String(error)}`);
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