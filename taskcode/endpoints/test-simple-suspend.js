/**
 * A simple test task that demonstrates basic suspend/resume without external APIs
 * 
 * @param {Object} input - The input parameters
 * @returns {Object} The result of basic operations
 */
module.exports = async function testSimpleSuspend(input = {}) {
  console.log("======= STARTING SIMPLE SUSPEND TEST =======");
  
  let step1Result = null;
  let step2Result = null;
  let currentStep = 1;
  
  // Check if we're resuming
  if (globalThis.__resumeResult__ && globalThis.__checkpoint__) {
    console.log("RESUMING: Found resume data");
    console.log("RESUMING: Checkpoint:", JSON.stringify(globalThis.__checkpoint__, null, 2));
    
    const completedCall = globalThis.__checkpoint__.completedServiceCall;
    if (completedCall?.result) {
      console.log("RESUMING: Using completed call result");
      step1Result = completedCall.result;
      currentStep = 2;
    }
  }
  
  // Step 1: Simple operation
  if (currentStep === 1) {
    console.log("STEP 1: Performing simple operation...");
    
    // Just return some simple data to test the mechanism
    step1Result = {
      timestamp: new Date().toISOString(),
      data: "Hello from step 1",
      random: Math.random()
    };
    
    console.log("STEP 1: Completed", step1Result);
    currentStep = 2;
  }
  
  // Step 2: Another simple operation
  if (currentStep === 2) {
    console.log("STEP 2: Performing second operation...");
    
    step2Result = {
      timestamp: new Date().toISOString(),
      data: "Hello from step 2",
      previousData: step1Result?.data || "No previous data",
      random: Math.random()
    };
    
    console.log("STEP 2: Completed", step2Result);
  }
  
  // Return result
  const result = {
    step1: step1Result,
    step2: step2Result,
    success: true,
    totalSteps: 2
  };
  
  console.log("======= SIMPLE SUSPEND TEST COMPLETED =======");
  return result;
}; 