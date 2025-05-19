// Basic test for direct GAPI connectivity
// This avoids the SDK wrapper to simplify troubleshooting

async function testGapiEndpoint() {
  const url = "http://127.0.0.1:8000/functions/v1/wrappedgapi/health";
  console.log(`Testing health endpoint at ${url}`);
  
  try {
    const response = await fetch(url);
    console.log(`Status: ${response.status} ${response.statusText}`);
    const data = await response.json();
    console.log("Health response:", data);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error testing health endpoint:", errorMessage);
  }
  
  // Try direct credential check with POST
  const checkUrl = "http://127.0.0.1:8000/functions/v1/wrappedgapi";
  console.log(`\nTesting credential check at ${checkUrl}`);
  
  try {
    const response = await fetch(checkUrl, {
      method: "POST", 
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "checkCredentials",
        args: []
      })
    });
    
    console.log(`Status: ${response.status} ${response.statusText}`);
    
    if (response.ok) {
      const data = await response.json();
      console.log("Credential check response:", JSON.stringify(data, null, 2));
    } else {
      console.error("Credential check failed with status:", response.status);
      try {
        const errorText = await response.text();
        console.error("Error details:", errorText);
      } catch {
        console.error("Could not read error details");
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error checking credentials:", errorMessage);
  }
  
  // Test echo functionality
  console.log("\nTesting echo functionality...");
  try {
    const echoResponse = await fetch(checkUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "echo",
        args: [{ message: "Hello from direct test!" }]
      })
    });
    
    console.log(`Status: ${echoResponse.status} ${echoResponse.statusText}`);
    
    if (echoResponse.ok) {
      const data = await echoResponse.json();
      console.log("Echo response:", JSON.stringify(data, null, 2));
    } else {
      console.error("Echo failed with status:", echoResponse.status);
      try {
        const errorText = await echoResponse.text();
        console.error("Error details:", errorText);
      } catch {
        console.error("Could not read error details");
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error during echo test:", errorMessage);
  }
}

// Execute test
testGapiEndpoint(); 