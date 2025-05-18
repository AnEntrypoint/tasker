/**
 * @task child-task
 * @description A child task that is called by a parent task
 * @param {object} input - The input object
 * @param {string} input.message - The message to echo
 * @returns {Promise<object>} - The result
 */
module.exports = async function execute(input, { tools }) {
  console.log('[child-task] Starting with input:', JSON.stringify(input));
  
  if (!input || typeof input.message !== 'string') {
    throw new Error("Input must be an object with a 'message' property of type string.");
  }
  
  const message = input.message;
  console.log(`[child-task] Message: ${message}`);
  
  try {
    // Process the message
    const processedMessage = message.toUpperCase();
    console.log(`[child-task] Processed message: ${processedMessage}`);
    
    return {
      originalMessage: message,
      processedMessage,
      childCompleted: true,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error(`[child-task] Error: ${error.message}`);
    throw new Error(`Failed to execute child task: ${error.message}`);
  }
}
