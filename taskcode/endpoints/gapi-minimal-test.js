/**
 * @task gapi-minimal-test
 * @description Diagnostic task to check GAPI integration in QuickJS environment
 * @param {object} input - Input parameters
 * @returns {Object} Diagnostic information
 */
module.exports = async function execute(input, context) {
  console.log("Starting gapi-minimal-test diagnostic task");
  
  // Collect environment information
  const diagnostics = {
    success: false,
    timestamp: new Date().toISOString(),
    environment: {},
    tools: {},
    gapi: {}
  };
  
  try {
    // Check if context exists
    if (!context) {
      console.error("Error: context is undefined");
      diagnostics.environment.contextAvailable = false;
      return {
        ...diagnostics,
        error: "context is undefined"
      };
    }
    
    diagnostics.environment.contextAvailable = true;
    
    // Check if tools object is properly initialized
    if (!context.tools) {
      console.error("Error: context.tools is undefined");
      diagnostics.environment.toolsAvailable = false;
      return {
        ...diagnostics,
        error: "context.tools is undefined"
      };
    }
    
    diagnostics.environment.toolsAvailable = true;
    diagnostics.tools.availableTools = Object.keys(context.tools);
    
    // Check if console works
    try {
      console.log("Console logging works");
      diagnostics.environment.consoleWorks = true;
    } catch (e) {
      diagnostics.environment.consoleWorks = false;
      diagnostics.environment.consoleError = e.message;
    }
    
    // Check which services are available in tools
    Object.keys(context.tools).forEach(tool => {
      try {
        diagnostics.tools[tool] = {
          type: typeof context.tools[tool],
          properties: context.tools[tool] ? Object.keys(context.tools[tool]) : []
        };
      } catch (e) {
        diagnostics.tools[tool] = {
          type: typeof context.tools[tool],
          error: e.message
        };
      }
    });
    
    // Specifically check gapi
    if (context.tools.gapi) {
      diagnostics.gapi.available = true;
      diagnostics.gapi.type = typeof context.tools.gapi;
      
      try {
        diagnostics.gapi.properties = Object.keys(context.tools.gapi);
      } catch (e) {
        diagnostics.gapi.propertiesError = e.message;
      }
      
      // Check if gapi.admin exists
      if (context.tools.gapi.admin) {
        diagnostics.gapi.admin = {
          available: true,
          type: typeof context.tools.gapi.admin
        };
        
        try {
          diagnostics.gapi.admin.properties = Object.keys(context.tools.gapi.admin);
        } catch (e) {
          diagnostics.gapi.admin.propertiesError = e.message;
        }
        
        // Check if gapi.admin.domains exists
        if (context.tools.gapi.admin.domains) {
          diagnostics.gapi.admin.domains = {
            available: true,
            type: typeof context.tools.gapi.admin.domains
          };
          
          try {
            diagnostics.gapi.admin.domains.properties = Object.keys(context.tools.gapi.admin.domains);
            diagnostics.gapi.admin.domains.listType = typeof context.tools.gapi.admin.domains.list;
          } catch (e) {
            diagnostics.gapi.admin.domains.propertiesError = e.message;
          }
          
          // Try to call the domains.list method
          try {
            console.log("Attempting to call gapi.admin.domains.list...");
            diagnostics.gapi.admin.domains.callInitiated = true;
            const result = await context.tools.gapi.admin.domains.list({
              customer: "my_customer"
            });
            
            console.log("Call succeeded, result type:", typeof result);
            diagnostics.gapi.admin.domains.callSucceeded = true;
            diagnostics.gapi.admin.domains.result = {
              type: typeof result,
              keys: result ? Object.keys(result) : [],
              domainsPresent: result && result.domains ? true : false,
              domainsCount: result && result.domains ? result.domains.length : 0,
              itemsPresent: result && result.items ? true : false,
              itemsCount: result && result.items ? result.items.length : 0
            };
            
            if (result && result.domains && result.domains.length > 0) {
              diagnostics.gapi.admin.domains.firstDomain = result.domains[0];
            } else if (result && result.items && result.items.length > 0) {
              diagnostics.gapi.admin.domains.firstItem = result.items[0];
            }
            
            // Success!
            diagnostics.success = true;
          } catch (e) {
            console.error("Error calling domains.list:", e.message);
            diagnostics.gapi.admin.domains.callFailed = true;
            diagnostics.gapi.admin.domains.callError = e.message;
            diagnostics.gapi.admin.domains.callErrorStack = e.stack;
          }
        } else {
          diagnostics.gapi.admin.domains = {
            available: false
          };
        }
      } else {
        diagnostics.gapi.admin = {
          available: false
        };
      }
    } else {
      diagnostics.gapi.available = false;
    }
    
    return diagnostics;
  } catch (error) {
    console.error("Unhandled error:", error.message || String(error));
    console.error("Error stack:", error.stack || "No stack available");
    
    return {
      ...diagnostics,
      success: false,
      error: error.message || String(error),
      stack: error.stack
    };
  }
} 