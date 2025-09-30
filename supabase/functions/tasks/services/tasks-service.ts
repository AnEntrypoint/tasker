import { formatLogMessage } from "../utils/response-formatter.ts";
import { TaskRegistry } from "../registry/task-registry.ts";
import { fetchTaskFromDatabase } from "./database.ts";
import { GeneratedSchema } from "../types/index.ts";

const basicTaskRegistry = new TaskRegistry();
const specialTaskRegistry = new TaskRegistry();

export const tasksService = {
  execute: async (taskIdentifier: string, input: Record<string, unknown> = {}, options: { debug?: boolean, verbose?: boolean, include_logs?: boolean } = {}) => {
    const logs: string[] = [formatLogMessage('INFO', `[SDK Service] Executing task: ${taskIdentifier}`)];
    try {
      // Check registry first (same logic as direct execution)
      let taskFunction = basicTaskRegistry.get(taskIdentifier);
      let taskType = 'basic';

      if (!taskFunction) {
        taskFunction = specialTaskRegistry.get(taskIdentifier);
        taskType = 'special';
      }

      if (taskFunction) {
        logs.push(formatLogMessage('INFO', `[SDK Service] Found task in ${taskType} registry, executing locally`));
        const result = await taskFunction(input, { supabaseClient: null });
        if (options.include_logs) {
          return { success: true, result, logs };
        }
        return { success: true, result };
      }

      // Fetch from database
      logs.push(formatLogMessage('INFO', `[SDK Service] Task not in registry, fetching from database: ${taskIdentifier}`));
      const { taskFunction: dbTaskFunction, taskName, description } = await fetchTaskFromDatabase(taskIdentifier);

      if (!dbTaskFunction) {
        const error = `Task not found: ${taskIdentifier}`;
        logs.push(formatLogMessage('ERROR', `[SDK Service] ${error}`));
        return { success: false, error, logs };
      }

      // Execute the fetched function
      logs.push(formatLogMessage('INFO', `[SDK Service] Executing task from database: ${taskName || taskIdentifier}`));

      // Create sandbox for database task execution
      const AsyncFunction = (async function() {}).constructor as any;
      const sandbox = {
        console: {
          log: (...args: any[]) => {
            logs.push(formatLogMessage('INFO', `[Database Task] ${args.join(' ')}`));
          },
          error: (...args: any[]) => {
            logs.push(formatLogMessage('ERROR', `[Database Task] ${args.join(' ')}`));
          }
        },
        setTimeout,
        clearTimeout,
        Date,
        JSON,
        Math,
        parseInt,
        parseFloat,
        String,
        Number,
        Array,
        Object,
        // Add task execution helpers
        fetch: (url: string, options?: RequestInit) => {
          logs.push(formatLogMessage('INFO', `[Database Task] Fetch: ${options?.method || 'GET'} ${url}`));
          return fetch(url, options);
        }
      };

      // Create task execution function with sandbox
      const taskExecutionFunction = new AsyncFunction(
        ...Object.keys(sandbox),
        dbTaskFunction
      );

      // Execute with sandbox context
      const result = await taskExecutionFunction(...Object.values(sandbox));

      logs.push(formatLogMessage('INFO', `[SDK Service] Task execution completed successfully`));

      if (options.include_logs) {
        return { success: true, result, logs, taskName, description };
      }
      return { success: true, result, taskName, description };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logs.push(formatLogMessage('ERROR', `[SDK Service] Task execution failed: ${errorMessage}`));

      if (options.include_logs) {
        return { success: false, error: errorMessage, logs };
      }
      return { success: false, error: errorMessage };
    }
  },

  list: async (filter: { type?: 'basic' | 'special' | 'database' } = {}) => {
    const allTasks: any[] = [];

    if (!filter.type || filter.type === 'basic') {
      Object.keys(basicTaskRegistry.list()).forEach(taskName => {
        allTasks.push({ name: taskName, type: 'basic' });
      });
    }

    if (!filter.type || filter.type === 'special') {
      Object.keys(specialTaskRegistry.list()).forEach(taskName => {
        allTasks.push({ name: taskName, type: 'special' });
      });
    }

    // TODO: Implement database task listing if needed

    return { success: true, tasks: allTasks };
  }
};