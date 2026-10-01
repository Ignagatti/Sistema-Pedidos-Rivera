const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');

// Rutas de archivos
const DATA_PATH = app.getPath('userData');
const BACKUP_PATH = path.join(DATA_PATH, 'backups');

const FILES = {
    orders:  path.join(DATA_PATH, 'orders.json'),
    libres:  path.join(DATA_PATH, 'libres.json'),
    prices:  path.join(DATA_PATH, 'prices.json'),
    history: path.join(DATA_PATH, 'history.json')
};

// Asegurar que el directorio de backups exista
async function ensureBackupDir() {
    try { await fs.mkdir(BACKUP_PATH, { recursive: true }); } catch (_) {}
}

async function readJSON(filePath, defaultValue) {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (err) {
        return defaultValue;
    }
}

async function writeJSON(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
        return true;
    } catch (err) {
        console.error(`Error escribiendo ${filePath}:`, err);
        return false;
    }
}

// Guarda una copia de seguridad con timestamp (solo orders, libres, history)
// Los precios se guardan por separado y no se resetean nunca con cerrar caja.
async function writeBackup(key, data) {
    if (!['orders', 'libres', 'history'].includes(key)) return;
    try {
        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
        const backupFile = path.join(BACKUP_PATH, `${key}_${stamp}.json`);
        try { await fs.access(backupFile); } catch (_) {
            await fs.writeFile(backupFile, JSON.stringify(data, null, 2), 'utf-8');
            await cleanOldBackups(key);
        }
    } catch (err) {
        console.error('Error escribiendo backup:', err);
    }
}

async function cleanOldBackups(key) {
    try {
        const files = (await fs.readdir(BACKUP_PATH))
            .filter(f => f.startsWith(`${key}_`) && f.endsWith('.json'))
            .sort();
        if (files.length > 10) {
            const toDelete = files.slice(0, files.length - 10);
            await Promise.all(toDelete.map(f => fs.unlink(path.join(BACKUP_PATH, f)).catch(() => {})));
        }
    } catch (_) {}
}

// Backup completo del estado actual (se llama al cerrar la app)
async function writeFullBackup() {
    try {
        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
        const [orders, libres, prices, history] = await Promise.all([
            readJSON(FILES.orders, []),
            readJSON(FILES.libres, []),
            readJSON(FILES.prices, {}),
            readJSON(FILES.history, [])
        ]);
        const fullBackupFile = path.join(BACKUP_PATH, `full_backup_${stamp}.json`);
        await fs.writeFile(fullBackupFile, JSON.stringify({ orders, libres, prices, history }, null, 2), 'utf-8');
        const fullFiles = (await fs.readdir(BACKUP_PATH))
            .filter(f => f.startsWith('full_backup_'))
            .sort();
        if (fullFiles.length > 5) {
            const toDelete = fullFiles.slice(0, fullFiles.length - 5);
            await Promise.all(toDelete.map(f => fs.unlink(path.join(BACKUP_PATH, f)).catch(() => {})));
        }
    } catch (err) {
        console.error('Error en backup completo:', err);
    }
}

function createWindow() {
    const iconPath = path.join(__dirname, 'icono.ico');
    const win = new BrowserWindow({
        width: 1280,
        height: 900,
        title: "Sistema Club de Bochas",
        autoHideMenuBar: true,
        ...(fsSync.existsSync(iconPath) && { icon: iconPath }),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });
    win.loadFile('index.html');
}

// IPC Handlers registrados a nivel raíz
ipcMain.handle('window:new', () => {
    createWindow();
    return true;
});

ipcMain.handle('storage:loadInitial', async () => {
    const [orders, libres, prices, history] = await Promise.all([
        readJSON(FILES.orders, []),
        readJSON(FILES.libres, []),
        readJSON(FILES.prices, {}),
        readJSON(FILES.history, [])
    ]);
    return { orders, libres, prices, history };
});

ipcMain.handle('storage:set', async (event, { key, value }) => {
    if (FILES[key]) {
        const success = await writeJSON(FILES[key], value);
        writeBackup(key, value).catch(() => {});
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('storage:update', { key, value }));
        return success;
    }
    return false;
});

ipcMain.handle('storage:clearAll', async () => {
    await writeFullBackup();

    try {
        const allFiles = await fs.readdir(BACKUP_PATH);
        const opKeys = ['orders', 'libres', 'history'];
        const toDelete = allFiles.filter(f =>
            opKeys.some(k => f.startsWith(`${k}_`)) && f.endsWith('.json')
        );
        await Promise.all(toDelete.map(f => fs.unlink(path.join(BACKUP_PATH, f)).catch(() => {})));
    } catch (_) {}

    const defaults = { orders: [], libres: [], history: [] };
    await Promise.all([
        writeJSON(FILES.orders, defaults.orders),
        writeJSON(FILES.libres, defaults.libres),
        writeJSON(FILES.history, defaults.history)
    ]);
    BrowserWindow.getAllWindows().forEach(w => {
        w.webContents.send('storage:update', { key: 'orders',  value: defaults.orders });
        w.webContents.send('storage:update', { key: 'libres',  value: defaults.libres });
        w.webContents.send('storage:update', { key: 'history', value: defaults.history });
    });
    return true;
});

// Guardar reporte como PDF directamente sin diálogo de impresión
ipcMain.handle('report:savePDF', async (event, { defaultFilename = 'reporte_caja.pdf' } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { success: false, error: 'Ventana no disponible' };

    const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: 'Guardar Reporte como PDF',
        defaultPath: path.join(app.getPath('downloads'), defaultFilename),
        filters: [{ name: 'Documento PDF (*.pdf)', extensions: ['pdf'] }]
    });

    if (canceled || !filePath) return { success: false, canceled: true };

    try {
        const pdfBuffer = await event.sender.printToPDF({
            pageSize: 'A4',
            landscape: false,
            margins: {
                top: 0.59, // 15mm (~0.59 inches)
                bottom: 0.59,
                left: 0.59,
                right: 0.59
            },
            printBackground: true,
            preferCSSPageSize: true
        });

        await fs.writeFile(filePath, pdfBuffer);
        return { success: true, filePath };
    } catch (err) {
        console.error('Error al generar PDF:', err);
        return { success: false, error: err.message };
    }
});

app.whenReady().then(async () => {
    await ensureBackupDir();
    createWindow();
});

// Backup completo al cerrar la app normalmente
let quitting = false;
app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    writeFullBackup().finally(() => app.exit(0));
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});