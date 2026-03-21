import { ref, watchEffect } from 'vue'

const STORAGE_KEY = 'vidvault-theme'

// Detect system preference as default
const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
const saved = localStorage.getItem(STORAGE_KEY)

const isDark = ref(saved ? saved === 'dark' : systemDark)

watchEffect(() => {
  document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light')
  localStorage.setItem(STORAGE_KEY, isDark.value ? 'dark' : 'light')
})

export function useTheme() {
  const toggle = () => {
    isDark.value = !isDark.value
  }
  return { isDark, toggle }
}
