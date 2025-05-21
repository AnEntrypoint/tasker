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

/**
 * Task to manually insert a test record into the stack_runs table
 * @param {Object} input - Input parameters
 * @param {string} input.service_name - Service name (e.g., 'tasks')
 * @param {string} input.method_name - Method name (e.g., 'execute')
 * @param {Array} input.args - Method arguments
 * @returns {Object} Result with inserted stack run ID
 */
export default async function insertStackRun(input) {
  console.log(`Inserting test stack run for ${input.service_name}.${input.method_name}`);
  
  // Default values if not provided
  const service = input.service_name || 'tasks';
  const method = input.method_name || 'execute';
  const args = input.args || ['hello-world', { name: 'Test User' }];
  
  try {
    // Insert a new record into stack_runs table
    const result = await tools.database.from('stack_runs')
      .insert({
        service_name: service,
        method_name: method,
        args: args,
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();
    
    console.log(`Stack run created with ID: ${result.data?.id}`);
    
    return {
      success: true,
      stack_run_id: result.data?.id,
      message: 'Stack run created successfully'
    };
  } catch (error) {
    console.error(`Error inserting stack run: ${error.message}`);
    
    return {
      success: false,
      error: error.message
    };
  }
}
