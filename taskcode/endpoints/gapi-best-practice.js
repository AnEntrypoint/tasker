/**
 * @task gapi-best-practice
 * @description Demonstrates the best practice approach for GAPI integration
 * @param {object} input - Input parameters
 * @param {string} [input.customer="my_customer"] - Customer ID
 * @param {string} [input.email] - Optional user email to search Gmail
 * @param {string} [input.query] - Optional Gmail search query
 * @returns {Object} Combined results from different GAPI services
 */
module.exports = async function execute(input, context) {
  console.log("Starting gapi-best-practice task");
  console.log("Input:", JSON.stringify(input || {}));
  console.log("Context:", context ? "provided" : "missing");
  
  try {
    // Initialize result object
    const result = {
      success: true,
      timestamp: new Date().toISOString(),
      services: {}
    };
    
    // Get customer ID from input or use default
    const customer = input?.customer || "my_customer";
    
    // 1. List domains
    console.log("Calling domains.list API with customer:", customer);
    try {
      // Use direct __callHostTool__ approach since context.tasks.require is not working properly
      console.log("Using direct __callHostTool__ for GAPI call");
      
      if (typeof __callHostTool__ !== "function") {
        throw new Error("__callHostTool__ function is not available");
      }
      
      // Make the call with explicit await to ensure we wait for the result
      console.log("Making GAPI call now, will await result");
      const domainsResult = await __callHostTool__(
        "gapi", 
        ["admin", "domains", "list"], 
        [{ customer }]
      );
      
      console.log("GAPI domains.list call completed successfully");
      console.log("Result type:", typeof domainsResult);
      console.log("Result is array:", Array.isArray(domainsResult));
      console.log("Result is null:", domainsResult === null);
      console.log("Result keys:", domainsResult ? Object.keys(domainsResult || {}).join(", ") : "no keys");
      
      // Explicitly check for domains property
      if (!domainsResult || !domainsResult.domains) {
        console.error("Expected domains property is missing from result");
        result.services.domains = {
          success: false,
          error: "Invalid GAPI response: missing domains property",
          rawResult: domainsResult
        };
      } else {
        const domains = domainsResult.domains || [];
        console.log(`Found ${domains.length} domains`);
        
        // List first few domains for verification
        if (domains.length > 0) {
          domains.slice(0, 3).forEach((domain, i) => {
            console.log(`Domain ${i+1}: ${domain.domainName} (verified: ${domain.verified})`);
          });
        }
        
        // Add domains to result
        result.services.domains = {
          success: true,
          count: domains.length,
          domains: domains.map(domain => ({
            name: domain.domainName,
            isPrimary: !!domain.isPrimary,
            verified: !!domain.verified
          }))
        };
      }
    } catch (error) {
      console.error("Error listing domains:", error.message);
      console.error("Error stack:", error.stack);
      result.services.domains = {
        success: false,
        error: error.message
      };
    }
    
    // 2. List Gmail messages if email provided
    if (input?.email) {
      console.log(`Searching Gmail for user ${input.email}...`);
      try {
        const query = input?.query || "";
        const gmailResult = await __callHostTool__(
          "gapi",
          ["gmail", "users", "messages", "list"],
          [{
            userId: input.email,
            q: query,
            maxResults: 10
          }]
        );
        
        if (!gmailResult || !gmailResult.messages) {
          console.error("Expected messages property is missing from Gmail result");
          result.services.gmail = {
            success: false,
            error: "Invalid GAPI response: missing messages property",
            rawResult: gmailResult
          };
        } else {
          const messages = gmailResult.messages || [];
          console.log(`Found ${messages.length} Gmail messages`);
          
          result.services.gmail = {
            success: true,
            count: messages.length,
            query: query,
            messages: messages
          };
        }
      } catch (error) {
        console.error("Error searching Gmail:", error.message);
        console.error("Error stack:", error.stack);
        result.services.gmail = {
          success: false,
          error: error.message
        };
      }
    }
    
    console.log("Task execution completed successfully");
    console.log("Final result:", JSON.stringify(result));
    return result;
  } catch (error) {
    console.error("Error in gapi-best-practice task:", error.message);
    console.error("Stack:", error.stack);
    
    return {
      success: false,
      timestamp: new Date().toISOString(),
      error: error.message
    };
  }
}; 