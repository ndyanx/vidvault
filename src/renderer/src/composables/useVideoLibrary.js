import { ref, computed } from 'vue'

const MAX_HISTORY = 8

const videos = ref([])
const currentFolder = ref(null)
const isLoading = ref(false)
const error = ref(null)
const folderHistory = ref([])

const isElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'
const store = isElectron ? window.electronAPI.store : null

function formatSize(bytes) {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

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

function ensureThumbnailListener() {
  if (unsubscribeThumbnail || !isElectron) return
  unsubscribeThumbnail = window.electronAPI.onThumbnailReady(({ id, thumbnailUrl }) => {
    const video = videos.value.find((v) => v.id === id)
    if (video) video.thumbnailUrl = thumbnailUrl
  })
}

export function useVideoLibrary() {
  const isEmpty = computed(() => videos.value.length === 0)

  const folderName = computed(() => {
    return currentFolder.value ? folderNameFrom(currentFolder.value) : null
  })

  async function loadFolder(folderPath) {
    if (!folderPath || !isElectron) return

    isLoading.value = true
    error.value = null
    videos.value = []
    currentFolder.value = folderPath

    ensureThumbnailListener()

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
      // toPlain() strips Vue proxy wrappers — required for IPC structured clone
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
      videos.value = []
      currentFolder.value = null
      store.set('lastFolder', null).catch(console.error)
    }
  }

  function dismissError() {
    error.value = null
  }

  function updateVideoDimensions(id, width, height) {
    const video = videos.value.find((v) => v.id === id)
    if (video) {
      video.width = width
      video.height = height
    }
  }

  async function init() {
    if (!isElectron) return
    const state = await store.getAll()
    folderHistory.value = state.folderHistory || []
    if (state.lastFolder) {
      await loadFolder(state.lastFolder)
    }
  }

  return {
    videos,
    currentFolder,
    folderName,
    folderHistory,
    isLoading,
    error,
    isEmpty,
    isElectron,
    openFolderDialog,
    loadFolder,
    closeFolder,
    deleteFromHistory,
    dismissError,
    updateVideoDimensions,
    init
  }
}
