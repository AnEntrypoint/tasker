/**
 * @task simple-parent-child-test
 * @description A simple parent-child test that uses a simpler verification method
 * @param {object} input - The input object
 * @param {string} input.message - The message to echo
 * @returns {Promise<object>} - The result with verification
 */
module.exports = async function execute(input, { tools }) {
  console.log('[simple-parent-child-test] Starting with input:', JSON.stringify(input));
  
  if (!input || typeof input.message !== 'string') {
    throw new Error("Input must be an object with a 'message' property of type string.");
  }
  
  const message = input.message;
  console.log(`[simple-parent-child-test] Message: ${message}`);
  
  try {
    // Step 1: Call the echo-fixed task with the message
    console.log('[simple-parent-child-test] Calling echo-fixed task...');
    const echoResponse = await tools.tasks.execute('echo-fixed', { 
      message
    });
    console.log('[simple-parent-child-test] Received response from echo-fixed task:', JSON.stringify(echoResponse));
    
    // Step 2: Check if the echo-fixed task returned the same message
    let echoResult = echoResponse;
    let verificationPassed = false;
    
    // Try to extract the result from the response
    if (echoResponse && typeof echoResponse === 'object') {
      if (echoResponse.success === true) {
        // This is a wrapped result from the stack processor
        if (echoResponse.data) {
          // The result is in the data property
          echoResult = echoResponse.data;
        } else if (echoResponse.result) {
          // The result might be in the result property
          echoResult = echoResponse.result;
        }
      }
    }
    
    // Check if the echo-fixed task returned the same message
    if (echoResult && echoResult.message === message) {
      verificationPassed = true;
    }
    
    console.log(`[simple-parent-child-test] Verification: ${verificationPassed ? 'PASSED' : 'FAILED'}`);
    console.log(`[simple-parent-child-test] Expected message: ${message}`);
    console.log(`[simple-parent-child-test] Received message: ${echoResult ? echoResult.message : 'undefined'}`);
    
    // Step 3: Return the result with verification
    return {
      message,
      echoResult,
      echoResponse,
      verificationPassed,
      parentResumed: true,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error(`[simple-parent-child-test] Error: ${error.message}`);
    throw new Error(`Failed to execute parent-child test: ${error.message}`);
  }
}
