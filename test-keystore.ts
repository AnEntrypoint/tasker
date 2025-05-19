// Test direct keystore access
import { config } from 'https://deno.land/x/dotenv/mod.ts';
const env = config();

async function testKeystoreAccess() {
  console.log('Testing direct keystore access...');
  
  try {
    const response = await fetch("http://127.0.0.1:8000/functions/v1/wrappedkeystore", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        action: "getKey",
        namespace: "global",
        key: "GAPI_KEY"
      })
    });

    if (response.ok) {
      const result = await response.text();
      console.log(`SUCCESS! Got response with length: ${result.length}`);
      console.log('Response content type:', response.headers.get('content-type'));
      console.log('First 500 chars of raw response:');
      console.log(result.substring(0, 500) + (result.length > 500 ? '...' : ''));
      
      // Try to determine the format of the response
      console.log('\nAnalyzing response format:');
      console.log(`- Starts with " and ends with ": ${result.startsWith('"') && result.endsWith('"')}`);
      console.log(`- Starts with [ and ends with ]: ${result.startsWith('[') && result.endsWith(']')}`);
      console.log(`- Starts with { and ends with }: ${result.startsWith('{') && result.endsWith('}')}`);
      console.log(`- Contains quotes: ${result.includes('"')}`);
      console.log(`- Number of opening braces: ${(result.match(/\{/g) || []).length}`);
      console.log(`- Number of closing braces: ${(result.match(/\}/g) || []).length}`);
      console.log(`- Number of opening brackets: ${(result.match(/\[/g) || []).length}`);
      console.log(`- Number of closing brackets: ${(result.match(/\]/g) || []).length}`);
      
      // Try different parsing approaches
      console.log('\nTrying different parsing approaches:');
      
      try {
        // 1. Direct JSON parse
        const directParse = JSON.parse(result);
        console.log('1. Direct JSON parse succeeded:');
        console.log('- Type:', typeof directParse);
        console.log('- Is array:', Array.isArray(directParse));
        console.log('- Keys:', Object.keys(directParse).slice(0, 10));
        console.log('- Has client_email:', 'client_email' in directParse);
        console.log('- Has private_key:', 'private_key' in directParse);
      } catch (e) {
        console.log('1. Direct JSON parse failed:', (e as Error).message);
      }
      
      try {
        // 2. Parse as JSON with value field
        if (result.includes('"value"')) {
          const valueObj = JSON.parse(result);
          console.log('2. Value field parse:');
          console.log('- Has value field:', 'value' in valueObj);
          if ('value' in valueObj) {
            try {
              const valueContent = JSON.parse(valueObj.value);
              console.log('- Value content parsed as JSON');
              console.log('- Value has client_email:', 'client_email' in valueContent);
              console.log('- Value has private_key:', 'private_key' in valueContent);
            } catch {
              console.log('- Value content is not JSON');
            }
          }
        } else {
          console.log('2. No value field found in response');
        }
      } catch (e) {
        console.log('2. Value field parse failed:', (e as Error).message);
      }
      
      try {
        // 3. Parse as JSON string (double-quoted JSON)
        if (result.startsWith('"') && result.endsWith('"')) {
          const unquoted = JSON.parse(result);
          try {
            const parsedUnquoted = JSON.parse(unquoted);
            console.log('3. Double-quoted JSON parse:');
            console.log('- Type:', typeof parsedUnquoted);
            console.log('- Is array:', Array.isArray(parsedUnquoted));
            console.log('- Has client_email:', 'client_email' in parsedUnquoted);
            console.log('- Has private_key:', 'private_key' in parsedUnquoted);
          } catch (e) {
            console.log('3. Unquoted content is not valid JSON:', (e as Error).message);
          }
        } else {
          console.log('3. Not a double-quoted JSON string');
        }
      } catch (e) {
        console.log('3. Double-quoted JSON parse failed:', (e as Error).message);
      }
      
      // Also test for admin email
      console.log('\nTesting admin email access...');
      const adminResponse = await fetch("http://127.0.0.1:8000/functions/v1/wrappedkeystore", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
          'apikey': env.SUPABASE_ANON_KEY
        },
        body: JSON.stringify({
          action: "getKey",
          namespace: "global",
          key: "GAPI_ADMIN_EMAIL"
        })
      });
      
      if (adminResponse.ok) {
        const adminResult = await adminResponse.text();
        console.log(`Admin email response (${adminResult.length} chars):`);
        console.log(`Raw: "${adminResult}"`);
        console.log(`Starts with double quote: ${adminResult.startsWith('"')}`);
        console.log(`Ends with double quote: ${adminResult.endsWith('"')}`);
        
        try {
          const parsedEmail = JSON.parse(adminResult);
          console.log(`Parsed as JSON: "${parsedEmail}"`);
        } catch (e) {
          console.log('Admin email is not JSON-encoded');
        }
      } else {
        console.error(`Admin email request failed: ${adminResponse.status}`);
      }
    } else {
      console.error(`Failed: ${response.status}`);
      try {
        const errorText = await response.text();
        console.error('Error details:', errorText);
      } catch (e) {
        console.error('Could not read error details');
      }
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

testKeystoreAccess(); 