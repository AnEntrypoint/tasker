/**
 * @task test-suspend-resume
 * @description A simple task to test the suspend/resume mechanism
 * @param {object} input - The input parameters
 * @param {number} [input.duration=3000] - Duration to sleep in milliseconds
 * @returns {object} Result of the suspend/resume test
 */
module.exports = async function testSuspendResume(input) {
  console.log("Starting test-suspend-resume task");
  console.log("Input:", JSON.stringify(input || {}));
  
  // Get sleep duration from input or use default
  const duration = input?.duration || 3000;
  console.log(`Using sleep duration: ${duration}ms`);
  
  try {
    // Make sure we have access to the tools object
    if (!tools || typeof tools.sleep !== 'function') {
      throw new Error("tools.sleep function is not available - cannot proceed");
    }
    
    // Record the start time
    const startTime = new Date().getTime();
    console.log(`Start time: ${startTime}ms`);
    
    // Call sleep - this should suspend and resume the VM
    console.log(`Calling tools.sleep(${duration}) - VM will suspend here`);
    await tools.sleep(duration);
    
    // Record the end time
    const endTime = new Date().getTime();
    console.log(`End time: ${endTime}ms`);
    
    // Calculate the elapsed time
    const elapsedTime = endTime - startTime;
    console.log(`Elapsed time: ${elapsedTime}ms (expected ~${duration}ms)`);
    
    // Check if the suspend/resume mechanism is working correctly
    const isWorking = elapsedTime >= duration;
    console.log(`Suspend/resume mechanism working: ${isWorking}`);
    
    return {
      success: true,
      suspend_resume_working: isWorking,
      expected_duration_ms: duration,
      actual_duration_ms: elapsedTime,
      start_time_ms: startTime,
      end_time_ms: endTime,
      timestamp: new Date().toISOString(),
      message: isWorking 
        ? `Suspend/resume mechanism is working correctly (slept for ${elapsedTime}ms)` 
        : `Suspend/resume mechanism may not be working correctly (only ${elapsedTime}ms elapsed for ${duration}ms sleep)`
    };
  } catch (error) {
    console.error(`Error in test-suspend-resume task: ${error.message}`);
    console.error("Stack:", error.stack);
    
    return {
      success: false,
      error: error.message,
      errorStack: error.stack,
      timestamp: new Date().toISOString()
    };
  }
}; 