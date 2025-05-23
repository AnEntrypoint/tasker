/**
 * A basic task that just returns data without any external calls
 * 
 * @param {Object} input - The input parameters
 * @returns {Object} Simple result object
 */
module.exports = async function testBasicExecution(input = {}) {
  console.log("======= BASIC EXECUTION TEST =======");
  
  const result = {
    message: "Hello from basic execution!",
    timestamp: new Date().toISOString(),
    input: input,
    random: Math.random(),
    success: true
  };
  
  console.log("Result:", result);
  console.log("======= BASIC EXECUTION COMPLETED =======");
  
  return result;
}; 