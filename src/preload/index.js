import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Expose electron toolkit APIs (ipcRenderer, etc.)
contextBridge.exposeInMainWorld('electron', electronAPI)

// Expose our custom VidVault API
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Opens native folder picker dialog.
   * @returns {Promise<string|null>} Selected folder path, or null if canceled
   */
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),

  /**
   * Reads all video files from a directory recursively.
   * @param {string} dirPath
   * @returns {Promise<Array>}
   */
  readVideos: (dirPath) => ipcRenderer.invoke('fs:readVideos', dirPath)
})
