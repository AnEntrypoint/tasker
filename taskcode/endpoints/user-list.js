/**
 * Fetches all users (email and name) from all domains associated with the Google Workspace customer.
 *
 * @param {Object} input - Input object (currently unused)
 * @returns {Promise<Array<Object>>} A list of user objects, each containing { email, name }.
 */
module.exports = async function() {
  console.log("[user-list] Task started.");

  let customerId = null; // Restore customerId variable
  const allUsers = [];
  let domains = [];

  // Ensure tools.gapi is available
  if (!tools || !tools.gapi) {
      console.error('[user-list] tools.gapi proxy is not available!');
      throw new Error('Required tools.gapi proxy is missing in the execution environment.');
  }

  // Check for required tools
  const requiredTools = ['keystore', 'gapi'];
  const missing = requiredTools.filter(tool => !tools[tool]);
  if (missing.length > 0) {
    console.error(`[user-list] Missing required tools: ${missing}. Aborting.`);
    throw new Error(`Missing required tools: ${missing}`);
  }

  try {
    const adminEmailResponse = await tools.keystore.getKey("global", "GAPI_ADMIN_EMAIL");
    let adminEmail; // Define adminEmail here

    if (typeof adminEmailResponse === 'string' && adminEmailResponse.trim() !== '') {
      adminEmail = adminEmailResponse; // <<< ASSIGN adminEmail HERE
      console.log(`[user-list] Retrieved admin email: ${adminEmail}`);
    } else {
      console.error(
        `[user-list] GAPI_ADMIN_EMAIL not found in keystore or invalid data. Response: ${JSON.stringify(adminEmailResponse)}`
      );
      throw new Error("GAPI_ADMIN_EMAIL not found or invalid.");
    }

    // 2. Get Customer ID using Admin Email for impersonation
    console.log(`[user-list] Fetching user info for ${adminEmail} to get Customer ID...`);

    // We need to impersonate the admin user to get their details, including customerId
    const userResponse = await tools.gapi.admin.users.get({
      userKey: adminEmail // Use email from keystore
    }, {
      __impersonate: adminEmail // Pass impersonation subject in config
    });

    console.log(`[user-list] User info response status: ${userResponse?.status}`); // Add logging for status

    // Check if the response contains the expected data structure
    if (userResponse && userResponse.customerId) {
      customerId = userResponse.customerId;
      console.log(`[user-list] Successfully determined Customer ID: ${customerId}`);
    } else {
      console.error(`[user-list] Could not find Customer ID directly in user info response.`);
      console.error(`[user-list] Full user info response:`, JSON.stringify(userResponse, null, 2)); // Log the full response
      throw new Error(`Failed to determine Customer ID: Customer ID not found in users.get response for userKey: ${adminEmail}.`);
    }

    // Ensure customerId is set before proceeding
    if (!customerId) {
      console.error(`[user-list] Customer ID is null after attempting to fetch. Aborting.`);
      throw new Error("Customer ID could not be determined.");
    }

    // 4. List ALL Users using Customer ID with Pagination
    let pageToken = null;
    let pageCount = 0;
    console.log(`[user-list] Starting fetch for ALL users for customer: ${customerId}...`);

    do {
        pageCount++;
        console.log(`[user-list] Fetching page ${pageCount}... (Token: ${pageToken ? '...' : 'None'})`);
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
                console.log(`[user-list] Fetched ${usersResponse.users.length} users on page ${pageCount}.`);
                allUsers.push(...usersResponse.users); // Add users from this page
                pageToken = usersResponse.nextPageToken; // Get token for next page
            } else {
                console.warn(`[user-list] No users array found in response on page ${pageCount}. Response: ${JSON.stringify(usersResponse)}`);
                pageToken = null; // Stop pagination
            }

        } catch (error) {
            console.error(`[user-list] Error listing users on page ${pageCount}:`, error.message);
            if (error.stack) console.error("User listing stack trace:", error.stack);
            // Decide whether to throw or just log and stop pagination
            // For now, let's throw to indicate a failure during retrieval
            throw new Error(`Failed to list users on page ${pageCount}: ${error.message}`);
        }
    } while (pageToken); // Continue if there's a next page token

    console.log(`[user-list] Finished fetching users. Total users found: ${allUsers.length} across ${pageCount} page(s).`);

    // *** Return only essential fields (primaryEmail, id) ***
    console.log(`[user-list] Transforming ${allUsers.length} user objects to include only essential fields...`);
    const essentialUsers = allUsers.map(user => ({
      primaryEmail: user.primaryEmail,
      id: user.id
    }));

    return essentialUsers;

  } catch (error) {
    console.error(`[user-list] Task failed: ${error.message}`);
    console.error("Stack trace:", error.stack); // Log stack trace for better debugging
    // Ensure adminEmail value is logged if the error occurs after fetching it
    if (adminEmail) {
      console.error(`Admin email used during failure: ${adminEmail}`);
    }
    throw error; // Re-throw the error to ensure task failure is reported
  }
}; 