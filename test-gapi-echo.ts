import { config } from 'https://deno.land/x/dotenv/mod.ts';

// Load environment variables
const env = config();

async function testEchoWithSdkFormat() {
  const url = "http://127.0.0.1:8000/functions/v1/wrappedgapi";
  console.log('Testing echo with SDK chain format...');
  
  // Setup the chain for echo
  const echoBody = {
    chain: [
      { type: "call", property: "echo", args: [{ message: "Hello from Tasker!" }] }
    ]
  };
  
  console.time('echo');
  
  try {
    const echoResponse = await fetch(url, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY || env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_ANON_KEY
      },
      body: JSON.stringify(echoBody)
    });
    
    console.timeEnd('echo');
    
    if (echoResponse.ok) {
      const echoData = await echoResponse.json();
      console.log('Echo response:', JSON.stringify(echoData, null, 2));
      console.log('\nTest successful! SDK wrapper works for echo.');
    } else {
      console.error('Echo failed:', echoResponse.status, echoResponse.statusText);
      const errorText = await echoResponse.text();
      console.error('Error details:', errorText);
    }
  } catch (error) {
    console.error('Error during echo test:', error);
  }
}

// Run the test
testEchoWithSdkFormat(); 