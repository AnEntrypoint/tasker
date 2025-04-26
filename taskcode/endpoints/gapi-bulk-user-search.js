/**
 * @task gapi-bulk-user-search
 * @description Calls the 'user-list' task to get all users, performs a Gmail search for each, and returns aggregated results.
 * @param {object} input - The input object.
 * @param {string} [input.searchQuery="is:unread"] - The Gmail search query to perform for each user.
 * @param {number} [input.maxMessagesPerUser=5] - Maximum number of messages to count for each user.
 * @returns {Promise<object>} - An object containing aggregated results (totalUsers, successCount, errorCount, durationSeconds, errors).
 * @throws {Error} If required tools (gapi.gmail, tasks) are unavailable or API/task calls fail.
 */
module.exports = async function execute(input = {}, { tools }) {
  const searchQuery = input.searchQuery || "is:unread";
  const maxMessagesPerUser = input.maxMessagesPerUser || 5;

  // Check necessary tools
  if (!tools?.tasks?.execute) {
      throw new Error("[gapi-bulk-user-search] 'tools.tasks.execute' is not available.");
  }

  console.log(`[gapi-bulk-user-search] Task started. Query: "${searchQuery}"`);
  const startTime = Date.now();

  let allUsers = [];
  let usersFetched = 0;
  let fetchErrors = 0;
  const userFetchErrors = []; // Keep track of errors from the user-list task

  // --- Step 1: Fetch All Users via user-list task --- 
  try {
      const userListTaskResult = await tools.tasks.execute('user-list', {}); // Call user-list task
      
      // Extract the actual user list - check common wrapper patterns
      if (Array.isArray(userListTaskResult)) {
          allUsers = userListTaskResult;
      } else if (userListTaskResult && Array.isArray(userListTaskResult.result)) {
          allUsers = userListTaskResult.result;
      } else if (userListTaskResult && Array.isArray(userListTaskResult.output)) {
          allUsers = userListTaskResult.output;
      } else if (userListTaskResult && Array.isArray(userListTaskResult.data)) {
          allUsers = userListTaskResult.data;
      } else {
          // If none match, assume the task itself failed or returned an error structure
          let errorDetail = `user-list task returned unexpected format: ${JSON.stringify(userListTaskResult)}`;
          if (userListTaskResult && userListTaskResult.error) { // Check for explicit error field
              errorDetail = `user-list task failed: ${JSON.stringify(userListTaskResult.error)}`;
          }
          throw new Error(errorDetail);
      }

      // Validate the extracted user array
      if (!Array.isArray(allUsers)) {
          // This case should be caught by the extraction logic, but double-check
          throw new Error(`Extracted result from user-list is not an array: ${JSON.stringify(allUsers)}`);
      }

      // If the array is empty, it might be valid (no users) or an error upstream
      // The user-list task should ideally throw if it fails critically.
      usersFetched = allUsers.length;
      console.log(`[gapi-bulk-user-search] Fetched ${usersFetched} users via user-list task.`);
      
      // Check if the extracted users have the required fields (at least primaryEmail)
      if (usersFetched > 0 && !allUsers[0].primaryEmail) {
           console.warn(`[gapi-bulk-user-search] User objects from user-list task might be missing 'primaryEmail'. First user:`, JSON.stringify(allUsers[0]));
           // Depending on user-list contract, might need to adapt or throw here
      }

  } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[gapi-bulk-user-search] CRITICAL FAILURE calling/processing user-list task: ${errorMessage}`);
      fetchErrors++; // Increment fetch error count
      userFetchErrors.push(`Failed during user fetch via user-list task: ${errorMessage}`);
      // Return immediately as we cannot proceed without users
      return {
          success: false,
          error: "Failed to fetch user list via nested task.",
          details: userFetchErrors,
          totalUsersFetched: 0,
          gmailSearchSuccessCount: 0,
          gmailSearchErrorCount: 0,
          fetchErrorCount: fetchErrors,
          durationSeconds: (Date.now() - startTime) / 1000,
          errors: userFetchErrors 
      };
  }

  // --- Step 2: Iterate and Perform Single User Search --- (Renumbered from Step 3)
  if (usersFetched === 0) {
      console.log("[gapi-bulk-user-search] No users returned by user-list task. Nothing to search.");
      return {
          success: true, // Task itself succeeded, but no users to process
          totalUsersFetched: 0,
          gmailSearchSuccessCount: 0,
          gmailSearchErrorCount: 0,
          fetchErrorCount: fetchErrors, // Report any errors from the (empty) fetch attempt
          durationSeconds: (Date.now() - startTime) / 1000,
          errors: userFetchErrors
      };
  }

  console.log(`[gapi-bulk-user-search] Starting Gmail searches for ${usersFetched} users (Sequential)...`);
  let searchSuccessCount = 0;
  let searchErrorCount = 0;
  const searchErrors = [];

  // Process users in batches (now sequential due to limit 1)
  for (let i = 0; i < allUsers.length; i++) {
      const user = allUsers[i];
      const userEmail = user.primaryEmail;
      if (!userEmail) {
          const userId = user.id || `user_at_index_${allUsers.indexOf(user)}`;
          console.warn(`[gapi-bulk-user-search] Skipping user ${userId} (from user-list) due to missing primaryEmail.`);
          searchErrorCount++;
          searchErrors.push({ userId: userId, error: "Missing primaryEmail in user-list result" });
          continue; // Skip this user in the batch
      }

      // Process one user at a time
      console.log(`[gapi-bulk-user-search] Searching user ${i + 1}/${usersFetched}: ${userEmail}`);

      try {
          const singleSearchInput = {
              userEmail: userEmail,
              searchQuery: searchQuery,
              maxResults: maxMessagesPerUser
          };
          const result = await tools.tasks.execute('gmail-search-single-user', singleSearchInput);

          if (result && result.success) {
              searchSuccessCount++;
          } else {
              searchErrorCount++;
              const nestedError = result?.error || `Unknown error from gmail-search-single-user for ${userEmail}`;
              console.error(`[gapi-bulk-user-search] -> Nested gmail-search-single-user FAILED for ${userEmail}: ${JSON.stringify(nestedError)}`);
              searchErrors.push({ userEmail: userEmail, error: nestedError });
          }
      } catch (error) {
          searchErrorCount++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[gapi-bulk-user-search] -> tools.tasks.execute FAILED for gmail-search-single-user (${userEmail}): ${errorMessage}`);
          searchErrors.push({ userEmail: userEmail, error: `Task execution failed: ${errorMessage}` });
      }
  }

  const endTime = Date.now();
  const durationSeconds = (endTime - startTime) / 1000;

  const finalMessage = `[gapi-bulk-user-search] Finished ${usersFetched} users in ${durationSeconds.toFixed(2)}s. Success: ${searchSuccessCount}, Failures: ${searchErrorCount}.`;
  if (searchErrorCount > 0 || fetchErrors > 0) {
      console.error(finalMessage); // Log as error if any failures occurred
  } else {
      console.log(finalMessage); // Log as info if all successful
  }

  // Combine fetch errors (from user-list call) and search errors
  const combinedErrors = userFetchErrors.map(e => ({ type: 'userListFetch', error: e })).concat(searchErrors.map(e => ({ type: 'gmailSearch', ...e })));

  // Adjust return object fields
  return {
      success: fetchErrors === 0, // Overall success depends on whether user-list task succeeded
      totalUsersFetched: usersFetched, 
      gmailSearchSuccessCount: searchSuccessCount,
      gmailSearchErrorCount: searchErrorCount,
      fetchErrorCount: fetchErrors,
      durationSeconds: durationSeconds,
      errors: combinedErrors 
  };
}; 