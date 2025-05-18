/**
 * @task stack-runs-query
 * @description Queries the stack_runs table using direct HTTP fetch
 * @param {object} input - The input object
 * @param {number} [input.limit=10] - The maximum number of records to return
 * @returns {Promise<object>} - The query result
 */
module.exports = async function execute(input, { tools }) {
  console.log('[stack-runs-query] Starting with input:', JSON.stringify(input));
  
  const limit = input?.limit || 10;
  
  try {
    console.log(`[stack-runs-query] Querying stack_runs table with limit ${limit}...`);
    
    // Use the fetch API directly
    const supabaseUrl = 'http://127.0.0.1:8000';
    const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
    
    const response = await fetch(`${supabaseUrl}/rest/v1/stack_runs?select=*&order=created_at.desc&limit=${limit}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseKey}`,
        'apikey': supabaseKey
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    console.log(`[stack-runs-query] Found ${data.length} records`);
    
    return {
      success: true,
      count: data.length,
      data
    };
  } catch (error) {
    console.error(`[stack-runs-query] Error: ${error.message}`);
    throw new Error(`Failed to query table: ${error.message}`);
  }
}
