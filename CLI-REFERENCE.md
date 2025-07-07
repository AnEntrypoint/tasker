# 📧 Comprehensive Gmail Search CLI - Quick Reference

## 🚀 Quick Start

```bash
# Start services and run basic search
npm run test:comprehensive-gmail-search

# Direct execution with custom query
node comprehensive-gmail-search-cli.js --query "subject:meeting"
```

## 📋 Command Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--query` | `-q` | Gmail search query | `"in:inbox"` |
| `--maxResultsPerUser` | | Max emails per user | `3` |
| `--maxUsersPerDomain` | | Max users per domain | `5` |
| `--help` | `-h` | Show help message | |

## 🔍 Search Query Examples

### Basic Searches
```bash
# Inbox emails
npm run test:comprehensive-gmail-search -- --query "in:inbox"

# Sent emails  
npm run test:comprehensive-gmail-search -- --query "in:sent"

# Drafts
npm run test:comprehensive-gmail-search -- --query "in:drafts"
```

### Content-Based Searches
```bash
# Subject contains "meeting"
npm run test:comprehensive-gmail-search -- --query "subject:meeting"

# From specific sender
npm run test:comprehensive-gmail-search -- --query "from:john@company.com"

# Emails with attachments
npm run test:comprehensive-gmail-search -- --query "has:attachment"

# Contains specific text
npm run test:comprehensive-gmail-search -- --query "quarterly report"
```

### Date-Based Searches
```bash
# Emails from today
npm run test:comprehensive-gmail-search -- --query "newer_than:1d"

# Emails from this week
npm run test:comprehensive-gmail-search -- --query "newer_than:7d"

# Emails from this month
npm run test:comprehensive-gmail-search -- --query "newer_than:30d"

# Specific date range
npm run test:comprehensive-gmail-search -- --query "after:2024/01/01 before:2024/01/31"
```

### Combined Searches
```bash
# Important emails with attachments
npm run test:comprehensive-gmail-search -- --query "is:important has:attachment"

# Unread emails from specific domain
npm run test:comprehensive-gmail-search -- --query "is:unread from:@company.com"

# Recent emails about projects
npm run test:comprehensive-gmail-search -- --query "newer_than:7d subject:(project OR task)"
```

## ⚡ Performance Tuning

### Fast Searches (Limited Scope)
```bash
# 1 user per domain, 1 email per user
npm run test:comprehensive-gmail-search -- --maxUsersPerDomain 1 --maxResultsPerUser 1

# 2 users per domain, minimal emails
npm run test:comprehensive-gmail-search -- --maxUsersPerDomain 2 --maxResultsPerUser 1
```

### Comprehensive Searches
```bash
# More users per domain
npm run test:comprehensive-gmail-search -- --maxUsersPerDomain 10 --maxResultsPerUser 5

# Maximum scope (slower but thorough)
npm run test:comprehensive-gmail-search -- --maxUsersPerDomain 20 --maxResultsPerUser 10
```

## 🎯 Direct Execution (No NPM)

```bash
# Basic search
node comprehensive-gmail-search-cli.js

# Custom query
node comprehensive-gmail-search-cli.js --query "in:sent"

# Limited scope for speed
node comprehensive-gmail-search-cli.js --query "subject:meeting" --maxUsersPerDomain 1
```

## 📊 Expected Output

```
🚀 Comprehensive Gmail Search CLI
=================================
📧 Search Query: "subject:meeting"
👥 Max Users Per Domain: 2
📋 Max Results Per User: 1
🌐 Target: All Google Workspace domains

⏳ Initializing services...
📤 Submitting comprehensive Gmail search task...
✅ Task submitted successfully!

🔄 Monitoring comprehensive search progress...
[10s] ⚙️ Status: PROCESSING
[15s] ⏸️ Status: SUSPENDED
       🔗 Waiting on: 9546a14e-225b...
       💾 VM state preserved - external API call in progress

🎉 COMPREHENSIVE GMAIL SEARCH COMPLETED SUCCESSFULLY!
===================================================
📊 Execution Summary:
   🏢 Domains processed: 4
   👥 Users processed: 8
   📧 Total emails found: 12
   ⏱️ Processing time: 45.2s
   🔍 Search query: "subject:meeting"

📋 Results by Domain:
   1. 🏢 l-inc.co.za:
      👥 Users searched: 2
      📧 Emails found: 4
   2. 🏢 beecompliant.net:
      👥 Users searched: 2
      📧 Emails found: 3
```

## 🔧 Troubleshooting

### Common Issues

**Services not running:**
```bash
# Start services first
npm run gapi:serve
```

**Long execution times:**
```bash
# Reduce scope
npm run test:comprehensive-gmail-search -- --maxUsersPerDomain 1 --maxResultsPerUser 1
```

**Task appears stuck:**
- VM suspension is normal during API calls
- Wait for "SUSPENDED" → "PROCESSING" transitions
- Maximum monitoring time is 3 minutes

### Manual Verification

```bash
# Check if services are running
curl http://127.0.0.1:8000/functions/v1/tasks/list

# Test with minimal task
node comprehensive-gmail-search-cli.js --maxUsersPerDomain 1 --maxResultsPerUser 1
```

## 🎯 What It Demonstrates

✅ **Multi-step workflow** execution  
✅ **VM suspend/resume** mechanism  
✅ **External API integration** (Google Workspace)  
✅ **State preservation** across suspensions  
✅ **Result aggregation** from multiple sources  
✅ **Real-time monitoring** and progress tracking  

This CLI showcases the Tasker system's ability to handle complex, multi-step workflows involving external API calls while maintaining execution state across VM suspensions.

## 📚 Related Commands

```bash
# Other Tasker CLI commands
npm run gapi:serve        # Start services
npm run publish:task      # Publish tasks
npm run keystore         # Test keystore
npm run gapi             # Test GAPI directly
``` 