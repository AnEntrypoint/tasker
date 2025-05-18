/**
 * Tasks Service for SDK Wrapper
 * 
 * This service provides a way to execute tasks via the SDK wrapper.
 * It's used by the stack processor to execute tasks.
 */

import { formatLogMessage } from "../utils/response-formatter.ts";
import { TaskRegistry } from "../registry/task-registry.ts";
import { executeTask } from "../handlers/task-executor.ts";

// Get task registries
const specialTaskRegistry = new TaskRegistry();
const basicTaskRegistry = new TaskRegistry();

/**
 * Tasks Service for SDK Wrapper
 */
export const tasksService = {
  /**
   * Execute a task with the given name and input
   */
  execute: async (taskIdentifier: string, input: Record<string, unknown> = {}, options: { debug?: boolean, verbose?: boolean, include_logs?: boolean } = {}) => {
    //console.log(`[INFO][SDK Service] Received task execution request for: ${taskIdentifier}`);
    const logs: string[] = [formatLogMessage('INFO', `[SDK Service] Executing task: ${taskIdentifier}`)];
    try {
      // Check registry first (same logic as direct execution)
      if (specialTaskRegistry.hasTask(taskIdentifier) || basicTaskRegistry.hasTask(taskIdentifier)) {
        logs.push(formatLogMessage('INFO', `[SDK Service] Executing registered task: ${taskIdentifier}`));
        let result;
        if (specialTaskRegistry.hasTask(taskIdentifier)) {
          result = await specialTaskRegistry.executeTask(taskIdentifier, input, logs);
        } else {
          result = await basicTaskRegistry.executeTask(taskIdentifier, input, logs);
        }
        // FIXED: Return the raw result directly, not wrapped in a success object
        return result;
      } else {
        // Execute from database via executeTask
        logs.push(formatLogMessage('INFO', `[SDK Service] Executing task from database: ${taskIdentifier}`));
        const response = await executeTask(taskIdentifier, input, options);
        const result = await response.json(); // executeTask returns a Response
        
        // FIXED: Extract and return the raw result directly, not wrapped in a success object
        if (result && typeof result === 'object') {
          if (result.success === true) {
            // If the result has a result property, return that
            if (result.result !== undefined) {
              return result.result;
            }
            // If the result has a data property, return that
            else if (result.data !== undefined) {
              return result.data;
            }
          }
        }
        
        // If we couldn't extract a result, return the original result
        return result;
      }
    } catch (error) {
      const errorMsg = `[SDK Service] Error executing task ${taskIdentifier}: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[ERROR] ${errorMsg}`);
      logs.push(formatLogMessage('ERROR', errorMsg));
      // Throw the error so executeMethodChain can format it
      throw new Error(errorMsg);
    }
  }
};
