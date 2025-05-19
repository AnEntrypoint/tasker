/**
 * @task test-ephemeral
 * @description A simple test task to debug ephemeral execution with nested calls
 * @param {object} input - Input parameters
 * @param {boolean} [input.failStep1] - Whether to fail the first step
 * @param {boolean} [input.failStep2] - Whether to fail the second step
 * @param {boolean} [input.nested] - Whether this is a nested call
 * @param {number} [input.level=0] - The nesting level (for recursive testing)
 * @returns {object} Results from both steps
 */
module.exports = async function execute(input, context) {
  console.log("Starting test-ephemeral task");
  console.log(`Input: ${JSON.stringify(input)}`);
  
  // Initialize level if not provided
  const level = input.level || 0;
  const isNested = input.nested || false;
  
  // Check if we need to make a nested call
  if (!isNested && level < 2) {
    console.log(`Making nested call at level ${level}`);
    
    try {
      // Make a nested call to test-ephemeral
      const nestedResult = await context.tools.tasks.execute("test-ephemeral", {
        nested: true,
        level: level + 1,
        message: `This is a nested call from level ${level}`
      });
      
      console.log(`Nested call completed with result: ${JSON.stringify(nestedResult)}`);
      
      // Return the results of both steps
      return {
        mainTask: {
          level,
          message: input.message || "Hello from main task!",
          timestamp: new Date().toISOString()
        },
        nestedTask: nestedResult
      };
    } catch (error) {
      console.log(`Error in nested call: ${error.message}`);
      return {
        error: true,
        message: `Failed to execute nested call: ${error.message}`,
        level,
        timestamp: new Date().toISOString()
      };
    }
  } else {
    // This is either a nested call or we've reached the maximum nesting level
    return {
      success: true,
      nested: isNested,
      level,
      message: input.message || "Test completed successfully",
      timestamp: new Date().toISOString()
    };
  }
} 