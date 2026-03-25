import { contextBridge, ipcRenderer, webUtils } from 'electron'
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

  onDimsReady: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('dims:ready', handler)
    return () => ipcRenderer.off('dims:ready', handler)
  },

  // Fired when ffprobe finds no video stream — card should be removed from gallery
  onVideoNoStream: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('video:no-stream', handler)
    return () => ipcRenderer.off('video:no-stream', handler)
  },

  // Call before every loadFolder to cancel in-flight work for the previous folder
  cancelPipeline: () => ipcRenderer.send('pipeline:cancel'),

  // Notified when the watched folder changes (poll ~30s). Payload: { added, removed }
  onFolderChanged: (callback) => {
    const handler = (_event, diff) => callback(diff)
    ipcRenderer.on('folder:changed', handler)
    return () => ipcRenderer.off('folder:changed', handler)
  },

  // Request processing for a set of filePaths (visible + lookahead).
  // Main process runs ffprobe + ffmpeg only for these paths.
  processPipeline: (filePaths) => ipcRenderer.send('pipeline:process', filePaths),

  platform: process.platform,

  showInFolder: (filePath) => ipcRenderer.invoke('shell:showInFolder', filePath),

  copyPath: (filePath) => ipcRenderer.invoke('shell:copyPath', filePath),

  // With contextIsolation:true, File.path is undefined in the renderer.
  // webUtils.getPathForFile() is the official Electron API (v32+) to get the
  // real filesystem path from a DOM File object.
  getDroppedFolderPath: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file)
      }
    } catch {
      // webUtils unavailable in older Electron versions
    }
    return file?.path ?? null
  },

  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    getAll: () => ipcRenderer.invoke('store:getAll'),
    getFolderThumb: (folderPath) => ipcRenderer.invoke('store:getFolderThumb', folderPath)
  }
})
