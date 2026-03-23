import { ref, watchEffect } from 'vue'

const isElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'
const store = isElectron ? window.electronAPI.store : null

// Detect system preference as default
const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches

// Start with system preference; will be overwritten once store resolves
const isDark = ref(systemDark)

// Load persisted value from Electron store
if (isElectron) {
  store
    .get('theme')
    .then((saved) => {
      if (saved === 'dark' || saved === 'light') {
        isDark.value = saved === 'dark'
      }
    })
    .catch(() => {})
} else {
  // Fallback for browser/dev context
  const saved = localStorage.getItem('vidvault-theme')
  if (saved) isDark.value = saved === 'dark'
}

watchEffect(() => {
  document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light')
  if (isElectron) {
    store.set('theme', isDark.value ? 'dark' : 'light').catch(() => {})
  } else {
    localStorage.setItem('vidvault-theme', isDark.value ? 'dark' : 'light')
  }
})

export function useTheme() {
  const toggle = () => {
    isDark.value = !isDark.value
  }
  return { isDark, toggle }
}
