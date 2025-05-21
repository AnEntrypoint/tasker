/**
 * A simple Hello World task that doesn't make nested calls
 * @param {Object} input - The input parameters
 * @param {string} input.name - Name to greet
 * @returns {Object} Greeting message
 */
export default async function helloWorld(input) {
  console.log(`Hello World task received input: ${JSON.stringify(input)}`);
  
  // Simulate some processing time
  await new Promise(resolve => setTimeout(resolve, 500));
  
  return {
    message: `Hello, ${input.name || 'World'}!`,
    timestamp: new Date().toISOString()
  };
} 