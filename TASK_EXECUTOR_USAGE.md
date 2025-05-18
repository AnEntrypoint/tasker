# Tasker Task Executor

This is a command-line tool for executing tasks in the Tasker system. It allows you to list available tasks, execute tasks with input parameters, and poll for task results.

## Prerequisites

1. Make sure you have Deno installed on your system.
2. Set the following environment variables:
   - `SUPABASE_URL`: Your Supabase URL
   - `SUPABASE_ANON_KEY`: Your Supabase anon key

## Usage

You can run the task executor using the `npm run task` command, which is a shortcut for `deno run -A run-task.ts`, with various options:

### List all available tasks

```bash
npm run task -- --list
# or
npm run task -- -l
```

This will show a list of all tasks available in the database.

### Execute a task

```bash
npm run task -- --task <task-name>
# or
npm run task -- -t <task-name>
```

### Execute a task with input parameters

```bash
npm run task -- --task <task-name> --input '{"param1": "value1", "param2": "value2"}'
# or
npm run task -- -t <task-name> -i '{"param1": "value1", "param2": "value2"}'
```

### Execute a task and poll for results

```bash
npm run task -- --task <task-name> --poll
# or
npm run task -- -t <task-name> -p
```

This will execute the task and poll the `task_runs` table for the result.

## Examples

### List all tasks

```bash
npm run task -- --list
```

### Run the module-diagnostic task

```bash
npm run task -- --task module-diagnostic --input '{"checkGlobalScope": true}'
```

### Run the gapi-list-domains task and poll for results

```bash
npm run task -- --task gapi-list-domains-with-nested --poll
```

## Ephemeral Execution

The Tasker system uses an ephemeral execution model, where tasks are executed asynchronously in the background. When you execute a task, you'll receive a task run ID, which you can use to check the status and result of the task.

The task executor will display the task run ID and, if the `--poll` option is specified, will poll the `task_runs` table for the result.

## Troubleshooting

If you encounter any issues:

1. Make sure the Supabase functions are running (`supabase functions serve --no-verify-jwt`).
2. Verify that your environment variables are correctly set.
3. Check that the task exists in the `task_functions` table.
4. Look for any error messages in the logs. 