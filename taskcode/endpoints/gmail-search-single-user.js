/**
 * @task gmail-search-single-user
 * @description Performs a Gmail search for a single specified user and returns the count of matching messages.
 * @param {object} input - The input object.
 * @param {string} input.userEmail - The primary email address of the user to search.
 * @param {string} [input.searchQuery="is:unread"] - The Gmail search query to perform.
 * @param {number} [input.maxMessages=50] - Maximum number of messages to consider for the count (API limit for list is higher).
 * @returns {Promise<object>} - An object containing { success: boolean, messageCount: number } or { success: false, error: string }.
 * @throws {Error} If required input 'userEmail' is missing or if the gapi tool is unavailable.
 */
module.exports = async function execute(input = {}, { tools }) {
  const userEmail = input.userEmail;
  const searchQuery = input.searchQuery || "is:unread";
  // The client passes maxMessages, but list() can check more efficiently.
  // Let's use a slightly higher internal limit for list if needed, though client limit might be fine.
  const maxMessagesToList = input.maxMessages || 50; // Adjust if necessary, client limit is 5.

  if (!userEmail) {
    throw new Error("[gmail-search-single-user] Required input 'userEmail' is missing.");
  }
  if (!tools || !tools.gapi) {
      throw new Error("[gmail-search-single-user] The 'tools.gapi' proxy is not available in the environment.");
  }

  console.log(`[gmail-search-single-user] Task started for user: ${userEmail}, Query: "${searchQuery}", MaxList: ${maxMessagesToList}`);

  // Helper to extract header value - NO LONGER NEEDED
  // const getHeader = (headers, name) => { ... };

  try {
    // --- Step 1: List messages to get count ---
    console.log(`[gmail-search-single-user] Listing messages for ${userEmail} to get count...`);
    const listResult = await tools.gapi
                           .gmail.users.messages.list({
                                userId: "me",
                                q: searchQuery,
                                maxResults: maxMessagesToList, // Limit the list call
                                fields: 'messages/id,resultSizeEstimate', // Request only message IDs to optimize
                                __impersonate: userEmail
                            });

    // Check the structure of listResult - it might contain resultSizeEstimate or just messages array
    const messageCount = listResult?.messages?.length ?? 0;
    // const estimatedTotal = listResult?.resultSizeEstimate; // Could use this, but messages.length is definite for the page fetched

    if (!listResult) {
      console.warn(`[gmail-search-single-user] Received empty listResult for ${userEmail}. Assuming 0 messages.`);
       return { success: true, messageCount: 0 };
    }

    if (messageCount === 0) {
      console.log(`[gmail-search-single-user] No messages found for ${userEmail} matching query.`);
      return { success: true, messageCount: 0 }; // Success, 0 messages
    }

    console.log(`[gmail-search-single-user] Found ${messageCount} messages (up to max ${maxMessagesToList}) for ${userEmail}.`);

    // --- Step 2: NO LONGER NEEDED - We are not fetching details ---
    // const messageDetailsList = [];
    // for (const messageInfo of messageInfos) { ... }

    // console.log(`[gmail-search-single-user] Finished fetching details for ${userEmail}. Found details for ${messageDetailsList.length} messages.`);

    return {
        success: true,
        messageCount: messageCount // Return the count directly
    };

  } catch (error) { // Catch errors from the list call or unexpected issues
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[gmail-search-single-user] Task error for user ${userEmail}: ${errorMessage}`);
    // Log proxy details if available
    if (error && typeof error === 'object' && error.responseBody) {
        console.error(`[gmail-search-single-user] Proxy error details for ${userEmail}:`, JSON.stringify(error.responseBody));
    }
    return {
        success: false,
        error: `Failed task for ${userEmail}: ${errorMessage}`
    };
  }
}; 