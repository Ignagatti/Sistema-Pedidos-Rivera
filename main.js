const { app, BrowserWindow, ipcMain } = require('electron');
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
    // Solo hacemos backup de datos operativos, no de precios (ya que precios son config permanente)
    if (!['orders', 'libres', 'history'].includes(key)) return;
    try {
        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
        const backupFile = path.join(BACKUP_PATH, `${key}_${stamp}.json`);
        // Solo escribimos si no existe ya un backup de ese minuto (evitar I/O excesivo)
        try { await fs.access(backupFile); } catch (_) {
            await fs.writeFile(backupFile, JSON.stringify(data, null, 2), 'utf-8');
            // Limpiar backups viejos: mantener solo los últimos 10 por key
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
            .sort(); // orden alfabetico = orden cronologico por el formato de nombre
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
        // Mantener solo los últimos 5 backups completos
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
    const win = new BrowserWindow({
        width: 1280,
        height: 900,
        title: "Sistema Club de Bochas",
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'icono.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });
    win.loadFile('index.html');
}

app.whenReady().then(async () => {
    await ensureBackupDir();

    // Abrir nueva ventana
    ipcMain.handle('window:new', () => {
        createWindow();
        return true;
    });

    // Carga inicial de todo
    ipcMain.handle('storage:loadInitial', async () => {
        const [orders, libres, prices, history] = await Promise.all([
            readJSON(FILES.orders, []),
            readJSON(FILES.libres, []),
            readJSON(FILES.prices, {}),
            readJSON(FILES.history, [])
        ]);
        return { orders, libres, prices, history };
    });

    // Guardar datos (Genérico) + backup automático
    ipcMain.handle('storage:set', async (event, { key, value }) => {
        if (FILES[key]) {
            const success = await writeJSON(FILES[key], value);
            // Backup automático (no bloquea, se hace en paralelo)
            writeBackup(key, value).catch(() => {});
            // Avisar a otras ventanas
            BrowserWindow.getAllWindows().forEach(w => w.webContents.send('storage:update', { key, value }));
            return success;
        }
        return false;
    });

    // Borrar todo (Cerrar Caja) - SOLO borra operativos, NUNCA los precios
    ipcMain.handle('storage:clearAll', async () => {
        // 1. Backup final completo antes de limpiar (queda como respaldo del cierre)
        await writeFullBackup();

        // 2. Limpiar los backups individuales de orders/libres/history (ya no hacen falta)
        //    Los precios (prices.json) y sus datos NUNCA se tocan.
        try {
            const allFiles = await fs.readdir(BACKUP_PATH);
            const opKeys = ['orders', 'libres', 'history'];
            const toDelete = allFiles.filter(f =>
                opKeys.some(k => f.startsWith(`${k}_`)) && f.endsWith('.json')
            );
            await Promise.all(toDelete.map(f => fs.unlink(path.join(BACKUP_PATH, f)).catch(() => {})));
        } catch (_) {}

        // 3. Resetear los archivos operativos
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

    // Imprimir Ticket
    ipcMain.handle('print-ticket', async (event, htmlContent) => {
        return new Promise(async (resolve) => {
            // Escribir HTML en archivo temporal para que las rutas relativas (FOTO.PNG) funcionen
            const tmpFile = path.join(__dirname, '_ticket_tmp.html');
            try {
                await fs.writeFile(tmpFile, htmlContent, 'utf-8');
            } catch (e) {
                console.error('Error escribiendo ticket temporal:', e);
                resolve(false);
                return;
            }

            const printWin = new BrowserWindow({
                show: false,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    webSecurity: false  // permite cargar FOTO.PNG local
                }
            });

            printWin.loadFile(tmpFile);

            printWin.webContents.on('did-finish-load', () => {
                // Pequeña pausa para asegurar que las imágenes cargaron
                setTimeout(() => {
                    printWin.webContents.print({ silent: false, printBackground: true }, (success) => {
                        printWin.close();
                        // Borrar archivo temporal
                        fs.unlink(tmpFile).catch(() => {});
                        resolve(success);
                    });
                }, 300);
            });

            printWin.webContents.on('did-fail-load', () => {
                printWin.close();
                fs.unlink(tmpFile).catch(() => {});
                resolve(false);
            });
        });
    });

    createWindow();
});

// Backup completo al cerrar la app normalmente
app.on('before-quit', async () => {
    await writeFullBackup();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});