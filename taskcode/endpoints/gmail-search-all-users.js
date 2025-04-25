/**
 * @task gmail-search-all-users
 * @description Fetches all users via 'simple-user-list-test' task and attempts to perform a Gmail search for each user (impersonation required).
 * @param {object} input - The input object.
 * @param {string} [input.searchQuery="is:unread"] - The Gmail search query to perform for each user.
 * @returns {Promise<object>} - An object containing the list of users fetched and results/errors for each search attempt.
 * @throws {Error} If the initial user fetching task fails.
 */
module.exports = async function execute(input = {}, { tools }) {
  const searchQuery = input.searchQuery || "is:unread";
  console.log(`[gmail-search-all-users] Task started. Search query: "${searchQuery}"`);

  if (!tools || !tools.tasks || typeof tools.tasks.execute !== 'function') {
    throw new Error("The 'tools.tasks' object with an 'execute' method is not available in the environment.");
  }
  if (!tools.gapi) {
      throw new Error("The 'tools.gapi' proxy is not available in the environment.");
  }

  let users = [];
  const searchResults = {};

  // --- 1. Call simple-user-list-test to get all users ---
  try {
    // console.log("[gmail-search-all-users] Calling 'simple-user-list-test' task to fetch users..."); // Keep top-level call log
    // console.log('[gmail-search-all-users] Executing nested task: simple-user-list-test'); // Redundant log
    const taskProxyResponse = await tools.tasks.execute("simple-user-list-test");

    // Log the raw response for debugging - COMMENT OUT FOR LESS VERBOSITY
    // console.log("[gmail-search-all-users] Raw response from simple-user-list-test:", JSON.stringify(taskProxyResponse));

    // Validate the response structure and extract the user list
    // Check if the response is a successful object containing a 'data' array
    if (
        !taskProxyResponse || 
        typeof taskProxyResponse !== 'object' || 
        taskProxyResponse.success !== true || 
        !Array.isArray(taskProxyResponse.data)
    ) {
      console.error('[gmail-search-all-users] Invalid structure received from nested task (expected { success: true, data: [...] }):', taskProxyResponse);
      // Include logs from the nested task if available
      const nestedLogs = Array.isArray(taskProxyResponse?.logs) ? taskProxyResponse.logs.join('\n') : 'N/A';
      throw new Error('Task failed: Received invalid structure from nested task. Response: ' + JSON.stringify(taskProxyResponse) + '\nNested Logs:\n' + nestedLogs);
    }

    users = taskProxyResponse.data; // Assign the data array
    console.log(`[gmail-search-all-users] Received ${users.length} users from simple-user-list-test.`);

    if (users.length === 0) {
      console.warn("[gmail-search-all-users] No users found in the response. Completing task successfully.");
      return { success: true, usersFetched: 0, searchAttempts: {} };
    }

  } catch (error) {
    console.error('[gmail-search-all-users] Task execution failed:', error);
    // Propagate the error or return a structured error response
    const detailedError = error.message || String(error);
    // throw new Error(`Task failed: ${detailedError}`); // Re-throwing might be better
     return { success: false, error: `Task failed: ${detailedError}` }; // Keep returning error object for now
  }

  // --- 2. Iterate through users and attempt Gmail search (Impersonation Needed) ---
  console.log("[gmail-search-all-users] Starting Gmail search attempts for each user...");

  // Helper function for delay
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const delayMs = 500; // 500ms delay = 2 calls per second

  for (const user of users) {
    const userEmail = user.primaryEmail;
    if (!userEmail) {
      console.warn("[gmail-search-all-users] Skipping user with missing primaryEmail:", user);
      continue;
    }

    console.log(`[gmail-search-all-users] Attempting search for user: ${userEmail}`);
    try {
      // Pass the user email in the config for wrappedgapi to handle impersonation
      // console.warn(`[gmail-search-all-users] Performing search for ${userEmail}. Passing __impersonate in list() args, using userId: \'me\'.`);
      // console.warn(`[gmail-search-all-users] Performing search for ${userEmail}. Impersonation should be handled by the proxy. Using userId: 'me'.`); // VERBOSE - COMMENT OUT

      // Impersonation should be handled by the tools.gapi proxy wrapper
      const result = await tools.gapi
                             .gmail.users.messages.list({
                                  userId: "me", // Use "me" - impersonation context set by proxy
                                  // userId: userEmail, // Try using the actual user email again
                                  q: searchQuery,
                                  maxResults: 1, // We only need the estimate, not actual messages
                                  fields: "resultSizeEstimate", // <<< Request only the estimate
                                  __impersonate: userEmail // Add back impersonation hint
                              });

      // console.log(`[gmail-search-all-users] Search successful for ${userEmail}. Found ${result?.messages?.length || 0} messages (approx. ${result?.resultSizeEstimate || 'N/A'}).`);
      // Updated log to reflect we only have the estimate now
      console.log(`[gmail-search-all-users] Search successful for ${userEmail}. Approx messages: ${result?.resultSizeEstimate || 'N/A'}.`);
      // Store only the estimate
      searchResults[userEmail] = { success: true, resultSizeEstimate: result?.resultSizeEstimate };

    } catch (error) {
      console.error(`[gmail-search-all-users] Error searching Gmail for user ${userEmail}: ${error.message || error}`);
      // Log detailed error if available from the proxy
      if (error?.responseBody) {
          console.error(`[gmail-search-all-users] Proxy error details for ${userEmail}:`, error.responseBody);
      }
      searchResults[userEmail] = { success: false, error: error.message || String(error) };
    }

    // --- Add delay after each user processing --- 
    // console.log(`[gmail-search-all-users] Delaying ${delayMs}ms before next user...`); // VERBOSE - COMMENT OUT
    await delay(delayMs);
    // ----------------------------------------------
  }

  console.log("[gmail-search-all-users] Task finished.");

  // Return the list of users and the search attempt results
  return {
    usersFetched: users.length,
    searchAttempts: searchResults
  };
}; 