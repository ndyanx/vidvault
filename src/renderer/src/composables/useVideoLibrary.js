import { ref, computed, onUnmounted } from 'vue'

const STORAGE_KEY = 'vidvault-last-folder'
const HISTORY_KEY = 'vidvault-folder-history'
const MAX_HISTORY = 8

// ─── State (singleton) ────────────────────────────────────────────────────
const videos = ref([])
const currentFolder = ref(null)
const isLoading = ref(false)
const error = ref(null) // null | { type: 'not_found' | 'read_error', folder: string }

// ─── History ───────────────────────────────────────────────────────────────
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
  } catch {
    return []
  }
}

function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
}

function pushToHistory(folderPath) {
  let history = loadHistory()
  history = history.filter((h) => h.path !== folderPath)
  history.unshift({
    path: folderPath,
    name: folderPath.replace(/\\/g, '/').split('/').filter(Boolean).pop(),
    lastOpened: Date.now()
  })
  history = history.slice(0, MAX_HISTORY)
  saveHistory(history)
  return history
}

function removeFromHistory(folderPath) {
  const history = loadHistory().filter((h) => h.path !== folderPath)
  saveHistory(history)
  return history
}

const folderHistory = ref(loadHistory())

// ─── Helpers ───────────────────────────────────────────────────────────────
const isElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'

function formatSize(bytes) {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// ─── Thumbnail IPC listener (singleton) ───────────────────────────────────
// Subscribes once and patches videos as thumbnails arrive from main process.
let unsubscribeThumbnail = null

function ensureThumbnailListener() {
  if (unsubscribeThumbnail || !isElectron) return

  unsubscribeThumbnail = window.electronAPI.onThumbnailReady(({ id, thumbnailUrl }) => {
    const video = videos.value.find((v) => v.id === id)
    if (video) {
      video.thumbnailUrl = thumbnailUrl
    }
  })
}

// ─── Composable ───────────────────────────────────────────────────────────
export function useVideoLibrary() {
  const isEmpty = computed(() => videos.value.length === 0)

  const folderName = computed(() => {
    if (!currentFolder.value) return null
    const parts = currentFolder.value.replace(/\\/g, '/').split('/').filter(Boolean)
    return parts[parts.length - 1] || currentFolder.value
  })

  // ── Load a folder ─────────────────────────────────────────────────────
  async function loadFolder(folderPath) {
    if (!folderPath || !isElectron) return

    isLoading.value = true
    error.value = null
    videos.value = []
    currentFolder.value = folderPath

    // Ensure thumbnail push listener is active before the call
    ensureThumbnailListener()

    try {
      const result = await window.electronAPI.readVideos(folderPath)

      if (result?.error === 'not_found') {
        error.value = { type: 'not_found', folder: folderPath }
        currentFolder.value = null
        localStorage.removeItem(STORAGE_KEY)
        folderHistory.value = removeFromHistory(folderPath)
        return
      }

      videos.value = result.map((v) => ({
        ...v,
        sizeFormatted: formatSize(v.size)
        // thumbnailUrl is already set for cached videos, null for new ones
      }))

      localStorage.setItem(STORAGE_KEY, folderPath)
      folderHistory.value = pushToHistory(folderPath)
    } catch (err) {
      error.value = { type: 'read_error', folder: folderPath }
      currentFolder.value = null
      console.error('[useVideoLibrary] loadFolder error:', err)
    } finally {
      isLoading.value = false
    }
  }

  // ── Open folder dialog ────────────────────────────────────────────────
  async function openFolderDialog() {
    if (!isElectron) return
    const folderPath = await window.electronAPI.openFolder()
    if (folderPath) await loadFolder(folderPath)
  }

  // ── Close current folder → back to empty state ────────────────────────
  function closeFolder() {
    videos.value = []
    currentFolder.value = null
    error.value = null
    localStorage.removeItem(STORAGE_KEY)
  }

  // ── Remove entry from history ─────────────────────────────────────────
  function deleteFromHistory(folderPath) {
    folderHistory.value = removeFromHistory(folderPath)
    if (currentFolder.value === folderPath) closeFolder()
  }

  // ── Dismiss error ─────────────────────────────────────────────────────
  function dismissError() {
    error.value = null
  }

  // ── Update video dimensions (fallback from renderer if needed) ─────────
  function updateVideoDimensions(id, width, height) {
    const video = videos.value.find((v) => v.id === id)
    if (video) {
      video.width = width
      video.height = height
    }
  }

  // ── Init: restore last folder on startup ──────────────────────────────
  async function init() {
    const lastFolder = localStorage.getItem(STORAGE_KEY)
    if (lastFolder && isElectron) {
      await loadFolder(lastFolder)
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
