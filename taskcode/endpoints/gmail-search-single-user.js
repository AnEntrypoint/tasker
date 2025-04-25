/**
 * @task gmail-search-single-user
 * @description Performs a Gmail search for a single specified user, retrieves metadata for found messages.
 * @param {object} input - The input object.
 * @param {string} input.userEmail - The primary email address of the user to search.
 * @param {string} [input.searchQuery="is:unread"] - The Gmail search query to perform.
 * @param {number} [input.maxMessages=5] - Maximum number of messages to fetch details for.
 * @returns {Promise<object>} - An object containing { success: boolean, messages: Array<object> } or { success: false, error: string }.
 *                              Each message object contains { id, threadId, subject, from, to, cc, bcc }.
 * @throws {Error} If required input 'userEmail' is missing or if the gapi tool is unavailable.
 */
module.exports = async function execute(input = {}, { tools }) {
  const userEmail = input.userEmail;
  const searchQuery = input.searchQuery || "is:unread";
  const maxMessagesToFetch = input.maxMessages || 5; // Limit how many messages we get details for

  if (!userEmail) {
    throw new Error("[gmail-search-single-user] Required input 'userEmail' is missing.");
  }
  if (!tools || !tools.gapi) {
      throw new Error("[gmail-search-single-user] The 'tools.gapi' proxy is not available in the environment.");
  }

  console.log(`[gmail-search-single-user] Task started for user: ${userEmail}, Query: "${searchQuery}", MaxDetails: ${maxMessagesToFetch}`);

  // Helper to extract header value
  const getHeader = (headers, name) => {
    const header = headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
    return header ? header.value : null;
  };

  try {
    // --- Step 1: List messages to get IDs ---
    console.log(`[gmail-search-single-user] Listing messages for ${userEmail}...`);
    const listResult = await tools.gapi
                           .gmail.users.messages.list({
                                userId: "me", 
                                q: searchQuery,
                                maxResults: maxMessagesToFetch, // Use the limit here
                                // Remove fields parameter to get message list (id, threadId)
                                __impersonate: userEmail 
                            });

    const messageInfos = listResult?.messages; // Array of { id, threadId }

    if (!messageInfos || messageInfos.length === 0) {
      console.log(`[gmail-search-single-user] No messages found for ${userEmail} matching query.`);
      return { success: true, messages: [] }; // Success, but no messages
    }

    console.log(`[gmail-search-single-user] Found ${messageInfos.length} message IDs for ${userEmail}. Fetching details...`);

    // --- Step 2: Get details for each message ID ---
    const messageDetailsList = [];
    for (const messageInfo of messageInfos) {
        const messageId = messageInfo.id;
        const threadId = messageInfo.threadId;
        if (!messageId) continue;

        try {
            console.log(`[gmail-search-single-user] Getting metadata for message ${messageId} (User: ${userEmail})...`);
            const getResult = await tools.gapi.gmail.users.messages.get({
                userId: "me",
                id: messageId,
                format: "METADATA", // Get headers, not full body
                metadataHeaders: ["Subject", "From", "To", "Cc", "Bcc"], // Request specific headers
                __impersonate: userEmail
            });

            const headers = getResult?.payload?.headers;
            const messageDetails = {
                id: messageId,
                threadId: threadId,
                subject: getHeader(headers, 'Subject'),
                from: getHeader(headers, 'From'),
                to: getHeader(headers, 'To'),
                cc: getHeader(headers, 'Cc'),
                bcc: getHeader(headers, 'Bcc')
            };
            messageDetailsList.push(messageDetails);
            // console.log(`[gmail-search-single-user] Fetched details for message ${messageId}`); // Too verbose

        } catch (getError) {
             const errorMsg = getError instanceof Error ? getError.message : String(getError);
             console.error(`[gmail-search-single-user] Error getting message ${messageId} for ${userEmail}: ${errorMsg}`);
             // Optionally add partial failure info, or just skip this message
             messageDetailsList.push({ id: messageId, threadId: threadId, error: `Failed to get details: ${errorMsg}` });
        }
    } // End loop through message IDs

    console.log(`[gmail-search-single-user] Finished fetching details for ${userEmail}. Found details for ${messageDetailsList.length} messages.`);
    
    return { 
        success: true, 
        messages: messageDetailsList // Return the array of message details
    };

  } catch (error) { // Catch errors from the list call or unexpected issues
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[gmail-search-single-user] Top-level error for user ${userEmail}: ${errorMessage}`);
    if (error && typeof error === 'object' && error.responseBody) {
        console.error(`[gmail-search-single-user] Proxy error details for ${userEmail}:`, error.responseBody);
    }
    return { 
        success: false, 
        error: `Failed task for ${userEmail}: ${errorMessage}` 
    };
  }
}; 