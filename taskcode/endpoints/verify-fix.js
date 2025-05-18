/**
 * @task verify-fix
 * @description Verifies that the stack processor fix is working correctly
 * @param {object} input - The input object
 * @param {string} input.message - The message to echo
 * @returns {Promise<object>} - The result with verification
 */
module.exports = async function execute(input, { tools }) {
  console.log('[verify-fix] Starting with input:', JSON.stringify(input));
  
  if (!input || typeof input.message !== 'string') {
    throw new Error("Input must be an object with a 'message' property of type string.");
  }
  
  const message = input.message;
  console.log(`[verify-fix] Message: ${message}`);
  
  try {
    // Step 1: Call the simple-test task with the message
    console.log('[verify-fix] Calling simple-test task...');
    const childResponse = await tools.tasks.execute('simple-test', { 
      message
    });
    console.log('[verify-fix] Received response from simple-test task:', JSON.stringify(childResponse));
    
    // Step 2: Check if the simple-test task returned the same message
    let verificationPassed = false;
    
    // The stack processor should now return the unwrapped result directly
    if (childResponse && typeof childResponse === 'object') {
      if (childResponse.message === message) {
        verificationPassed = true;
        console.log(`[verify-fix] Verification PASSED: Result is unwrapped correctly`);
      } else if (childResponse.success === true && childResponse.data && childResponse.data.message === message) {
        console.log(`[verify-fix] Verification FAILED: Result is still wrapped in a success object`);
      } else {
        console.log(`[verify-fix] Verification FAILED: Unexpected result format`);
      }
    } else {
      console.log(`[verify-fix] Verification FAILED: Result is not an object`);
    }
    
    console.log(`[verify-fix] Verification: ${verificationPassed ? 'PASSED' : 'FAILED'}`);
    console.log(`[verify-fix] Expected message: ${message}`);
    console.log(`[verify-fix] Received message: ${childResponse && childResponse.message ? childResponse.message : 'undefined'}`);
    
    // Step 3: Return the result with verification
    return {
      message,
      childResponse,
      verificationPassed,
      parentResumed: true,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error(`[verify-fix] Error: ${error.message}`);
    throw new Error(`Failed to execute verification: ${error.message}`);
  }
}
