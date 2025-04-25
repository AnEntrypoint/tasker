import { config } from "https://deno.land/x/dotenv/mod.ts";
import { createServiceProxy } from 'npm:sdk-http-wrapper@1.0.10/client';

// Load environment variables
const env = config();

const GAPI_WRAPPER_URL = `${env.SUPABASE_URL}/functions/v1/wrappedgapi`;

// Create the GAPI service proxy
const gapi = createServiceProxy('gapi', { // Use 'gapi' as the service name, matching the server's sdkConfig
    baseUrl: GAPI_WRAPPER_URL,
    headers: {
      'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
      'apikey': env.SUPABASE_ANON_KEY, 
      // Content-Type is usually handled by the proxy for JSON
    }
});

// --- Function to get Customer ID ---
async function getCustomerId(): Promise<string> {
    console.log('\nFetching Customer ID...');
    try {
        const customerInfo = await gapi.admin.customers.get({ customerKey: 'my_customer' });
        const customerId = customerInfo?.id;
        if (customerId) {
            console.log(`Successfully fetched Customer ID: ${customerId}`);
            return customerId;
        } else {
            console.error('Could not find Customer ID in response:', JSON.stringify(customerInfo, null, 2));
            throw new Error('Customer ID not found in customers.get response.');
        }
    } catch (error) {
        console.error('Error fetching Customer ID:', error);
         if (typeof error === 'object' && error !== null && 'response' in error && 
            typeof error.response === 'object' && error.response !== null && 'data' in error.response) {
            console.error('Error details from proxy:', JSON.stringify((error.response as any).data, null, 2));
        }
        throw error; // Re-throw the error to stop execution if ID fetch fails
    }
}
// --- End Function ---

async function runTest() {
    await new Promise((resolve) => setTimeout(resolve, 3000));// do not remove this

  // --- Get Customer ID first ---
  let customerId: string;
  try {
      customerId = await getCustomerId();
  } catch (error) {
      console.error("Failed to get Customer ID, aborting user tests.");
      return; 
  }
  // --- End Get Customer ID ---

  console.log('\nTesting wrappedgapi via SDK Proxy (List Users)...');
  
  try {
    console.log('Calling gapi.admin.users.list via proxy with Customer ID...');
    // Note: The chain is gapi (proxy name) -> admin (instance in wrapper) -> users -> list
    const result = await gapi.admin.users.list({
        customer: customerId, // Use fetched Customer ID
        // domain: 'coas.co.za', // Use domain parameter instead
        maxResults: 5             
    });

    console.log('SDK Proxy response (users.list):');
    
    // Check the structure returned directly from the Google API
    if (result?.users && Array.isArray(result.users)) {
        if (result.users.length > 0) {
            console.log(`Successfully listed ${result.users.length} users.`);
            console.log(`First user email: ${result.users[0].primaryEmail}`); 
        } else {
            console.log('API call successful, but no users found in the domain.');
        }
    } else if (result?.kind === 'admin#directory#users') {
        // Handle case where kind exists but users array might be missing/empty
        console.log('API call successful, but no users array found or array is empty.');
        console.log('Full response data:', JSON.stringify(result, null, 2));
    } else {
        console.warn('API call successful, but unexpected data structure received.');
        console.log('Full response data:', JSON.stringify(result, null, 2));
    }

  } catch (error) {
    console.error('Error testing wrappedgapi (users.list) via SDK Proxy:', error);
    // sdk-http-wrapper throws errors directly, often including status and response body
    if (typeof error === 'object' && error !== null && 'response' in error && 
        typeof error.response === 'object' && error.response !== null && 'data' in error.response) {
        console.error('Error details from proxy:', JSON.stringify((error.response as any).data, null, 2));
    }
  }
}

async function runDomainTest() {
  // --- Get Customer ID first ---
  let customerId: string;
  try {
      customerId = await getCustomerId();
  } catch (error) {
      console.error("Failed to get Customer ID, aborting domain tests.");
      return; 
  }
  // --- End Get Customer ID ---

  console.log('\nTesting wrappedgapi via SDK Proxy (List Domains)...');

  try {
    console.log('Calling gapi.admin.domains.list via proxy with Customer ID...');
    // Chain: gapi -> admin -> domains -> list
    const result = await gapi.admin.domains.list({
        customer: customerId // Use fetched Customer ID
    });

    console.log('SDK Proxy response (domains.list):');

    if (result?.domains && Array.isArray(result.domains)) {
         if (result.domains.length > 0) {
            console.log(`Successfully listed ${result.domains.length} domain(s).`);
            console.log(`First domain: ${result.domains[0].domainName}`);
         } else {
             console.log('API call successful, but no domains found for this customer.');
         }
    } else if (result?.kind === 'admin#directory#domains') {
        console.log('API call successful, but no domains array found or array is empty.');
        console.log('Full response data:', JSON.stringify(result, null, 2));
    } else {
        console.warn('API call successful, but unexpected data structure received.');
        console.log('Full response data:', JSON.stringify(result, null, 2));
    }

  } catch (error) {
    console.error('Error testing wrappedgapi (domains.list) via SDK Proxy:', error);
    if (typeof error === 'object' && error !== null && 'response' in error && 
        typeof error.response === 'object' && error.response !== null && 'data' in error.response) {
        console.error('Error details from proxy:', JSON.stringify((error.response as any).data, null, 2));
    }
  }
}

// Run both tests
// Run tests sequentially to avoid potential issues with concurrent ID fetching if needed later
await runTest();
await runDomainTest(); // Re-enable domain test 