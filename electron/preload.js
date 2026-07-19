const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aulaMedia', {
  getLibraryInfo: () => ipcRenderer.invoke('library:getInfo'),
  openFolder: (kind) => ipcRenderer.invoke('library:openFolder', kind),
  startDownload: (payload) => ipcRenderer.invoke('download:start', payload),
  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('download:progress', handler);
    return () => ipcRenderer.removeListener('download:progress', handler);
  },
});
