import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

contextBridge.exposeInMainWorld('electron', electronAPI)

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),

  readVideos: (dirPath) => ipcRenderer.invoke('fs:readVideos', dirPath),

  onThumbnailReady: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('thumbnail:ready', handler)
    return () => ipcRenderer.off('thumbnail:ready', handler)
  },

  showInFolder: (filePath) => ipcRenderer.invoke('shell:showInFolder', filePath),

  copyPath: (filePath) => ipcRenderer.invoke('shell:copyPath', filePath),

  // ─── Persistent store (replaces localStorage for app state) ─────────────
  // Reads/writes app-state.json in Electron's userData directory.
  // Keys: 'lastFolder' | 'folderHistory' | 'favorites'
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    getAll: () => ipcRenderer.invoke('store:getAll')
  }
})
