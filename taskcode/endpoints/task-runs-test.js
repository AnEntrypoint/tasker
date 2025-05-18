/**
 * @task task-runs-test
 * @description Tests writing to the task_runs table
 * @param {object} input - The input object
 * @param {string} input.message - A test message
 * @returns {Promise<object>} - The result of the test
 */
module.exports = async function execute(input, { tools }) {
  console.log('[task-runs-test] Starting with input:', JSON.stringify(input));
  
  if (!input || typeof input.message !== 'string') {
    throw new Error("Input must be an object with a 'message' property of type string.");
  }
  
  const message = input.message;
  console.log(`[task-runs-test] Message: ${message}`);
  
  // Check if Supabase tools are available
  if (!tools || !tools.supabase) {
    console.error('[task-runs-test] Supabase tools not available');
    return {
      success: false,
      error: 'Supabase tools not available',
      message
    };
  }
  
  try {
    console.log('[task-runs-test] Checking if task_runs table exists...');
    
    // Try to query the task_runs table
    const { data: taskRunsData, error: taskRunsError } = await tools.supabase
      .from('task_runs')
      .select('id')
      .limit(1);
    
    if (taskRunsError) {
      console.error(`[task-runs-test] Error querying task_runs table: ${taskRunsError.message}`);
      
      // If the table doesn't exist, try to create it
      if (taskRunsError.message.includes('relation "public.task_runs" does not exist')) {
        console.log('[task-runs-test] task_runs table does not exist, creating it...');
        
        // Create the task_runs table
        const createTableSQL = `
          CREATE TABLE IF NOT EXISTS public.task_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name TEXT NOT NULL,
            args JSONB NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',
            result JSONB,
            error JSONB,
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now()
          );
        `;
        
        const { error: createTableError } = await tools.supabase.rpc('execute_sql', {
          sql: createTableSQL
        });
        
        if (createTableError) {
          console.error(`[task-runs-test] Error creating task_runs table: ${createTableError.message}`);
          return {
            success: false,
            error: `Failed to create task_runs table: ${createTableError.message}`,
            message
          };
        }
        
        console.log('[task-runs-test] task_runs table created successfully');
      } else {
        return {
          success: false,
          error: `Error querying task_runs table: ${taskRunsError.message}`,
          message
        };
      }
    } else {
      console.log('[task-runs-test] task_runs table exists');
    }
    
    // Insert a record into the task_runs table
    console.log('[task-runs-test] Inserting record into task_runs table...');
    
    const { data: insertData, error: insertError } = await tools.supabase
      .from('task_runs')
      .insert({
        name: 'task-runs-test',
        args: { message },
        status: 'completed',
        result: { success: true, message },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select();
    
    if (insertError) {
      console.error(`[task-runs-test] Error inserting record into task_runs table: ${insertError.message}`);
      return {
        success: false,
        error: `Failed to insert record into task_runs table: ${insertError.message}`,
        message
      };
    }
    
    console.log('[task-runs-test] Record inserted successfully:', insertData);
    
    return {
      success: true,
      message,
      insertedRecord: insertData
    };
  } catch (error) {
    console.error(`[task-runs-test] Error: ${error.message}`);
    return {
      success: false,
      error: error.message,
      message
    };
  }
}
