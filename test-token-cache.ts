// Test token caching in wrappedgapi
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

/**
 * This test verifies that token caching is working properly by:
 * 1. Fetching token info (should be empty initially)
 * 2. Making a domains.list call (generates token)
 * 3. Checking token info again (should have token)
 * 4. Making a second domains.list call (should use cached token)
 */
async function testTokenCaching() {
  console.log('Testing token caching in wrappedgapi\n');
  
  try {
    // Step 1: Check token cache status
    console.log('1. Checking initial token cache...');
    const initialCacheResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedgapi", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        method: "getTokenInfo"
      })
    });

    if (initialCacheResponse.ok) {
      const initialCache = await initialCacheResponse.json();
      console.log(`Initial token cache: ${initialCache.count} tokens\n`);
    } else {
      console.error(`Failed to get token info: ${initialCacheResponse.status}`);
    }

    // Step 2: Make first call (should generate token)
    console.log('2. Making first domains.list call (should generate token)...');
    console.time('first-call');
    const firstCallResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedgapi", {
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
    console.timeEnd('first-call');

    // Step 3: Check token cache status again
    console.log('\n3. Checking token cache after first call...');
    const midCacheResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedgapi", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        method: "getTokenInfo"
      })
    });

    if (midCacheResponse.ok) {
      const midCache = await midCacheResponse.json();
      console.log(`Token cache after first call: ${midCache.count} tokens`);
      if (midCache.tokens?.length) {
        console.log(`Token scope: ${midCache.tokens[0].scope}`);
        console.log(`Token expires: ${midCache.tokens[0].expires}`);
        console.log(`Token valid: ${midCache.tokens[0].valid}\n`);
      }
    }

    // Step 4: Make second call (should use cached token)
    console.log('4. Making second domains.list call (should use cached token)...');
    console.time('second-call');
    const secondCallResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedgapi", {
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
    console.timeEnd('second-call');

    // Compare response times
    console.log('\nResults:');
    if (firstCallResponse.ok && secondCallResponse.ok) {
      console.log('✅ Both API calls succeeded');
      
      // Get the actual domains data from the second call
      const domainsData = await secondCallResponse.json();
      console.log(`\nFound ${domainsData.domains?.length || 0} domains:`);
      if (domainsData.domains?.length) {
        domainsData.domains.forEach((domain: any, i: number) => {
          console.log(`  ${i+1}. ${domain.domainName} (${domain.verified ? 'verified' : 'unverified'})`);
        });
      }
    } else {
      if (!firstCallResponse.ok) {
        console.error(`❌ First call failed: ${firstCallResponse.status}`);
        try {
          const errorText = await firstCallResponse.text();
          console.error('Error details:', errorText);
        } catch (e) {}
      }
      
      if (!secondCallResponse.ok) {
        console.error(`❌ Second call failed: ${secondCallResponse.status}`);
        try {
          const errorText = await secondCallResponse.text();
          console.error('Error details:', errorText);
        } catch (e) {}
      }
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

testTokenCaching(); 