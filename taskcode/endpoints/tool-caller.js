/**
 * @task tool-caller
 * @description Calls a tool and returns the result
 * @param {object} input - The input object
 * @param {string} input.searchQuery - The search query to use
 * @returns {Promise<object>} - The result from the tool
 * @throws {Error} If the tool execution fails
 */
module.exports = async function execute(input, { tools }) {
  console.log('[tool-caller] Starting with input:', JSON.stringify(input));
  
  if (!input || typeof input.searchQuery !== 'string') {
    throw new Error("Input must be an object with a 'searchQuery' property of type string.");
  }
  
  if (!tools || !tools.websearch) {
    throw new Error("The 'tools.websearch' object is not available in the environment.");
  }
  
  try {
    console.log(`[tool-caller] Searching for: ${input.searchQuery}`);
    
    // Call the websearch tool
    const searchResults = await tools.websearch.search(input.searchQuery, 3);
    
    console.log(`[tool-caller] Search completed with ${searchResults.length} results`);
    
    return {
      query: input.searchQuery,
      results: searchResults
    };
  } catch (error) {
    console.error(`[tool-caller] Error calling websearch tool: ${error.message}`);
    throw new Error(`Failed to execute websearch tool: ${error.message}`);
  }
}
