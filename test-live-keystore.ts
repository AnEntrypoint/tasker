// Test the live WrappedKeystore service
import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";
import { config } from "https://deno.land/x/dotenv/mod.ts";

// Load environment variables
const env = config();

console.log('Environment variables:');
console.log('Using production Supabase instance:');
console.log('EXT_SUPABASE_URL:', env.EXT_SUPABASE_URL);

// Create keystore service proxy with production URL
const keystore = createServiceProxy('keystore', {
  baseUrl: `${env.SUPABASE_URL}/functions/v1/wrappedkeystore`,
  headers: {
    'Authorization': `Bearer ${env.EXT_SUPABASE_SERVICE_ROLE_KEY}`,
    'apikey': env.SUPABASE_ANON_KEY
  }
});

async function testServiceProxy() {
  console.log('\n=== Testing SDK Service Proxy Format ===');
  
  try {
    // Test server time
    console.log('\n1. Getting server time...');
    const time = await keystore.getServerTime();
    console.log('Server time:', time);
    
    // Test namespace operations
    console.log('\n2. Listing namespaces...');
    const namespaces = await keystore.listNamespaces();
    console.log('Namespaces:', namespaces);
    
    // Test key operations
    const namespace = 'test';
    const testKey = `test-key-${Date.now()}`;
    const testValue = `test-value-${Date.now()}`;
    
    console.log(`\n3. Setting key "${testKey}" in namespace "${namespace}"...`);
    const setResult = await keystore.setKey(namespace, testKey, testValue);
    console.log('Set key result:', setResult);
    
    console.log(`\n4. Getting key "${testKey}" from namespace "${namespace}"...`);
    const getValue = await keystore.getKey(namespace, testKey);
    console.log('Get key value:', getValue);
    
    console.log(`\n5. Listing keys in namespace "${namespace}"...`);
    const keys = await keystore.listKeys(namespace);
    console.log(`Keys in ${namespace}:`, keys);
    
    // Test concurrent operations
    console.log('\n6. Testing concurrent operations...');
    const [time2, keys2] = await Promise.all([
      keystore.getServerTime(),
      keystore.listKeys(namespace)
    ]);
    console.log('Concurrent results:', { time2, keysCount: keys2.length });
  } catch (error) {
    console.error('Error in service proxy tests:', error);
  }
}

async function testKeystore() {
  await new Promise((resolve) => setTimeout(resolve, 4000));
  console.log('=== Testing Live Keystore Service (PRODUCTION) ===');
  console.log('Testing with SDK-HTTP-Wrapper and direct action format');
  
  try {
    // Test with service proxy (SDK format)
    await testServiceProxy();
    
    console.log('\n=== Keystore Tests Complete ===');
  } catch (error) {
    console.error('Error in keystore tests:', error);
  }
}

await testKeystore();