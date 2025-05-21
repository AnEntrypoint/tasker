/**
 * @task gapi-keystore-test
 * @description Tests the save/sleep/resume functionality with keystore access
 * @param {object} input - Input parameters
 * @param {boolean} [input.verbose=false] - Enable verbose logging
 * @returns {Object} Keystore access results and execution metadata
 */
module.exports = async function execute(input, context) {
  console.log("Starting gapi-keystore-test task");
  console.log(`Got input: ${JSON.stringify(input)}`);
  
  const startTime = Date.now();
  const verbose = input.verbose === true;
  
  try {
    if (verbose) console.log("Phase 1: Task initialization");
    
    // Save starting timestamp
    const taskStarted = new Date().toISOString();
    
    // Get admin email from keystore - this should trigger a save/sleep/resume cycle
    console.log("Phase 2: Retrieving admin email from keystore...");
    
    const adminEmail = await context.tools.keystore.getKey("global", "GAPI_ADMIN_EMAIL");
    console.log(`Retrieved admin email from keystore: ${adminEmail}`);
    
    // Get key information - should trigger another save/sleep/resume
    console.log("Phase 3: Retrieving service account key info...");
    
    let serviceAccountInfo;
    try {
      const keyInfo = await context.tools.keystore.getKey("global", "GAPI_KEY");
      // Only log a portion of the key for security
      if (keyInfo && typeof keyInfo === 'string') {
        serviceAccountInfo = JSON.parse(keyInfo);
        console.log(`Retrieved service account info for: ${serviceAccountInfo.client_email || 'unknown'}`);
      } else {
        console.log("Retrieved key info but it's not a valid string");
        serviceAccountInfo = { error: "Invalid key format" };
      }
    } catch (keyError) {
      console.error(`Error retrieving service account key: ${keyError.message}`);
      serviceAccountInfo = { error: keyError.message };
    }
    
    // Build the final response
    const taskFinished = new Date().toISOString();
    const executionTime = Date.now() - startTime;
    
    return {
      success: true,
      credentials: {
        adminEmail,
        serviceAccountEmail: serviceAccountInfo?.client_email || null,
        serviceAccountId: serviceAccountInfo?.client_id || null,
        projectId: serviceAccountInfo?.project_id || null
      },
      metadata: {
        taskStarted,
        taskFinished,
        executionTimeMs: executionTime,
      }
    };
  } catch (error) {
    console.error(`Error in gapi-keystore-test task: ${error.message || String(error)}`);
    return {
      success: false,
      error: `Failed to test keystore access: ${error.message || String(error)}`,
      metadata: {
        taskStarted: new Date().toISOString(),
        taskFinished: new Date().toISOString(),
        executionTimeMs: Date.now() - startTime
      }
    };
  }
} 