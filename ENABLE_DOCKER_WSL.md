# Enable Docker Desktop WSL Integration

To run the comprehensive Gmail search test, you need to enable Docker Desktop's WSL integration.

## Steps to Enable WSL Integration:

1. **Open Docker Desktop Settings**
   - Right-click the Docker Desktop icon in Windows system tray
   - Select "Settings"

2. **Navigate to Resources → WSL Integration**
   - Click on "Resources" in the left sidebar
   - Click on "WSL Integration"

3. **Enable WSL Integration**
   - Toggle "Enable integration with my default WSL distro" to ON
   - Under "Enable integration with additional distros", toggle ON for your WSL distribution

4. **Apply & Restart**
   - Click "Apply & restart"
   - Wait for Docker Desktop to restart

5. **Verify in WSL**
   Open a new WSL terminal and run:
   ```bash
   docker --version
   ```

## Alternative: Run Without Docker

If you cannot enable Docker Desktop, you have these options:

### Option 1: Use a Remote Supabase Instance
1. Set up a Supabase project at https://supabase.com
2. Deploy the edge functions to your Supabase project
3. Update the `SUPABASE_URL` and `ANON_KEY` in `comprehensive-gmail-search-cli.js`

### Option 2: Run Services Individually
If you have a remote Supabase instance with the functions deployed, you can run just the client:
```bash
node comprehensive-gmail-search-cli.js
```

## Quick Test After Docker is Enabled

Once Docker Desktop WSL integration is enabled:

```bash
# Test Docker is working
docker ps

# Run the comprehensive Gmail search test
npm run test:comprehensive-gmail-search
```

The test will:
1. Start local Supabase services
2. Execute the comprehensive Gmail search
3. Display results from actual Gmail data

## Troubleshooting

If Docker command still not found after enabling WSL integration:
1. Close all WSL terminals
2. Run in PowerShell: `wsl --shutdown`
3. Open a new WSL terminal
4. Try `docker --version` again

If issues persist:
- Ensure Docker Desktop is running in Windows
- Check Docker Desktop logs for errors
- Reinstall Docker Desktop with WSL 2 backend selected