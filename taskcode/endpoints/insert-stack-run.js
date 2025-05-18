/**
 * @task insert-stack-run
 * @description Inserts a record into the stack_runs table
 * @param {object} input - The input object
 * @param {string} input.module_name - The name of the module
 * @param {string} input.method_name - The name of the method
 * @param {Array} input.args - The arguments to pass to the method
 * @returns {Promise<object>} - The inserted record
 */
module.exports = async function execute(input, { tools }) {
  console.log('[insert-stack-run] Starting with input:', JSON.stringify(input));
  
  if (!input || typeof input.module_name !== 'string' || typeof input.method_name !== 'string' || !Array.isArray(input.args)) {
    throw new Error("Input must be an object with 'module_name', 'method_name', and 'args' properties.");
  }
  
  try {
    console.log('[insert-stack-run] Inserting record into stack_runs table...');
    
    // Insert a record into the stack_runs table
    const { data, error } = await tools.supabase
      .from('stack_runs')
      .insert({
        id: crypto.randomUUID(),
        module_name: input.module_name,
        method_name: input.method_name,
        args: input.args,
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select();
    
    if (error) {
      console.error('[insert-stack-run] Error inserting record:', error);
      throw new Error(`Failed to insert record: ${error.message}`);
    }
    
    console.log('[insert-stack-run] Record inserted successfully:', JSON.stringify(data));
    
    return {
      success: true,
      data
    };
  } catch (error) {
    console.error(`[insert-stack-run] Error: ${error.message}`);
    throw new Error(`Failed to insert record: ${error.message}`);
  }
}
