/**
 * Fetches all users (email and name) from all domains associated with the Google Workspace customer.
 *
 * @param {Object} input - Input object (currently unused)
 * @returns {Promise<Array<Object>>} A list of user objects, each containing { email, name }.
 */
module.exports = async function() {
  console.log("[simple-user-list-test] Task started.");

  let customerId = null; // Restore customerId variable
  const allUsers = [];
  let domains = [];

  // Ensure tools.gapi is available
  if (!tools || !tools.gapi) {
      console.error('[simple-user-list-test] tools.gapi proxy is not available!');
      throw new Error('Required tools.gapi proxy is missing in the execution environment.');
  }

  // Check for required tools
  const requiredTools = ['keystore', 'gapi'];
  const missing = requiredTools.filter(tool => !tools[tool]);
  if (missing.length > 0) {
    console.error(`[simple-user-list-test] Missing required tools: ${missing}. Aborting.`);
    throw new Error(`Missing required tools: ${missing}`);
  }

  try {
    const adminEmailResponse = await tools.keystore.getKey("global", "GAPI_ADMIN_EMAIL");
    let adminEmail; // Define adminEmail here

    if (typeof adminEmailResponse === 'string' && adminEmailResponse.trim() !== '') {
      adminEmail = adminEmailResponse; // <<< ASSIGN adminEmail HERE
      console.log(`[simple-user-list-test] Retrieved admin email: ${adminEmail}`);
    } else {
      console.error(
        `[simple-user-list-test] GAPI_ADMIN_EMAIL not found in keystore or invalid data. Response: ${JSON.stringify(adminEmailResponse)}`
      );
      throw new Error("GAPI_ADMIN_EMAIL not found or invalid.");
    }

    // 2. Get Customer ID using Admin Email for impersonation
    console.log(`[simple-user-list-test] Fetching user info for ${adminEmail} to get Customer ID...`);

    // We need to impersonate the admin user to get their details, including customerId
    const userResponse = await tools.gapi.admin.users.get({
      userKey: adminEmail // Use email from keystore
    }, {
      __impersonate: adminEmail // Pass impersonation subject in config
    });

    console.log(`[simple-user-list-test] User info response status: ${userResponse?.status}`); // Add logging for status

    // Check if the response contains the expected data structure
    if (userResponse && userResponse.customerId) {
      customerId = userResponse.customerId;
      console.log(`[simple-user-list-test] Successfully determined Customer ID: ${customerId}`);
    } else {
      console.error(`[simple-user-list-test] Could not find Customer ID directly in user info response.`);
      console.error(`[simple-user-list-test] Full user info response:`, JSON.stringify(userResponse, null, 2)); // Log the full response
      throw new Error(`Failed to determine Customer ID: Customer ID not found in users.get response for userKey: ${adminEmail}.`);
    }

    // Ensure customerId is set before proceeding
    if (!customerId) {
      console.error(`[simple-user-list-test] Customer ID is null after attempting to fetch. Aborting.`);
      throw new Error("Customer ID could not be determined.");
    }

    // 4. List ALL Users using Customer ID with Pagination
    let pageToken = null;
    let pageCount = 0;
    console.log(`[simple-user-list-test] Starting fetch for ALL users for customer: ${customerId}...`);

    do {
        pageCount++;
        console.log(`[simple-user-list-test] Fetching page ${pageCount}... (Token: ${pageToken ? '...' : 'None'})`);
        try {
            const usersResponse = await tools.gapi.admin.users.list({
                customer: customerId,
                pageToken: pageToken,
                maxResults: 500, // Max allowed by API is 500
                orderBy: 'email', // For consistent ordering
                viewType: 'domain_public' // Usually sufficient, change if needed
            }, {
                __impersonate: adminEmail // Impersonate using the fetched admin email
            });

            if (usersResponse && Array.isArray(usersResponse.users)) {
                console.log(`[simple-user-list-test] Fetched ${usersResponse.users.length} users on page ${pageCount}.`);
                allUsers.push(...usersResponse.users); // Add users from this page
                pageToken = usersResponse.nextPageToken; // Get token for next page
            } else {
                console.warn(`[simple-user-list-test] No users array found in response on page ${pageCount}. Response: ${JSON.stringify(usersResponse)}`);
                pageToken = null; // Stop pagination
            }

        } catch (error) {
            console.error(`[simple-user-list-test] Error listing users on page ${pageCount}:`, error.message);
            if (error.stack) console.error("User listing stack trace:", error.stack);
            // Decide whether to throw or just log and stop pagination
            // For now, let's throw to indicate a failure during retrieval
            throw new Error(`Failed to list users on page ${pageCount}: ${error.message}`);
        }
    } while (pageToken); // Continue if there's a next page token

    console.log(`[simple-user-list-test] Finished fetching users. Total users found: ${allUsers.length} across ${pageCount} page(s).`);

    // *** Return the consolidated user list on success ***
    return allUsers;

  } catch (error) {
    console.error(`[simple-user-list-test] Task failed: ${error.message}`);
    console.error("Stack trace:", error.stack); // Log stack trace for better debugging
    // Ensure adminEmail value is logged if the error occurs after fetching it
    if (adminEmail) {
      console.error(`Admin email used during failure: ${adminEmail}`);
    }
    throw error; // Re-throw the error to ensure task failure is reported
  }
}; 