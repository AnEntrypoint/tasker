import { config } from 'https://deno.land/x/dotenv/mod.ts';

// Load environment variables
const env = config();

async function testDomainsDirectly() {
  await new Promise(res=>setTimeout(res, 6000))
  const url = "http://127.0.0.1:8000/functions/v1/wrappedgapi";
  console.log('Running domains list test directly without SDK wrapper...');

  // First, get admin email from credentials check
  console.log('Step 1: Getting admin email from credentials check...');
  const credentialRes = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "checkCredentials",
      args: []
    })
  });
  
  if (!credentialRes.ok) {
    console.error('Credential check failed:', credentialRes.status, credentialRes.statusText);
    return;
  }
  
  const credentials = await credentialRes.json();
  const adminEmail = credentials.adminEmail;
  console.log(`Admin email (will use as customer ID): ${adminEmail}`);
  
  // Step 2: Call domains.list directly
  console.log('\nStep 2: Testing domains.list directly...');
  const domainsBody = {
    chain: [
      { type: "get", property: "admin" },
      { type: "get", property: "domains" },
      { type: "call", property: "list", args: [{ customer: adminEmail }] }
    ]
  };
  
  console.time('domains.list');
  
  try {
    const domainsResponse = await fetch(url, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_ANON_KEY
      },
      body: JSON.stringify(domainsBody)
    });
    
    console.timeEnd('domains.list');
    
    if (domainsResponse.ok) {
      const domainsData = await domainsResponse.json();
      console.log('Domains list response:', JSON.stringify(domainsData, null, 2));
      console.log('\nTest successful! Direct Google API connectivity confirmed.');
    } else {
      console.error('Domains list failed:', domainsResponse.status, domainsResponse.statusText);
      const errorText = await domainsResponse.text();
      console.error('Error details:', errorText);
    }
  } catch (error) {
    console.error('Error during domains list test:', error);
  }
}

// Run the test
testDomainsDirectly(); 