/**
 * @task query-stack-runs
 * @description Queries the stack_runs table
 * @param {object} input - The input object
 * @param {number} [input.limit=10] - The maximum number of records to return
 * @returns {Promise<object>} - The query result
 */
module.exports = async function execute(input, { tools }) {
  console.log('[query-stack-runs] Starting with input:', JSON.stringify(input));
  
  const limit = input?.limit || 10;
  
  try {
    console.log(`[query-stack-runs] Querying stack_runs table with limit ${limit}...`);
    
    // Query the stack_runs table
    const { data, error } = await tools.supabase
      .from('stack_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (error) {
      console.error('[query-stack-runs] Error querying table:', error);
      throw new Error(`Failed to query table: ${error.message}`);
    }
    
    console.log(`[query-stack-runs] Found ${data.length} records`);
    
    return {
      success: true,
      count: data.length,
      data
    };
  } catch (error) {
    console.error(`[query-stack-runs] Error: ${error.message}`);
    throw new Error(`Failed to query table: ${error.message}`);
  }
}
