import { ref, watch } from 'vue'

const isElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'
const store = isElectron ? window.electronAPI.store : null

// Default to system preference; overwritten once the store resolves
const systemDark =
  typeof window !== 'undefined'
    ? window.matchMedia?.('(prefers-color-scheme: dark)').matches
    : false

const isDark = ref(systemDark)

// Track whether the persisted value has been loaded yet.
// watchEffect must not write back to the store during the initial load
// to avoid overwriting the saved theme with the system default.
let persistedValueLoaded = false

function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
}

// Apply system default immediately so there's no flash on startup
applyTheme(isDark.value)

// Load persisted theme on startup
if (isElectron) {
  store
    .get('theme')
    .then((saved) => {
      if (saved === 'dark' || saved === 'light') {
        isDark.value = saved === 'dark'
      }
      persistedValueLoaded = true
    })
    .catch(() => {
      persistedValueLoaded = true
    })
} else if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('vidvault-theme')
  if (saved) isDark.value = saved === 'dark'
  persistedValueLoaded = true
} else {
  // No hay store ni localStorage — marcar como cargado igual
  persistedValueLoaded = true
}

// Only persist changes that the user triggered (after load), never the
// initial system-default write that would race with the store.get() call.
watch(isDark, (dark) => {
  applyTheme(dark)
  if (!persistedValueLoaded) return
  if (isElectron) {
    store.set('theme', dark ? 'dark' : 'light').catch(() => {})
  } else {
    localStorage.setItem('vidvault-theme', dark ? 'dark' : 'light')
  }
})

export function useTheme() {
  const toggle = () => {
    isDark.value = !isDark.value
  }
  return { isDark, toggle }
}
