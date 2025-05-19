// Minimal test that just checks credentials without API calls

async function testGapiMinimal() {
  await new Promise(res=>setTimeout(res, 3000))
  const url = "http://127.0.0.1:8000/functions/v1/wrappedgapi";
  console.log('Minimal GAPI connectivity test');
  
  // Simple echo test - should be fast
  try {
    console.log('\nStep 1: Testing echo (basic connectivity)');
    const echoResponse = await fetch(url, {
      method: "POST", 
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "echo",
        args: [{ message: "Hello GAPI!" }]
      }),
      signal: AbortSignal.timeout(5000) // 5 second timeout
    });
    
    if (echoResponse.ok) {
      const data = await echoResponse.json();
      console.log("Echo successful:", data);
    } else {
      console.error("Echo failed:", echoResponse.status);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Echo request failed:", errorMessage);
  }

  // Try minimal credential check
  try {
    console.log('\nStep 2: Checking credentials (no API auth)');
    const credResponse = await fetch(url, {
      method: "POST", 
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "checkCredentials",
        args: []
      }),
      signal: AbortSignal.timeout(10000) // 10 second timeout
    });
    
    if (credResponse.ok) {
      const data = await credResponse.json();
      console.log("Credential check successful. Summary:");
      console.log("- GAPI_ADMIN_EMAIL exists:", data.adminEmailExists);
      console.log("- GAPI_KEY exists:", data.gapiKeyExists);
      console.log("- Credentials format OK:", data.credentialsOk);
      console.log("- Client email:", data.clientEmail);
    } else {
      console.error("Credential check failed:", credResponse.status);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Credential check failed:", errorMessage);
  }
}

testGapiMinimal(); 