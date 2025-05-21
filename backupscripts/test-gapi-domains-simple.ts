// Simple test for Google Admin API domains.list operation
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

async function testDomainsList() {
  console.log('Testing domains list with direct SDK format...');
  
  try {
    // Step 1: Check credentials
    console.log('Step 1: Getting admin email from credentials...');
    const credsResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedgapi", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        method: "checkCredentials"
      })
    });

    if (!credsResponse.ok) {
      throw new Error(`Failed to check credentials: ${credsResponse.status}`);
    }
    
    const creds = await credsResponse.json();
    console.log(`Admin email (cached): ${creds.adminEmail}`);
    console.log(`Service account: ${creds.clientEmail}`);
    
    // Step 2: Test domains.list operation
    console.log('\nStep 2: Testing domains.list with "my_customer"...');
    console.time('domains-list');
    const domainsResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedgapi", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        chain: [
          { type: "get", property: "admin" },
          { type: "get", property: "domains" },
          { type: "call", property: "list", args: [{ customer: "my_customer" }] }
        ]
      })
    });
    console.timeEnd('domains-list');
    
    if (domainsResponse.ok) {
      const domainsData = await domainsResponse.json();
      console.log(`Success! Found ${domainsData.domains?.length || 0} domains:`);
      
      if (domainsData.domains?.length) {
        domainsData.domains.forEach((domain: any, i: number) => {
          console.log(`  ${i+1}. ${domain.domainName} (${domain.verified ? 'verified' : 'unverified'})`);
        });
      }
      
      console.log("\n✅ Test completed successfully!");
    } else {
      console.log(`Domains list failed: ${domainsResponse.status}`);
      
      try {
        const errorText = await domainsResponse.text();
        console.log('\n=== DIAGNOSTICS ===');
        console.log('1. Status code indicates an error occurred on the Google API side');
        console.log('2. Common causes of this error:');
        console.log('   - The service account doesn\'t have Google Admin SDK API permissions');
        console.log('   - The domain-wide delegation is not set up correctly');
        console.log('   - The admin email doesn\'t have Google Workspace domain access');
        console.log('   - The admin email might not be a valid Google Workspace administrator');
        
        console.log('\n3. Solutions:');
        console.log('   - Check that the service account has Admin SDK API enabled in Google Cloud Console');
        console.log('   - Verify that domain-wide delegation is enabled for the service account');
        console.log('   - Make sure the service account has been granted access to the Google Workspace domain');
        console.log('   - Update the GAPI_ADMIN_EMAIL in the keystore with a valid admin email');
        console.log('Error details:', errorText);
      } catch (e) {
        console.log('Could not read error details');
      }
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

testDomainsList(); 