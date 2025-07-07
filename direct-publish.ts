#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env

import * as path from "https://deno.land/std@0.201.0/path/mod.ts";

console.log("===== DIRECT PUBLISH SCRIPT STARTED =====");

try {
  const taskName = "test-basic-execution";
  console.log(`Task name: ${taskName}`);
  
  const basePath = Deno.cwd();
  console.log(`Current working directory: ${basePath}`);
  
  const taskPath = `${basePath}/taskcode/endpoints/${taskName}.js`;
  console.log(`Full task path: ${taskPath}`);
  
  // Check if file exists
  try {
    const fileInfo = await Deno.stat(taskPath);
    console.log(`File exists: ${fileInfo.isFile}`);
    console.log(`File size: ${fileInfo.size} bytes`);
  } catch (e) {
    console.error(`Error checking file: ${e instanceof Error ? e.message : String(e)}`);
    throw new Error(`File check failed: ${taskPath}`);
  }
  
  // Read file content
  let fileContent;
  try {
    fileContent = await Deno.readTextFile(taskPath);
    console.log(`File content length: ${fileContent.length} chars`);
  } catch (e) {
    console.error(`Error reading file: ${e instanceof Error ? e.message : String(e)}`);
    throw new Error(`File read failed: ${taskPath}`);
  }
  
  // Prepare payload
  const payload = {
    name: taskName,
    code: fileContent,
    description: `Task: ${taskName}`
  };
  
  console.log("Payload prepared, calling Supabase API...");
  
  // Send to Supabase
  try {
    const response = await fetch("http://127.0.0.1:8000/rest/v1/task_functions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"}`,
        "apikey": Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
        "Prefer": "resolution=merge-duplicates"
      },
      body: JSON.stringify(payload)
    });
    
    console.log(`Response status: ${response.status} ${response.statusText}`);
    
    if (response.ok) {
      console.log(`Task ${taskName} published successfully!`);
    } else if (response.status === 409) {
      // Task exists, try to update it
      console.log("Task exists, attempting to update...");
      const updateResponse = await fetch(`http://127.0.0.1:8000/rest/v1/task_functions?name=eq.${taskName}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"}`,
          "apikey": Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
        },
        body: JSON.stringify({ code: fileContent, description: `Task: ${taskName}` })
      });
      
      console.log(`Update response status: ${updateResponse.status} ${updateResponse.statusText}`);
      
      if (updateResponse.ok) {
        console.log(`Task ${taskName} updated successfully!`);
      } else {
        const updateErrorText = await updateResponse.text();
        console.error(`Update error: ${updateErrorText}`);
      }
    } else {
      const errorText = await response.text();
      console.error(`API error: ${errorText}`);
    }
  } catch (e) {
    console.error(`Network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  
  console.log("===== DIRECT PUBLISH SCRIPT COMPLETED =====");
} catch (error) {
  console.error(`===== SCRIPT ERROR: ${error instanceof Error ? error.message : String(error)} =====`);
} 