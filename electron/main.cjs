const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        title: 'TV Config Fix',
        icon: path.join(__dirname, '..', 'build', 'icon.png'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.setMenu(null);

    const indexPath = path.resolve(__dirname, '..', 'dist', 'index.html');

    console.log('Electron __dirname:', __dirname);
    console.log('Loading index:', indexPath);
    console.log('index.html exists:', fs.existsSync(indexPath));

    mainWindow.loadURL(pathToFileURL(indexPath).href);

    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        console.error('Electron failed to load page:');
        console.error('Error code:', errorCode);
        console.error('Description:', errorDescription);
        console.error('URL:', validatedURL);
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});