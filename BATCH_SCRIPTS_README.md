# TradeAnalyzer Batch Scripts

## StartApp.bat
Starts the TradeAnalyzer Electron application with all necessary steps:

1. **Installs dependencies** (if `node_modules` doesn't exist)
2. **Rebuilds native modules** (better-sqlite3 for Electron)
3. **Runs TypeScript type checking**
4. **Starts the Electron dev server**

### Usage:
```
Double-click StartApp.bat
```

Or from command line:
```
StartApp.bat
```

## StopApp.bat
Stops all running TradeAnalyzer components:

1. **Kills Electron processes**
2. **Kills Node.js processes**
3. **Kills Vite dev server processes**
4. **Frees ports 5173 and 5174** (commonly used by Vite)

### Usage:
```
Double-click StopApp.bat
```

Or from command line:
```
StopApp.bat
```

## Troubleshooting

### If the app won't start:
1. Run `StopApp.bat` to clean up any stuck processes
2. Delete the `node_modules` folder
3. Run `StartApp.bat` again

### If ports are in use:
The `StopApp.bat` script automatically frees ports 5173 and 5174.
If you still get port errors, restart your computer.

## Development Workflow

```
StartApp.bat    → Develop/test the app
StopApp.bat     → When done or need to restart
```

**Note:** These scripts are for Windows only.
