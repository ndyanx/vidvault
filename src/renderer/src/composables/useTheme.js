import { ref, watchEffect } from 'vue'

const isElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'
const store = isElectron ? window.electronAPI.store : null

// Default to system preference; overwritten once the store resolves
const systemDark =
  typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)').matches : false

const isDark = ref(systemDark)

// Load persisted theme on startup
if (isElectron) {
  store
    .get('theme')
    .then((saved) => {
      if (saved === 'dark' || saved === 'light') {
        isDark.value = saved === 'dark'
      }
    })
    .catch(() => {})
} else if (typeof window !== 'undefined') {
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
