import { ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'

const isElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'
const store = isElectron ? window.electronAPI.store : null

const locale = ref('es')

// Load persisted locale on startup
if (isElectron) {
  store
    .get('locale')
    .then((saved) => {
      if (saved === 'es' || saved === 'en') locale.value = saved
    })
    .catch(() => {})
} else if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('vidvault-locale')
  if (saved === 'es' || saved === 'en') locale.value = saved
}

// Persist on change
watchEffect(() => {
  if (isElectron) {
    store.set('locale', locale.value).catch(() => {})
  } else {
    localStorage.setItem('vidvault-locale', locale.value)
  }
})

export function useLocale() {
  const { locale: i18nLocale } = useI18n()

  // Keep vue-i18n in sync with our global ref
  watchEffect(() => {
    i18nLocale.value = locale.value
  })

  function toggle() {
    locale.value = locale.value === 'es' ? 'en' : 'es'
  }

  return { locale, toggle }
}
