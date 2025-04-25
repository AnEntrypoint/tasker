/**
 * @task gmail-search-orchestrator
 * @description Orchestrates fetching a user list and then calling a single-user Gmail search task for each.
 * @param {object} input - The input object.
 * @param {string} [input.searchQuery="is:unread"] - The Gmail search query to pass to single-user tasks.
 * @param {number} [input.maxMessagesPerUser=5] - Max messages to fetch details for per user.
 * @returns {Promise<object>} - An object containing { success: boolean, results: object } or { success: false, error: string }.
 *                              The 'results' object maps user emails to the results from the single-user search task.
 * @throws {Error} If nested task calls fail unexpectedly or required tools are missing.
 */
module.exports = async function execute(input = {}, { tools }) {
  const searchQuery = input.searchQuery || "is:unread";
  const maxMessagesPerUser = input.maxMessagesPerUser || 5;

  console.log(`[Orchestrator] Task started. Query: "${searchQuery}", MaxMsgs: ${maxMessagesPerUser}`);

  if (!tools || !tools.tasks || typeof tools.tasks.execute !== 'function') {
    throw new Error("[Orchestrator] The 'tools.tasks' object with an 'execute' method is not available.");
  }

  let users = [];
  const aggregatedResults = {};
  let userListFetchError = null;

  // --- Step 1: Fetch User List --- 
  try {
    console.log("[Orchestrator] Calling 'simple-user-list-test' task...");
    const userListResult = await tools.tasks.execute("simple-user-list-test", {});

    if (!userListResult || userListResult.success !== true || !Array.isArray(userListResult.data)) {
      userListFetchError = `Failed to fetch user list or invalid format. Response: ${JSON.stringify(userListResult)}`;
      console.error(`[Orchestrator] ${userListFetchError}`);
      // Don't throw yet, allow returning partial results if any searches succeed later
    } else {
      users = userListResult.data;
      console.log(`[Orchestrator] Received ${users.length} users.`);
      if (users.length === 0) {
        console.log("[Orchestrator] No users found. Exiting successfully.");
        return { success: true, results: {} };
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Orchestrator] CRITICAL FAILURE calling 'simple-user-list-test': ${errorMsg}`);
    // If we can't even get the user list, fail the whole task
    return { success: false, error: `Critical failure fetching user list: ${errorMsg}` };
  }

  // If fetch failed but didn't throw, return the error now
  if (userListFetchError) {
     return { success: false, error: userListFetchError, results: aggregatedResults };
  }

  // --- Step 2: Iterate and Call Single User Search Task ---
  console.log(`[Orchestrator] Starting single-user searches for ${users.length} users...`);
  let successCount = 0;
  let errorCount = 0;
  const startTime = Date.now();

  for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const userEmail = user.primaryEmail;

      if (!userEmail) {
          console.warn(`[Orchestrator] Skipping user index ${i} due to missing primaryEmail.`);
          aggregatedResults[`user_${i}_missing_email`] = { success: false, error: "Missing primaryEmail" };
          errorCount++;
          continue;
      }

      console.log(`[Orchestrator] (${i + 1}/${users.length}) Calling gmail-search-single-user for: ${userEmail}...`);
      try {
          const singleSearchInput = {
              userEmail: userEmail,
              searchQuery: searchQuery,
              maxMessages: maxMessagesPerUser
          };
          const singleSearchResult = await tools.tasks.execute(`gmail-search-single-user`, singleSearchInput);
          
          // Store the entire result object (which includes success/error/messages)
          aggregatedResults[userEmail] = singleSearchResult;

          if (singleSearchResult?.success) {
              successCount++;
               console.log(` -> OK for ${userEmail}. Messages fetched: ${singleSearchResult.messages?.length ?? 0}`);
          } else {
              errorCount++;
              console.error(` -> FAILED task call for ${userEmail}: ${singleSearchResult?.error || 'Unknown error'}`);
          }

      } catch (taskError) {
          const errorMsg = taskError instanceof Error ? taskError.message : String(taskError);
          console.error(` -> CRITICAL FAILURE orchestrating task for ${userEmail}: ${errorMsg}`);
          aggregatedResults[userEmail] = { success: false, error: `Critical orchestration failure: ${errorMsg}` };
          errorCount++;
      }
       // Optional delay between *orchestrated* calls (might help if function startup is an issue)
       // await new Promise(resolve => setTimeout(resolve, 50)); 
  }

  const endTime = Date.now();
  const durationSeconds = (endTime - startTime) / 1000;

  console.log(`[Orchestrator] Finished processing ${users.length} users in ${durationSeconds.toFixed(2)} seconds.`);
  console.log(`[Orchestrator] Successes: ${successCount}, Failures: ${errorCount}`);

  // Return the aggregated results
  return {
      success: errorCount === 0, // Overall success if no errors occurred during orchestration/sub-tasks
      results: aggregatedResults,
      summary: {
         totalUsers: users.length,
         successfulSearches: successCount,
         failedSearches: errorCount,
         durationSeconds: durationSeconds
      }
  };
}; 