import { ref } from 'vue'

const isElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'
const store = isElectron ? window.electronAPI.store : null

// Singleton reactive set — loaded async in initFavorites(), used sync everywhere else
const favSet = ref(new Set())
let initPromise = null

async function ensureInit() {
  if (!isElectron) return
  try {
    const ids = await store.get('favorites')
    favSet.value = new Set(Array.isArray(ids) ? ids : [])
  } catch {
    favSet.value = new Set()
  }
}

// Call once at app startup (from App.vue onMounted)
export async function initFavorites() {
  if (!initPromise) initPromise = ensureInit()
  return initPromise
}

export function useFavorites() {
  const isFavorite = (id) => favSet.value.has(id)

  const toggle = async (id) => {
    const next = new Set(favSet.value)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    favSet.value = next
    if (isElectron) {
      await store.set('favorites', [...next])
    }
  }

  return { favSet, isFavorite, toggle }
}
