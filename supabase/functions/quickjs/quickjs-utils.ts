/**
 * QuickJS utilities for context management
 */
import { hostLog } from "../_shared/utils.ts";

// Import types only for documentation
import type { QuickJSContext, QuickJSRuntime } from "npm:quickjs-emscripten";

// Define a simplified interface for our use
interface AsyncContext {
  global: any;
  evalCode: (code: string) => any;
  newFunction: (name: string, fn: (...args: any[]) => any) => any;
  newObject: () => any;
  setProp: (obj: any, prop: string, value: any) => void;
  getProp: (obj: any, prop: string) => any;
  callFunction: (fn: any, thisObj: any, args: any[]) => any;
  dump: (handle: any) => any;
  undefined: any;
  dispose: () => void;
  runtime: {
    executePendingJobs: () => number;
  };
}

/**
 * Create a new QuickJS context
 */
export async function createQuickJSContext(): Promise<AsyncContext> {
  try {
    // We'll use the index.ts in the same directory to avoid direct dependency
    // This is a simpler approach than trying to correctly import the npm module
    const { default: QJS } = await import("./index.ts");
    
    // Create a runtime and context using the imported utilities
    const runtime = QJS.newRuntime();
    const context = await QJS.newAsyncContext(runtime);
    
    hostLog("QuickJS-Utils", "info", "Created new QuickJS context");
    return context;
  } catch (error) {
    hostLog("QuickJS-Utils", "error", `Error creating QuickJS context: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(`Failed to create QuickJS context: ${error instanceof Error ? error.message : String(error)}`);
  }
} 