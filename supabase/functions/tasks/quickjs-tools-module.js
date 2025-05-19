/**
 * QuickJS module providing access to external tools via host functions.
 * Relies on globally injected __hostExecuteChain__(service, methodPath, params)
 * and potentially __runtimeConfig__ for configuration details if not handled by host.
 */

if (typeof __hostExecuteChain__ !== 'function') {
  throw new Error("Host function '__hostExecuteChain__' is not available in QuickJS environment.");
}

console.log('[QuickJS Tools] Initializing tools module...');

const tools = {
  keystore: {
    listKeys: (namespace) => __hostExecuteChain__('keystore', 'listKeys', { namespace }),
    setKey: (namespace, key, value) => __hostExecuteChain__('keystore', 'setKey', { namespace, key, value }),
    getKey: (namespace, key) => __hostExecuteChain__('keystore', 'getKey', { namespace, key }),
    listNamespaces: () => __hostExecuteChain__('keystore', 'listNamespaces', {}),
    getServerTime: () => __hostExecuteChain__('keystore', 'getServerTime', {}),
    // Add other keystore methods if needed
  },
  openai: {
    chat: {
      completions: {
        create: (params) => {
           console.log('[QuickJS Tools] Calling openai.chat.completions.create...');
           return __hostExecuteChain__('openai', 'chat.completions.create', params);
        }
      }
    },
    embeddings: {
      create: (params) => __hostExecuteChain__('openai', 'embeddings.create', params)
    },
     // Add other openai methods if needed
  },
  supabase: {
    // Note: Chaining requires __hostExecuteChain__ to correctly interpret methodPath + params
    from: (tableName) => {
        console.log(`[QuickJS Tools] Creating Supabase client for table: ${tableName}`);
        return {
            select: (selectParams) => {
                console.log(`[QuickJS Tools] Calling supabase.from(${tableName}).select(${JSON.stringify(selectParams || '*')})`);
                return __hostExecuteChain__('supabase', 'from.select', { table: tableName, params: selectParams });
            },
            insert: (insertParams) => {
                 console.log(`[QuickJS Tools] Calling supabase.from(${tableName}).insert(...)`);
                 return __hostExecuteChain__('supabase', 'from.insert', { table: tableName, params: insertParams });
            },
            update: (updateParams, options) => {
                 console.log(`[QuickJS Tools] Calling supabase.from(${tableName}).update(...)`);
                 return __hostExecuteChain__('supabase', 'from.update', { table: tableName, params: updateParams, options: options });
            },
             delete: (options) => {
                 console.log(`[QuickJS Tools] Calling supabase.from(${tableName}).delete(...)`);
                 return __hostExecuteChain__('supabase', 'from.delete', { table: tableName, options: options });
            }
            // Add other chained methods like update, delete if needed
        };
    },
    auth: {
      signUp: (params) => __hostExecuteChain__('supabase', 'auth.signUp', params),
      signInWithPassword: (params) => __hostExecuteChain__('supabase', 'auth.signInWithPassword', params),
      // Add signOut etc. if needed
    },
     // Add other supabase top-level methods like rpc if needed
  },
  websearch: {
    search: (params) => { // params should be { query: string, limit?: number } matching blog-generator task
        console.log(`[QuickJS Tools] Calling websearch.search with query: ${params?.query}`);
        return __hostExecuteChain__('websearch', 'search', params);
    },
    getServerTime: () => __hostExecuteChain__('websearch', 'getServerTime', {})
     // Add other websearch methods if needed
  },
  gapi: {
    authenticate: (scopeType) => {
      console.log(`[QuickJS Tools] Calling gapi.authenticate with scope: ${scopeType}`);
      return __hostExecuteChain__('gapi', 'authenticate', scopeType);
    },
    admin: {
      domains: {
        list: (params) => {
          console.log(`[QuickJS Tools] Calling gapi.admin.domains.list with params: ${JSON.stringify(params)}`);
          return __hostExecuteChain__('gapi', 'admin.domains.list', params);
        }
      },
      users: {
        list: (params) => {
          console.log(`[QuickJS Tools] Calling gapi.admin.users.list with params: ${JSON.stringify(params)}`);
          return __hostExecuteChain__('gapi', 'admin.users.list', params);
        }
      },
      customers: {
        get: (params) => {
          console.log(`[QuickJS Tools] Calling gapi.admin.customers.get with params: ${JSON.stringify(params)}`);
          return __hostExecuteChain__('gapi', 'admin.customers.get', params);
        }
      }
    }
  }
};

console.log('[QuickJS Tools] Tools module initialized.');
module.exports = tools; 