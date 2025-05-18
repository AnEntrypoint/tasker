/**
 * @task query-stack-runs-fixed
 * @description Queries the stack_runs table using direct HTTP calls instead of Supabase client
 * @param {object} input - The input object
 * @param {number} [input.limit=10] - The maximum number of records to return
 * @returns {Promise<object>} - The query result
 */
module.exports = async function execute(input, { tools }) {
  console.log('[query-stack-runs-fixed] Starting with input:', JSON.stringify(input));
  
  const limit = input?.limit || 10;
  
  try {
    console.log(`[query-stack-runs-fixed] Querying stack_runs table with limit ${limit}...`);
    
    // Use the __hostFetch__ function if available (in QuickJS environment)
    if (typeof globalThis.__hostFetch__ === 'function' && typeof __runtimeConfig__ !== 'undefined') {
      console.log('[query-stack-runs-fixed] Using __hostFetch__ to query stack_runs table');
      
      const supabaseUrl = __runtimeConfig__.supabaseUrl || 'http://127.0.0.1:8000';
      const supabaseKey = __runtimeConfig__.supabaseAnonKey;
      
      const response = await globalThis.__hostFetch__(`${supabaseUrl}/rest/v1/stack_runs?select=*&order=created_at.desc&limit=${limit}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseKey}`,
          'apikey': supabaseKey
        }
      });
      
      if (!response || !Array.isArray(response)) {
        throw new Error('Invalid response from stack_runs table');
      }
      
      console.log(`[query-stack-runs-fixed] Found ${response.length} records`);
      
      return {
        success: true,
        count: response.length,
        data: response
      };
    }
    // Fall back to tools.supabase if __hostFetch__ is not available
    else if (tools && tools.supabase) {
      console.log('[query-stack-runs-fixed] Using tools.supabase to query stack_runs table');
      
      // Try using the from.select method directly
      try {
        const result = await tools.supabase.from('stack_runs').select('*').order('created_at', { ascending: false }).limit(limit);
        
        if (result.error) {
          throw new Error(`Database error: ${result.error.message}`);
        }
        
        console.log(`[query-stack-runs-fixed] Found ${result.data.length} records`);
        
        return {
          success: true,
          count: result.data.length,
          data: result.data
        };
      } catch (supabaseError) {
        console.error('[query-stack-runs-fixed] Error using Supabase client:', supabaseError);
        throw new Error(`Failed to query table using Supabase client: ${supabaseError.message}`);
      }
    } else {
      throw new Error('No suitable method available to query stack_runs table');
    }
  } catch (error) {
    console.error(`[query-stack-runs-fixed] Error: ${error.message}`);
    throw new Error(`Failed to query table: ${error.message}`);
  }
}
