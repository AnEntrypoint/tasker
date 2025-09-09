// Simple test to check keystore credentials
const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

async function checkKeystore() {
  try {
    console.log('🔑 Checking keystore credentials...');
    
    const response = await fetch(`${SUPABASE_URL}/functions/v1/wrappedkeystore`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        action: 'listKeys'
      })
    });

    if (!response.ok) {
      console.error('❌ Keystore request failed:', response.status, response.statusText);
      const text = await response.text();
      console.error('Response:', text);
      return;
    }

    const result = await response.json();
    console.log('✅ Keystore response:', JSON.stringify(result, null, 2));
    
    // Check for required keys
    const requiredKeys = ['GAPI_KEY', 'GAPI_ADMIN_EMAIL'];
    for (const key of requiredKeys) {
      if (Array.isArray(result) && result.includes(key)) {
        console.log(`✅ Found required key: ${key}`);
      } else {
        console.log(`❌ Missing required key: ${key}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error checking keystore:', error.message);
  }
}

checkKeystore();
