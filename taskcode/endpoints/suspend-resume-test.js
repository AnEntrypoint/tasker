/**
 * @task suspend-resume-test
 * @description A simplified test task that doesn't use suspend/resume
 * @param {object} [input] - The input parameters
 * @param {boolean} [input.verbose=false] - Whether to log detailed information
 * @returns {object} Basic test result
 */
module.exports = function suspendResumeTest(input = {}) {
  // Extract parameters
  const verbose = input?.verbose || false;
  
  // Create a log function that respects verbose setting
  function log(message) {
    if (verbose) {
      console.log(message);
    }
  }
  
  log("Starting simplified test");
  
  // Just return a basic result without any async operations
  return {
    success: true,
    message: "Simplified test executed successfully",
    timestamp: new Date().toISOString()
  };
}; 