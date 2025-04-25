        // Try to determine Customer ID by fetching the admin user's details
        try {
            log(`Attempting to fetch user info for: ${adminEmail}`);
            const userInfoResponse = await tools.gapi.admin.users.get({ userKey: adminEmail }, { __impersonate: adminEmail });
            logDebug(`User info response received`);
            if (userInfoResponse) {
                customerId = userInfoResponse.customerId;
                if (customerId) {
                    log(`Found Customer ID: ${customerId}`);
                } else {
                    logError(`Could not find Customer ID in user info response`);
                    throw new Error(`Customer ID not found in users.get response for userKey: ${adminEmail}.`);
                }
            } else {
                logError(`Did not receive a valid response from users.get for userKey: ${adminEmail}`);
                throw new Error(`Failed to get user info for ${adminEmail}.`);
            }
        } catch (error) {
            logError(`Failed to determine Customer ID: ${error.message || error}`);
            throw new Error(`Failed to determine Customer ID: ${error.message || error}`);
        }
    }

    // Ensure customerId was determined before proceeding
    if (!customerId) {
        logError('Cannot proceed without a valid Customer ID.');
        throw new Error('Cannot proceed without a valid Customer ID.');
    }

    // Now use the customerId to list domains and users
    log(`Using Customer ID: ${customerId} to list domains and users.`);

    // List Domains
    try {
        log('Listing domains...');
        const domainsResponse = await tools.gapi.admin.domains.list({ customer: customerId });
        logDebug('Domains response');
        if (domainsResponse && domainsResponse.domains) {
            log('Domains found');
        } else {
            logWarn('No domains found or domains property missing in response.');
        }
    } catch (error) {
        logError(`Failed to list domains: ${error.message || error}`);
    }

    // List Users
    try {
        log('Listing users...');
        const usersResponse = await tools.gapi.admin.users.list({ customer: customerId, maxResults: 10 });
        logDebug('Users response');
        if (usersResponse && usersResponse.users) {
            log('Users (first 10) found');
        } else {
            logWarn('No users found or users property missing in response.');
        }
    } catch (error) {
        logError(`Failed to list users: ${error.message || error}`);
    }

    return { success: true, message: 'Successfully listed domains and users.', customerId: customerId };
}; 