/**
 * @task gapi-bulk-user-search
 * @description Calls 'user-list', then 'gmail-search-single-user' for each user, returns summary.
 * @param {object} input
 * @param {string} [input.searchQuery="is:unread"]
 * @param {number} [input.maxMessagesPerUser=5]
 * @returns {Promise<object>}
 */
module.exports = async function execute(input = {}, { tools }) {
  const searchQuery = input.searchQuery || "is:unread";
  const maxMessagesPerUser = input.maxMessagesPerUser || 5;
  const start = Date.now();

  let users = [];
  const res = await tools.tasks.execute('user-list', {});
  users = Array.isArray(res) ? res : res?.result || res?.output || res?.data || [];
  if (!Array.isArray(users)) throw new Error("user-list did not return an array");
  const mails = []
  for (const user of users) {
    if (!user.primaryEmail) continue;
    mails.push(await tools.tasks.execute('gmail-search-single-user', {
      userEmail: user.primaryEmail,
      searchQuery,
      maxResults: maxMessagesPerUser
    }));
  }

  return {
    success: true,
    mails,
    totalUsersFetched: users.length,
    durationSeconds: (Date.now() - start) / 1000
  };
};