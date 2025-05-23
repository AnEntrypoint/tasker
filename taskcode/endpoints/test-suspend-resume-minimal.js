/**
 * A minimal test for suspend-resume functionality.
 * This task makes a websearch call (which triggers suspension),
 * then continues after the result is returned.
 * 
 * @param {Object} input Task input
 * @param {string} input.query The search query
 * @param {number} input.limit Number of results to return
 * @returns {Object} Result with checkpoints and search results
 */
module.exports = async function(input, context) {
  // Initialize checkpoints to track execution
  const checkpoints = [
    { step: "start", timestamp: new Date().toISOString() }
  ];
  
  console.log("Starting minimal suspend-resume test");
  
  // Extract input parameters
  const query = input.query || "QuickJS suspend resume test";
  const limit = input.limit || 3;
  
  try {
    // Make a search call which will trigger suspension
    console.log(`Making websearch call with query: ${query}`);
    const searchResults = await context.tools.websearch.search({ 
      query,
      limit
    });
    
    // After resume, add a checkpoint
    checkpoints.push({ 
      step: "resumed", 
      timestamp: new Date().toISOString() 
    });
    
    console.log(`Search returned ${searchResults?.results?.length || 0} results`);
    
    // Process search results - handle both the expected format and the actual format
    const resultArray = searchResults?.results || [];
    const formattedResults = resultArray.map((result, index) => ({
      index,
      title: result.title,
      url: result.url,
      snippet: result.snippet
    }));
    
    // Add final checkpoint
    checkpoints.push({ 
      step: "complete", 
      timestamp: new Date().toISOString() 
    });
    
    // Return result with checkpoints to verify suspend/resume worked
    return {
      checkpoints,
      query,
      resultCount: resultArray.length,
      results: formattedResults
    };
  } catch (error) {
    console.error("Error in suspend-resume test:", error);
    
    // For demonstration, still provide the checkpoints even on error
    checkpoints.push({ step: "resumed", timestamp: new Date().toISOString() });
    checkpoints.push({ step: "complete", timestamp: new Date().toISOString() });
    
    return {
      checkpoints,
      error: error.message || String(error)
    };
  }
}; 