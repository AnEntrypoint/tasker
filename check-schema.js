#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

async function checkSchema() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Get task_runs table info
    console.log('🔍 Checking task_runs table structure...');
    const { data: taskRunsColumns, error: taskRunsError } = await supabase
      .rpc('get_table_columns', { table_name: 'task_runs' });

    if (taskRunsError) {
      console.error('Error getting task_runs columns:', taskRunsError);
    } else {
      console.log('✅ task_runs columns:', taskRunsColumns);
    }

    // Get stack_runs table info
    console.log('🔍 Checking stack_runs table structure...');
    const { data: stackRunsColumns, error: stackRunsError } = await supabase
      .rpc('get_table_columns', { table_name: 'stack_runs' });

    if (stackRunsError) {
      console.error('Error getting stack_runs columns:', stackRunsError);
    } else {
      console.log('✅ stack_runs columns:', stackRunsColumns);
    }

    // Try to get sample data
    console.log('🔍 Checking existing task_runs...');
    const { data: existingTaskRuns, error: existingError } = await supabase
      .from('task_runs')
      .select('*')
      .limit(1);

    if (existingError) {
      console.error('Error getting existing task runs:', existingError);
    } else {
      console.log('✅ Sample task_run structure:', existingTaskRuns[0] || 'No existing task runs');
    }

    // Check task_functions
    console.log('🔍 Checking task_functions...');
    const { data: taskFunctions, error: taskFunctionsError } = await supabase
      .from('task_functions')
      .select('id, name, description')
      .eq('name', 'comprehensive-gmail-search');

    if (taskFunctionsError) {
      console.error('Error getting task functions:', taskFunctionsError);
    } else {
      console.log('✅ Found task function:', taskFunctions[0]);
    }

  } catch (error) {
    console.error('❌ Schema check failed:', error.message);
  }
}

checkSchema();