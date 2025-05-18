// Test script for the task execution system
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Fetch environment variables
const env = {
  SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
  SUPABASE_KEY: Deno.env.get('SUPABASE_ANON_KEY'),
  SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
};

if (!env.SUPABASE_URL || !env.SERVICE_ROLE_KEY) {
  console.error('Missing environment variables:');
  console.error('SUPABASE_URL:', env.SUPABASE_URL ? 'Set' : 'Missing');
  console.error('SERVICE_ROLE_KEY:', env.SERVICE_ROLE_KEY ? 'Set' : 'Missing');
  Deno.exit(1);
}

// Initialize Supabase client
const supabase = createClient(env.SUPABASE_URL, env.SERVICE_ROLE_KEY);

// Sample task code for testing - a simple "echo" task
const TEST_TASK_NAME = 'test_echo';
const TEST_TASK_CODE = `
/**
 * A simple echo task that returns the input
 * @param {object} input - The input object
 * @param {string} input.message - The message to echo
 * @returns {object} The output object with echoed message
 */
export function runTask(input, tools) {
  console.log('Hello from echo task!');
  tools.log('info', 'Processing input', input);
  
  // Delay to simulate processing
  return new Promise(resolve => {
    setTimeout(() => {
      tools.log('info', 'Echo task completed');
      resolve({
        message: \`Echo: \${input.message || 'No message provided'}\`,
        timestamp: new Date().toISOString()
      });
    }, 1000);
  });
}
`;

async function setupTestTask() {
  // Check if task already exists
  const { data: existingTask } = await supabase
    .from('task_functions')
    .select('id, name')
    .eq('name', TEST_TASK_NAME)
    .maybeSingle();

  if (existingTask) {
    console.log(`Task '${TEST_TASK_NAME}' already exists with ID: ${existingTask.id}`);
    // Update the task code to ensure it's correct
    const { error: updateError } = await supabase
      .from('task_functions')
      .update({ code: TEST_TASK_CODE, updated_at: new Date().toISOString() })
      .eq('id', existingTask.id);
    
    if (updateError) {
      console.error('Error updating task:', updateError);
      return null;
    }
    return existingTask.id;
  } else {
    // Create the test task if it doesn't exist
    const { data: newTask, error: createError } = await supabase
      .from('task_functions')
      .insert({
        name: TEST_TASK_NAME,
        code: TEST_TASK_CODE,
        description: 'A simple echo task for testing',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select('id')
      .single();
    
    if (createError) {
      console.error('Error creating task:', createError);
      return null;
    }
    
    console.log(`Created test task '${TEST_TASK_NAME}' with ID: ${newTask.id}`);
    return newTask.id;
  }
}

async function testTaskExecution(taskId: string) {
  console.log('\n=== Testing Task Execution ===');
  
  try {
    // Get the task name for reference
    const { data: task } = await supabase
      .from('task_functions')
      .select('name')
      .eq('id', taskId)
      .single();
    
    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }
    
    // Execute the task via the /tasks edge function
    console.log(`Executing task: ${task.name}`);
    const taskResponse = await fetch(`${env.SUPABASE_URL}/functions/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        taskName: task.name,
        input: {
          message: 'Hello from the test script!'
        }
      })
    });
    
    if (!taskResponse.ok) {
      const errorText = await taskResponse.text();
      throw new Error(`Task execution failed: ${taskResponse.status} ${taskResponse.statusText}\n${errorText}`);
    }
    
    const taskResult = await taskResponse.json();
    console.log('Task execution response:', taskResult);
    
    if (!taskResult.taskRunId) {
      throw new Error('No task run ID returned from task execution');
    }
    
    // Poll for task completion
    const taskRunId = taskResult.taskRunId;
    console.log(`Polling for completion of task run: ${taskRunId}`);
    
    let completed = false;
    let attempts = 0;
    const maxAttempts = 20; // 20 attempts * 500ms = 10 seconds max wait time
    
    while (!completed && attempts < maxAttempts) {
      attempts++;
      
      const { data: taskRun } = await supabase
        .from('task_runs')
        .select('*')
        .eq('id', taskRunId)
        .single();
      
      if (taskRun) {
        console.log(`Poll ${attempts}: Task run status: ${taskRun.status}`);
        
        if (taskRun.status === 'completed') {
          console.log('Task completed successfully! Result:', taskRun.result);
          completed = true;
          break;
        } else if (taskRun.status === 'failed') {
          console.error('Task failed:', taskRun.error);
          completed = true;
          break;
        }
      } else {
        console.warn(`Task run ${taskRunId} not found`);
      }
      
      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    if (!completed) {
      console.warn(`Polling timed out after ${attempts} attempts. Task may still be running.`);
    }
    
    // Get stack_runs for this task
    const { data: stackRuns } = await supabase
      .from('stack_runs')
      .select('*')
      .eq('parent_task_run_id', taskRunId)
      .order('created_at', { ascending: true });
    
    console.log(`\nFound ${stackRuns?.length || 0} stack runs for task run: ${taskRunId}`);
    if (stackRuns && stackRuns.length > 0) {
      stackRuns.forEach((run, index) => {
        console.log(`\nStack Run ${index + 1}:`);
        console.log(`  ID: ${run.id}`);
        console.log(`  Status: ${run.status}`);
        console.log(`  Service: ${run.service_name}.${run.method_name}`);
        console.log(`  Created: ${run.created_at}`);
        if (run.result) console.log(`  Result: ${JSON.stringify(run.result)}`);
        if (run.error) console.log(`  Error: ${JSON.stringify(run.error)}`);
      });
    }
    
    return true;
  } catch (error) {
    console.error('Error during task execution test:', error);
    return false;
  }
}

async function cleanupTestData() {
  console.log('\n=== Cleaning Up Test Data ===');
  
  try {
    // Delete test task runs (cascade will delete associated stack runs)
    const { data: taskRuns, error: taskRunsError } = await supabase
      .from('task_runs')
      .select('id')
      .eq('task_name', TEST_TASK_NAME);
    
    if (taskRunsError) {
      console.error('Error fetching task runs:', taskRunsError);
    } else if (taskRuns && taskRuns.length > 0) {
      console.log(`Deleting ${taskRuns.length} task runs...`);
      
      const { error: deleteError } = await supabase
        .from('task_runs')
        .delete()
        .in('id', taskRuns.map(run => run.id));
      
      if (deleteError) {
        console.error('Error deleting task runs:', deleteError);
      } else {
        console.log(`Successfully deleted ${taskRuns.length} task runs.`);
      }
    } else {
      console.log('No task runs to delete.');
    }
    
    // Note: We're keeping the test task for future tests
    
    return true;
  } catch (error) {
    console.error('Error during cleanup:', error);
    return false;
  }
}

async function main() {
  console.log('=== QuickJS Task Execution System Test ===');
  console.log(`Supabase URL: ${env.SUPABASE_URL}`);
  
  // Set up the test task
  const taskId = await setupTestTask();
  if (!taskId) {
    console.error('Failed to setup test task. Exiting.');
    Deno.exit(1);
  }
  
  // Run the test
  const success = await testTaskExecution(taskId);
  
  // Cleanup
  await cleanupTestData();
  
  // Exit with appropriate code
  if (success) {
    console.log('\n=== Test Completed Successfully ===');
    Deno.exit(0);
  } else {
    console.error('\n=== Test Failed ===');
    Deno.exit(1);
  }
}

// Run the test
await main(); 