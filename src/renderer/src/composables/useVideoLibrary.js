import { ref, computed } from 'vue'

const STORAGE_KEY = 'vidvault-last-folder'

// ─── State (module-level singleton) ───────────────────────────────────────
const videos = ref([])
const currentFolder = ref(localStorage.getItem(STORAGE_KEY) || null)
const isLoading = ref(false)
const error = ref(null)

// ─── Check if running inside Electron with our API exposed ────────────────
// In electron-vite dev mode this is always true when preload loaded correctly.
const isElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'

function formatSize(bytes) {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function useVideoLibrary() {
  const isEmpty = computed(() => videos.value.length === 0)

  const folderName = computed(() => {
    if (!currentFolder.value) return null
    // Works for both Windows (C:\Users\...) and Unix (/home/...)
    const parts = currentFolder.value.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || currentFolder.value
  })

  async function loadFolder(folderPath) {
    if (!folderPath) return
    if (!isElectron) {
      console.error('[VidVault] window.electronAPI not found — preload may not be loaded')
      return
    }

    isLoading.value = true
    error.value = null
    videos.value = []

    try {
      const raw = await window.electronAPI.readVideos(folderPath)
      videos.value = raw.map((v) => ({
        ...v,
        sizeFormatted: formatSize(v.size),
        width: null,
        height: null
      }))
      currentFolder.value = folderPath
      localStorage.setItem(STORAGE_KEY, folderPath)
    } catch (err) {
      error.value = 'No se pudo leer la carpeta.'
      console.error('[useVideoLibrary] readVideos error:', err)
    } finally {
      isLoading.value = false
    }
  }

  async function openFolderDialog() {
    if (!isElectron) {
      console.error('[VidVault] window.electronAPI not found — is the preload loaded?')
      return
    }
    const folderPath = await window.electronAPI.openFolder()
    if (folderPath) await loadFolder(folderPath)
  }

  function updateVideoDimensions(id, width, height) {
    const video = videos.value.find((v) => v.id === id)
    if (video) {
      video.width = width
      video.height = height
    }
  }

  async function init() {
    if (currentFolder.value && isElectron) {
      await loadFolder(currentFolder.value)
    }
  }

  return {
    videos,
    currentFolder,
    folderName,
    isLoading,
    error,
    isEmpty,
    isElectron,
    openFolderDialog,
    loadFolder,
    updateVideoDimensions,
    init
  }
}
