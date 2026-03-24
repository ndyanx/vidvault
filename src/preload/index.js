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

  onDimsReady: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('dims:ready', handler)
    return () => ipcRenderer.off('dims:ready', handler)
  },

  // Fired when ffprobe finds no video stream — file should be removed from gallery
  onVideoNoStream: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('video:no-stream', handler)
    return () => ipcRenderer.off('video:no-stream', handler)
  },

  // Cancel all in-flight on-demand work (call before every loadFolder)
  cancelPipeline: () => ipcRenderer.send('pipeline:cancel'),

  // Request processing for a specific set of filePaths (visible + lookahead).
  // Main process runs ffprobe + ffmpeg only for these — nothing else.
  processPipeline: (filePaths) => ipcRenderer.send('pipeline:process', filePaths),

  platform: process.platform,

  showInFolder: (filePath) => ipcRenderer.invoke('shell:showInFolder', filePath),

  copyPath: (filePath) => ipcRenderer.invoke('shell:copyPath', filePath),

  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    getAll: () => ipcRenderer.invoke('store:getAll'),
    getFolderThumb: (folderPath) => ipcRenderer.invoke('store:getFolderThumb', folderPath)
  }
})
