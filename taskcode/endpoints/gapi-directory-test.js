/**
 * Fetches all users (email and name) from all domains associated with the Google Workspace customer.
 *
 * @param {Object} input - Input object (currently unused)
 * @returns {Promise<Array<Object>>} A list of user objects, each containing { email, name }.
 */
module.exports = async function(input = {}) {
  console.log('[gapi-directory-all-users] Task started.');

  let customerId = null;
  const allUsers = [];
  let domains = [];

  // --- 1. Get Customer ID ---
  try {
    console.log('[gapi-directory-all-users] Fetching Customer ID...');
    const customerInfo = await tools.gapi.admin.customers.get({ customerKey: 'my_customer' });
    customerId = customerInfo?.id;
    if (customerId) {
      console.log(`[gapi-directory-all-users] Successfully fetched Customer ID: ${customerId}`);
    } else {
      console.error('[gapi-directory-all-users] Could not find Customer ID in response:', customerInfo);
      throw new Error('Customer ID not found in customers.get response.');
    }
  } catch (error) {
    console.error(`[gapi-directory-all-users] Error fetching Customer ID: ${error.message || error}`);
    throw new Error(`Failed to get Customer ID: ${error.message || error}`);
  }

  // --- 2. List Domains ---
  try {
    console.log('[gapi-directory-all-users] Listing domains...');
    const domainsResult = await tools.gapi.admin.domains.list({
      customer: customerId
    });
    if (domainsResult?.domains && domainsResult.domains.length > 0) {
      domains = domainsResult.domains;
      console.log(`[gapi-directory-all-users] Found ${domains.length} domain(s): ${domains.map(d => d.domainName).join(', ')}`);
    } else {
      console.warn('[gapi-directory-all-users] No domains found for this customer.');
      // If no domains, there are no users to fetch
      return []; 
    }
  } catch (error) {
    console.error(`[gapi-directory-all-users] Error listing domains: ${error.message || error}`);
    throw new Error(`Failed to list domains: ${error.message || error}`);
  }

  // --- 3. Iterate through domains and list users with pagination ---
  for (const domain of domains) {
    const domainName = domain.domainName;
    console.log(`[gapi-directory-all-users] Fetching users for domain: ${domainName}...`);
    let pageToken = null;
    let pageCount = 0;
    let domainUserCount = 0;

    try {
        do {
            pageCount++;
            console.log(`[gapi-directory-all-users] Fetching page ${pageCount} for domain ${domainName} (pageToken: ${pageToken ? '...' : 'null'})`);
            const usersResult = await tools.gapi.admin.users.list({
                customer: customerId,
                domain: domainName, 
                pageToken: pageToken, // Pass the token for subsequent pages
                maxResults: 500, // Fetch max allowed per page
                orderBy: 'email' // Consistent ordering helps pagination
            });

            if (usersResult?.users && usersResult.users.length > 0) {
                const users = usersResult.users;
                domainUserCount += users.length;
                console.log(`[gapi-directory-all-users] Found ${users.length} users on page ${pageCount} for domain ${domainName}.`);
                users.forEach(user => {
                    if (user.primaryEmail && user.name?.fullName) {
                        allUsers.push({ 
                            email: user.primaryEmail, 
                            name: user.name.fullName 
                        });
                    } else {
                         console.warn(`[gapi-directory-all-users] Skipping user with missing email or name in domain ${domainName}:`, user);
                    }
                });
            }

            pageToken = usersResult?.nextPageToken; // Get token for the next page

        } while (pageToken);
        console.log(`[gapi-directory-all-users] Finished fetching users for domain ${domainName}. Total found: ${domainUserCount}.`);

    } catch (error) {
        console.error(`[gapi-directory-all-users] Error listing users for domain ${domainName}: ${error.message || error}`);
        // Log error but continue to the next domain
    }
  }

  console.log(`[gapi-directory-all-users] Task finished. Total users collected across all domains: ${allUsers.length}`);

  // Return the consolidated list of users
  return allUsers;
}; 