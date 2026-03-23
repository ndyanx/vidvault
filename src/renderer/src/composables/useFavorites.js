import { ref } from 'vue'

const isElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'
const store = isElectron ? window.electronAPI.store : null

// Singleton reactive set — initialized async in init(), used sync everywhere else
const favSet = ref(new Set())
let initialized = false

async function ensureInit() {
  if (initialized || !isElectron) return
  initialized = true
  try {
    const ids = await store.get('favorites')
    favSet.value = new Set(Array.isArray(ids) ? ids : [])
  } catch {
    favSet.value = new Set()
  }
}

// Call once at app startup (from useVideoLibrary.init or App.vue onMounted)
export async function initFavorites() {
  await ensureInit()
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
    // Persist as plain array — JSON-serializable
    if (isElectron) {
      await store.set('favorites', [...next])
    }
  }

  return { favSet, isFavorite, toggle }
}
