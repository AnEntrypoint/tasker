/**
 * @module test-result-extraction
 * @description A test task to verify result extraction is working correctly
 */

/**
 * Returns a simple result object to test the QuickJS result extraction
 * @param {Object} input - Input parameters
 * @param {string} input.message - Optional message to include in result
 * @returns {Object} A result object with timestamp and input message
 */
async function testResultExtraction(input = {}) {
  console.log("Starting test-result-extraction task");
  
  // Create a simple result object
  const result = {
    message: input.message || "Hello from test-result-extraction!",
    timestamp: new Date().toISOString(),
    randomNumber: Math.floor(Math.random() * 1000),
    nested: {
      data: {
        works: true,
        values: [1, 2, 3, 4, 5]
      }
    }
  };
  
  console.log(`Generated result: ${JSON.stringify(result)}`);
  
  // Set global taskResult (should be picked up by the executor)
  globalThis.taskResult = result;
  
  // Also return the result directly (as a fallback)
  return result;
}

// Export the task function
module.exports = testResultExtraction; 