/**
 * A test task that demonstrates the ephemeral call mechanism with sleep operations
 * @param {Object} input - The input parameters
 * @param {number} input.sleepTime - Sleep time in milliseconds
 * @param {number} input.depth - How many levels of nested calls to make
 * @returns {Object} Results with timing information
 */
export default async function sleepTest(input) {
  const startTime = new Date();
  console.log(`Starting sleep test with sleepTime=${input.sleepTime}ms, depth=${input.depth}`);
  
  // Record the start time
  const result = {
    startTime: startTime.toISOString(),
    depth: input.depth,
    sleepTime: input.sleepTime
  };
  
  // Sleep for the specified time
  if (input.sleepTime > 0) {
    console.log(`Sleeping for ${input.sleepTime}ms`);
    await tools.sleep(input.sleepTime);
    console.log('Woke up from sleep');
  }
  
  // Make a nested call if depth > 0
  if (input.depth > 0) {
    console.log(`Making nested call at depth ${input.depth}`);
    
    try {
      // This should be intercepted by the ephemeral call mechanism
      const nestedResult = await tools.tasks.execute("sleep-test", {
        sleepTime: input.sleepTime,
        depth: input.depth - 1
      });
      
      console.log(`Received nested result: ${JSON.stringify(nestedResult)}`);
      
      // Add the nested result
      result.nestedResult = nestedResult;
    } catch (error) {
      console.error(`Error in nested call: ${error.message}`);
      result.nestedError = error.message;
    }
  }
  
  // Record completion time and duration
  const endTime = new Date();
  result.endTime = endTime.toISOString();
  result.durationMs = endTime - startTime;
  
  return result;
} 