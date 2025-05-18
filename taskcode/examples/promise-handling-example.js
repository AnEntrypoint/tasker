/**
 * Example of Proper Promise Handling in QuickJS
 * 
 * This example demonstrates how to properly use async/await with promises in QuickJS.
 * 
 * @module promise-handling-example
 */

/**
 * A simple function that returns a promise that resolves after a delay
 * @param {number} ms - Milliseconds to delay
 * @param {string} value - Value to return
 * @returns {Promise<string>} - Promise that resolves with the value after the delay
 */
async function delay(ms, value) {
  console.log(`Delaying for ${ms}ms before returning '${value}'`);
  return new Promise(resolve => {
    setTimeout(() => {
      console.log(`Delay of ${ms}ms complete, resolving with '${value}'`);
      resolve(value);
    }, ms);
  });
}

/**
 * Example function that demonstrates sequential promise resolution
 * @returns {Promise<string[]>} Array of results in order
 */
async function sequentialPromises() {
  console.log("Starting sequential promises");
  
  // In QuickJS, we need to properly await each promise
  const result1 = await delay(100, "first");
  console.log(`Got result1: ${result1}`);
  
  const result2 = await delay(200, "second");
  console.log(`Got result2: ${result2}`);
  
  const result3 = await delay(300, "third");
  console.log(`Got result3: ${result3}`);
  
  // Return all results as an array
  return [result1, result2, result3];
}

/**
 * Example function that demonstrates parallel promise resolution
 * @returns {Promise<string[]>} Array of results in completion order
 */
async function parallelPromises() {
  console.log("Starting parallel promises");
  
  // Create multiple promises that will run concurrently
  const promise1 = delay(300, "fast");
  const promise2 = delay(200, "faster");
  const promise3 = delay(100, "fastest");
  
  // Wait for all promises to resolve
  const results = await Promise.all([promise1, promise2, promise3]);
  console.log("All parallel promises resolved:", results);
  
  return results;
}

/**
 * Example function that demonstrates error handling with promises
 * @returns {Promise<string>} Result of error handling
 */
async function errorHandlingPromises() {
  console.log("Starting error handling example");
  
  try {
    // This promise will reject
    const result = await new Promise((_, reject) => {
      setTimeout(() => reject(new Error("This promise failed")), 100);
    });
    
    // This code won't execute because the promise rejected
    console.log("This won't execute");
    return result;
  } catch (error) {
    console.error(`Caught error: ${error.message}`);
    return "Error was handled";
  }
}

/**
 * Example function that demonstrates promise chaining
 * @returns {Promise<string>} Final result after chaining
 */
async function chainedPromises() {
  console.log("Starting promise chaining example");
  
  // Create a chain of promises that each transform the result
  const result = await delay(100, "initial value")
    .then(value => {
      console.log(`Transforming '${value}' → 'transformed'`);
      return "transformed";
    })
    .then(value => {
      console.log(`Appending to '${value}' → '${value} again'`);
      return `${value} again`;
    })
    .then(value => {
      console.log(`Final transformation of '${value}'`);
      return `Final: ${value}`;
    });
  
  console.log(`Chained promise result: ${result}`);
  return result;
}

/**
 * Main task function that demonstrates different promise patterns
 * @param {Object} input - Input parameters
 * @param {string} input.pattern - Promise pattern to demonstrate ('sequential', 'parallel', 'error', 'chained')
 * @returns {Promise<Object>} Result of the selected pattern
 */
async function runTask(input = {}, tools) {
  console.log("Promise handling example task started");
  
  // Default to sequential if not specified
  const pattern = input.pattern || 'sequential';
  
  let result;
  
  // Run the selected pattern
  switch (pattern) {
    case 'sequential':
      result = await sequentialPromises();
      break;
    case 'parallel':
      result = await parallelPromises();
      break;
    case 'error':
      result = await errorHandlingPromises();
      break;
    case 'chained':
      result = await chainedPromises();
      break;
    default:
      throw new Error(`Unknown pattern: ${pattern}`);
  }
  
  // Make an API call using the tools interface
  if (tools.supabase) {
    try {
      console.log("Making a Supabase API call...");
      // This demonstrates proper handling of promises from external APIs
      const apiResult = await tools.supabase.from('test_table').select('*').limit(1);
      console.log("API call successful:", apiResult);
    } catch (error) {
      console.error("API call failed:", error.message);
    }
  }
  
  // Return the result
  return {
    pattern,
    description: `Example of ${pattern} promise pattern`,
    result,
    completedAt: new Date().toISOString()
  };
}

// Export the task function
module.exports = {
  runTask
}; 