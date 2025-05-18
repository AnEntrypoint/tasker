/**
 * @task module-diagnostic
 * @description Diagnostic task to check QuickJS environment and module capabilities
 * @param {object} input - Input parameters
 * @param {boolean} [input.checkGlobalScope] - Check global scope objects
 * @param {boolean} [input.checkToolsAvailability] - Check tools availability
 * @returns {Object} Diagnostic information about the QuickJS environment
 */
module.exports = async function execute(input, context) {
  console.log("===== STARTING module-diagnostic task =====");
  console.log(`Input: ${JSON.stringify(input)}`);
  
  try {
    const result = {
      timestamp: new Date().toISOString(),
      taskName: "module-diagnostic",
      environment: "QuickJS",
      checks: {}
    };
    
    // Check global scope if requested
    if (input.checkGlobalScope) {
      console.log("Checking global scope...");
      const globalScope = {};
      
      // Check for common globals
      const globals = ["console", "module", "exports", "require", "Promise", "setTimeout", "tools"];
      globals.forEach(global => {
        globalScope[global] = typeof global !== "undefined";
      });
      
      // Check Promise capabilities
      globalScope.hasPromiseAll = typeof Promise.all === "function";
      globalScope.hasPromiseAllSettled = typeof Promise.allSettled === "function";
      
      // Check array methods
      globalScope.arrayMethods = {
        map: typeof Array.prototype.map === "function",
        filter: typeof Array.prototype.filter === "function", 
        reduce: typeof Array.prototype.reduce === "function",
        forEach: typeof Array.prototype.forEach === "function"
      };
      
      result.checks.globalScope = globalScope;
    }
    
    // Check tools availability if requested
    if (input.checkToolsAvailability) {
      console.log("Checking tools availability...");
      
      const toolsAvailability = {
        hasTools: typeof context.tools !== "undefined",
        availableTools: []
      };
      
      // Check if specific tools are available
      if (typeof context.tools !== "undefined") {
        // Safely check tools properties
        const checkTool = (toolName) => {
          try {
            const hasTool = typeof context.tools[toolName] !== "undefined";
            if (hasTool) {
              toolsAvailability.availableTools.push(toolName);
            }
            return hasTool;
          } catch (e) {
            console.warn(`Error checking tool ${toolName}: ${e.message}`);
            return false;
          }
        };
        
        // Check common tools
        ["tasks", "gapi", "openai", "websearch", "supabase", "keystore"].forEach(checkTool);
      }
      
      result.checks.toolsAvailability = toolsAvailability;
    }
    
    // Add VM memory usage estimates if available
    try {
      // This is a placeholder - in a real implementation we might
      // inject actual memory usage metrics into the VM context
      result.memoryUsage = {
        estimated: true,
        note: "Memory usage tracking not implemented in current QuickJS build"
      };
    } catch (e) {
      console.warn(`Error getting memory usage: ${e.message}`);
    }
    
    console.log("Module diagnostic completed successfully");
    return result;
  } catch (error) {
    console.error(`Error in module-diagnostic task: ${error.message || String(error)}`);
    throw new Error(`Module diagnostic failed: ${error.message || String(error)}`);
  }
} 