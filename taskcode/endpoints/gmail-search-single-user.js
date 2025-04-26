/**
 * @task gmail-search-single-user
 * @description Performs a Gmail search for a single specified user and returns all message fields (e.g. bcc, subject, etc) for all matching messages, including message id and a direct Gmail link.
 * @param {object} input - The input object.
 * @param {string} input.userEmail - The primary email address of the user to search.
 * @param {string} [input.searchQuery="is:unread"] - The Gmail search query to perform.
 * @param {number} [input.maxMessages=50] - Maximum number of messages to consider.
 * @returns {Promise<object>} - { success: boolean, messageCount: number, messages: array }
 * @throws {Error} If required input 'userEmail' is missing or if the gapi tool is unavailable.
 */
module.exports = async function execute(input = {}, { tools }) {
  const userEmail = input.userEmail;
  const searchQuery = input.searchQuery || "is:unread";
  const maxMessagesToList = input.maxMessages || 50;

  if (!userEmail) throw new Error("[gmail-search-single-user] Required input 'userEmail' is missing.");
  if (!tools?.gapi) throw new Error("[gmail-search-single-user] The 'tools.gapi' proxy is not available in the environment.");

  // List messages
  const listResult = await tools.gapi.gmail.users.messages.list({
    userId: "me",
    q: searchQuery,
    maxResults: maxMessagesToList,
    fields: 'messages/id',
    __impersonate: userEmail
  });

  if (!listResult?.messages?.length) {
    return { success: true, messageCount: 0, messages: [] };
  }

  const messageIds = listResult.messages.map(m => m.id);

  // Fetch all message fields (full metadata, including bcc, subject, etc)
  const messages = await Promise.all(
    messageIds.map(async id => {
      try {
        const msg = await tools.gapi.gmail.users.messages.get({
          userId: "me",
          id,
          format: "full",
          __impersonate: userEmail
        });

        // Extract headers as a flat object (case-insensitive)
        let headers = {};
        if (msg?.payload?.headers && Array.isArray(msg.payload.headers)) {
          for (const h of msg.payload.headers) {
            if (h?.name && h?.value) headers[h.name.toLowerCase()] = h.value;
          }
        }

        // Add message id and Gmail web link
        const messageId = msg?.id || id;
        const gmailLink = `https://mail.google.com/mail/u/0/#inbox/${messageId}`;

        return {
          ...msg,
          id: messageId,
          gmailLink,
          headers
        };
      } catch (err) {
        return null;
      }
    })
  );

  const filteredMessages = messages.filter(Boolean);

  return {
    success: true,
    messageCount: filteredMessages.length,
    messages: filteredMessages
  };
};