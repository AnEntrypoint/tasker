/**
 * @task gapi-list-domains
 * @description Fetches the list of domains for the Google Workspace account using credentials from the keystore.
 * @returns {Promise<Array<object>>} - An array of domain objects returned by the Google Admin SDK.
 * @throws {Error} If required tools (gapi, keystore) are unavailable or if API calls fail.
 */
module.exports = async function execute(input = {}, { tools }) {
    console.log('[gapi-list-domains] Task started.');
    const startTime = Date.now();

    // Check for required tools
    if (!tools?.gapi?.admin?.domains?.list) {
        throw new Error("[gapi-list-domains] 'tools.gapi.admin.domains.list' is not available.");
    }
    if (!tools?.keystore?.getKey) {
        // Fallback or error if keystore tool is missing? For now, assume it exists.
        // We could potentially implement the direct fetch logic here as a fallback,
        // but keeping it clean assumes the tool is provided.
        throw new Error("[gapi-list-domains] 'tools.keystore.getKey' is not available.");
    }

    let adminEmail;
    console.log('[gapi-list-domains] Fetching GAPI_ADMIN_EMAIL from keystore...');
    // Assuming tools.keystore.getKey returns the raw value directly (handles double parsing internally if needed)
    const emailResult = await tools.keystore.getKey('global', 'GAPI_ADMIN_EMAIL');
    if (typeof emailResult !== 'string' || !emailResult) {
        throw new Error(`Expected a non-empty string for admin email, but got: ${typeof emailResult}`);
    }
    adminEmail = emailResult.trim();
    console.log('[gapi-list-domains] Fetched admin email successfully.');

    // NOTE: We don't need to fetch the GAPI_KEY here because we assume `tools.gapi`
    // is already configured/authenticated, potentially using that key behind the scenes.
    // The main purpose of fetching the admin email is for impersonation.

    console.log(`[gapi-list-domains] Listing domains, impersonating ${adminEmail}...`);
    const response = await tools.gapi.admin.domains.list({
        customer: 'my_customer', // Required parameter for domains.list
        __impersonate: adminEmail // Use the fetched email for impersonation
    });

    if (!response || !Array.isArray(response.domains)) {
        console.error('[gapi-list-domains] Invalid response format received from domains.list:', response);
        throw new Error('Invalid response format from domains.list API call.');
    }

    const duration = (Date.now() - startTime) / 1000;
    console.log(`[gapi-list-domains] Successfully listed ${response.domains.length} domains in ${duration.toFixed(2)} seconds.`);
    return response.domains; // Return the array of domain objects

}; 