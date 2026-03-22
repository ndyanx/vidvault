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
   * Returns immediately with cached thumbnails; missing ones arrive via onThumbnailReady.
   * @param {string} dirPath
   * @returns {Promise<Array>}
   */
  readVideos: (dirPath) => ipcRenderer.invoke('fs:readVideos', dirPath),

  /**
   * Subscribe to background thumbnail generation events.
   * Callback receives { id, thumbnailUrl } for each completed thumbnail.
   * @param {Function} callback
   * @returns {Function} unsubscribe — call to remove the listener
   */
  onThumbnailReady: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('thumbnail:ready', handler)
    return () => ipcRenderer.off('thumbnail:ready', handler)
  }
})
