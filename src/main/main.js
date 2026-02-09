const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const LogWatcher = require('./log-watcher');
const APIClient = require('./api-client');

let dashboardWindow;
let overlayWindow;

function createWindows() {
    // 1. Main Dashboard Window
    dashboardWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        frame: false, // Custom frame in HTML? Or standard? Let's go standard for now for drag support effortlessly
        title: 'VerseCon Link',
        backgroundColor: '#0b0c10',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    dashboardWindow.loadFile(path.join(__dirname, '../renderer/dashboard.html'));

    // 2. Overlay Window (Transparent)
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    overlayWindow = new BrowserWindow({
        width: 300,
        height: 500,
        x: width - 320,
        y: 50, // Top Right
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay.html'));

    // Optional: Ignore mouse events? 
    // If user wants click-through: overlayWindow.setIgnoreMouseEvents(true);
    // For now, let's keep interactions enabled for moving/resizing if implemented.
}

// IPC Handlers
ipcMain.on('app:login', (event, token) => {
    APIClient.token = token;
    APIClient.connectSocket(token);
});

ipcMain.on('app:toggle-overlay', () => {
    if (overlayWindow.isVisible()) {
        overlayWindow.hide();
    } else {
        overlayWindow.show();
    }
});


// Logic: Broadcast to ALL windows
function broadcast(channel, data) {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send(channel, data);
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send(channel, data);
}

// Log Watcher Events
LogWatcher.on('gamestate', (data) => broadcast('log:update', data));
LogWatcher.on('status', (status) => broadcast('log:status', status));

// API Events
APIClient.on('party', (data) => broadcast('api:party', data));
APIClient.on('status', (status) => broadcast('api:status', status)); // Needs to be added to APIClient

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window.
        if (dashboardWindow) {
            if (dashboardWindow.isMinimized()) dashboardWindow.restore();
            dashboardWindow.focus();
        }

        // Extract token from protocol
        const url = commandLine.find(arg => arg.startsWith('versecon-link://'));
        if (url) handleDeepLink(url);
    });

    app.whenReady().then(() => {
        createWindows();
        LogWatcher.start();
    });

    // Handle macOS Deep Link
    app.on('open-url', (event, url) => {
        event.preventDefault();
        handleDeepLink(url);
    });
}

function handleDeepLink(url) {
    console.log('[Main] Received Deep Link:', url);
    try {
        // Format: versecon-link://auth?token=XYZ
        const urlObj = new URL(url);
        const token = urlObj.searchParams.get('token');
        if (token) {
            console.log('[Main] Token found in URL');
            if (dashboardWindow) dashboardWindow.webContents.send('auth:success', token);
            APIClient.token = token;
            APIClient.connectSocket(token);
        }
    } catch (e) {
        console.error('[Main] Deep link parse error:', e);
    }
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// Register as default protocol client (dev mode check)
if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('versecon-link', process.execPath, [path.resolve(process.argv[1])]);
    }
} else {
    app.setAsDefaultProtocolClient('versecon-link');
}
