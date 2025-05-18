/**
 * @task task-runs-insert
 * @description Inserts records into the task_runs table
 * @param {object} input - The input object
 * @param {string} input.taskName - The name of the task to insert
 * @param {object} input.args - The arguments for the task
 * @param {string} input.status - The status of the task (default: 'completed')
 * @param {object} input.result - The result of the task (optional)
 * @returns {Promise<object>} - The inserted record
 */
module.exports = async function execute(input, { tools }) {
  console.log('[task-runs-insert] Starting with input:', JSON.stringify(input));
  
  if (!input || typeof input.taskName !== 'string') {
    throw new Error("Input must be an object with a 'taskName' property of type string.");
  }
  
  const taskName = input.taskName;
  const args = input.args || {};
  const status = input.status || 'completed';
  const result = input.result || null;
  
  console.log(`[task-runs-insert] Inserting record for task: ${taskName}`);
  console.log(`[task-runs-insert] Args:`, JSON.stringify(args));
  console.log(`[task-runs-insert] Status: ${status}`);
  console.log(`[task-runs-insert] Result:`, result ? JSON.stringify(result) : 'null');
  
  // Check if Supabase tools are available
  if (!tools || !tools.supabase) {
    throw new Error("The 'tools.supabase' object is not available in the environment.");
  }
  
  try {
    console.log('[task-runs-insert] Inserting record into task_runs table...');
    
    // Insert the record
    const { data, error } = await tools.supabase
      .from('task_runs')
      .insert({
        name: taskName,
        args: args,
        status: status,
        result: result,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select();
    
    if (error) {
      console.error(`[task-runs-insert] Error inserting record: ${error.message}`);
      throw new Error(`Failed to insert record into task_runs table: ${error.message}`);
    }
    
    console.log('[task-runs-insert] Record inserted successfully:', data);
    
    // Query the task_runs table to verify the record was inserted
    console.log('[task-runs-insert] Querying task_runs table...');
    
    const { data: queryData, error: queryError } = await tools.supabase
      .from('task_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);
    
    if (queryError) {
      console.error(`[task-runs-insert] Error querying task_runs table: ${queryError.message}`);
    } else {
      console.log(`[task-runs-insert] Found ${queryData.length} records in task_runs table`);
    }
    
    return {
      success: true,
      insertedRecord: data,
      recentRecords: queryData
    };
  } catch (error) {
    console.error(`[task-runs-insert] Error: ${error.message}`);
    throw error;
  }
}
