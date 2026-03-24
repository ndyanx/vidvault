import { ref, computed } from 'vue'
import { formatSize } from '../utils/format.js'

const MAX_HISTORY = 8

const videos = ref([])
const currentFolder = ref(null)
const isLoading = ref(false)
const isInitializing = ref(true) // true until init() resolves; suppresses EmptyState flash
const error = ref(null)
const folderHistory = ref([])

const isElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'
const store = isElectron ? window.electronAPI.store : null

function folderNameFrom(folderPath) {
  return folderPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || folderPath
}

function pushToHistory(history, folderPath) {
  const filtered = history.filter((h) => h.path !== folderPath)
  filtered.unshift({ path: folderPath, name: folderNameFrom(folderPath), lastOpened: Date.now() })
  return filtered.slice(0, MAX_HISTORY)
}

function removeFromHistory(history, folderPath) {
  return history.filter((h) => h.path !== folderPath)
}

// Deep-clone via JSON to strip any Vue proxy wrappers before sending over IPC.
// Electron's contextBridge uses structured clone, which chokes on Proxy objects.
function toPlain(val) {
  return JSON.parse(JSON.stringify(val))
}

let unsubscribeThumbnail = null
let unsubscribeDims = null
let unsubscribeNoStream = null
let unsubscribeFolderChanged = null
let initPromise = null

function ensureListeners() {
  if (unsubscribeThumbnail || !isElectron) return

  unsubscribeThumbnail = window.electronAPI.onThumbnailReady(({ id, thumbnailUrl }) => {
    const video = videos.value.find((v) => v.id === id)
    if (video) video.thumbnailUrl = thumbnailUrl
  })

  unsubscribeDims = window.electronAPI.onDimsReady(({ id, width, height, duration }) => {
    const video = videos.value.find((v) => v.id === id)
    if (video) {
      video.width = width
      video.height = height
      video.duration = duration
    }
  })

  unsubscribeNoStream = window.electronAPI.onVideoNoStream(({ id }) => {
    videos.value = videos.value.filter((v) => v.id !== id)
  })
}

function ensureFolderWatcher(loadFolder, applyDiff) {
  if (unsubscribeFolderChanged || !isElectron) return
  unsubscribeFolderChanged = window.electronAPI.onFolderChanged((diff) => {
    if (!currentFolder.value) return
    // If files were removed or modified, do a full reload — layout needs to rebuild
    if (diff.removed.length) { loadFolder(currentFolder.value); return }
    // Only additions — append new cards without touching existing ones
    if (diff.added.length) applyDiff(diff.added)
  })
}

export function useVideoLibrary() {
  const isEmpty = computed(() => videos.value.length === 0)

  const folderName = computed(() => {
    return currentFolder.value ? folderNameFrom(currentFolder.value) : null
  })

  // Append new video cards without resetting existing ones.
  // Called when the poll detects only additions (no removals/modifications).
  async function applyDiff(addedPaths) {
    if (!addedPaths.length) return
    const result = await window.electronAPI.readVideos(currentFolder.value)
    if (!result || result.error) return
    const existingIds = new Set(videos.value.map((v) => v.id))
    const newVideos = result
      .filter((v) => addedPaths.includes(v.filePath) && !existingIds.has(v.id))
      .map((v) => ({ ...v, sizeFormatted: formatSize(v.size) }))
    if (newVideos.length) videos.value = [...newVideos, ...videos.value]
  }

  async function loadFolder(folderPath) {
    if (!folderPath || !isElectron) return

    isLoading.value = true
    error.value = null
    videos.value = []
    currentFolder.value = folderPath

    ensureListeners()
    ensureFolderWatcher(loadFolder, applyDiff)

    try {
      const result = await window.electronAPI.readVideos(folderPath)

      if (result?.error === 'not_found') {
        error.value = { type: 'not_found', folder: folderPath }
        currentFolder.value = null
        const next = removeFromHistory(folderHistory.value, folderPath)
        folderHistory.value = next
        store.set('folderHistory', toPlain(next)).catch(console.error)
        store.set('lastFolder', null).catch(console.error)
        return
      }

      error.value = null
      videos.value = result.map((v) => ({ ...v, sizeFormatted: formatSize(v.size) }))

      const next = pushToHistory(folderHistory.value, folderPath)
      folderHistory.value = next
      store.set('lastFolder', String(folderPath)).catch(console.error)
      store.set('folderHistory', toPlain(next)).catch(console.error)
    } catch (err) {
      error.value = { type: 'read_error', folder: folderPath }
      currentFolder.value = null
      console.error('[useVideoLibrary] loadFolder error:', err)
    } finally {
      isLoading.value = false
    }
  }

  async function openFolderDialog() {
    if (!isElectron) return
    const folderPath = await window.electronAPI.openFolder()
    if (folderPath) await loadFolder(folderPath)
  }

  async function closeFolder() {
    window.electronAPI.cancelPipeline()
    videos.value = []
    currentFolder.value = null
    error.value = null
    store.set('lastFolder', null).catch(console.error)
  }

  async function deleteFromHistory(folderPath) {
    const next = removeFromHistory(folderHistory.value, folderPath)
    folderHistory.value = next
    store.set('folderHistory', toPlain(next)).catch(console.error)
    if (currentFolder.value === folderPath) {
      window.electronAPI.cancelPipeline()
      videos.value = []
      currentFolder.value = null
      store.set('lastFolder', null).catch(console.error)
    }
  }

  // Ask the main process to run ffprobe + ffmpeg for these filePaths.
  // Called with visible + lookahead filePaths whenever the viewport changes.
  function processVisible(filePaths) {
    if (!isElectron || !filePaths || !filePaths.length) return
    window.electronAPI.processPipeline(filePaths)
  }

  function dismissError() {
    error.value = null
  }

  async function init() {
    if (!isElectron) {
      isInitializing.value = false
      return
    }
    if (initPromise) return initPromise
    initPromise = (async () => {
      const state = await store.getAll()
      folderHistory.value = state.folderHistory || []
      if (state.lastFolder) {
        await loadFolder(state.lastFolder)
      }
    })()
    await initPromise
    isInitializing.value = false
    return initPromise
  }

  return {
    videos,
    currentFolder,
    folderName,
    folderHistory,
    isLoading,
    isInitializing,
    error,
    isEmpty,
    isElectron,
    openFolderDialog,
    loadFolder,
    closeFolder,
    deleteFromHistory,
    dismissError,
    processVisible,
    init
  }
}
