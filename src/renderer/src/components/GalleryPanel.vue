<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useVideoLibrary } from '../composables/useVideoLibrary.js'
import { useFavorites } from '../composables/useFavorites.js'
import { formatDuration } from '../utils/format.js'
import VideoSkeleton from './VideoSkeleton.vue'
import VideoModal from './VideoModal.vue'

const { videos, isLoading, processVisible, loadFolder } = useVideoLibrary()
const { isFavorite, toggle: toggleFavorite } = useFavorites()

// ─── Constants ────────────────────────────────────────────────────────────
const GAP = 10
const VIEWPORT_MARGIN = 400 // px of extra rendering margin (virtual scroll)
const PROCESS_LOOKAHEAD = 800 // px below viewport to pre-process (1 extra screen approx)
const DEFAULT_RATIO = 9 / 16

// ─── Search / filter / sort ────────────────────────────────────────────────
const searchQuery = ref('')
const showFavoritesOnly = ref(false)
const sortBy = ref('date') // 'date' | 'name' | 'size' | 'duration'

const SORT_OPTIONS = [
  { value: 'date', label: 'Fecha' },
  { value: 'name', label: 'Nombre' },
  { value: 'size', label: 'Tamaño' },
  { value: 'duration', label: 'Duración' }
]

const filteredVideos = computed(() => {
  let list = videos.value

  const q = searchQuery.value.trim().toLowerCase()
  if (q) list = list.filter((v) => v.fileName.toLowerCase().includes(q))

  if (showFavoritesOnly.value) list = list.filter((v) => isFavorite(v.id))

  list = [...list]
  switch (sortBy.value) {
    case 'name':
      list.sort((a, b) => a.fileName.localeCompare(b.fileName))
      break
    case 'size':
      list.sort((a, b) => (b.size || 0) - (a.size || 0))
      break
    case 'duration':
      list.sort((a, b) => (b.duration || 0) - (a.duration || 0))
      break
    // 'date': already sorted by main process
  }

  return list
})

// ─── Layout ────────────────────────────────────────────────────────────────
const rootRef = ref(null)
const colCount = ref(4)
const colWidth = ref(200)
const scrollTop = ref(0)
const containerHeight = ref(0)
const layoutItems = ref([])

function buildLayout(vids, cols, cw) {
  if (!cw || !cols || !vids.length) {
    layoutItems.value = []
    containerHeight.value = 0
    return
  }
  const colHeights = new Array(cols).fill(0)
  const items = []
  for (let i = 0; i < vids.length; i++) {
    const video = vids[i]
    let minCol = 0
    for (let c = 1; c < cols; c++) {
      if (colHeights[c] < colHeights[minCol]) minCol = c
    }
    const ratio = video.width && video.height ? video.width / video.height : DEFAULT_RATIO
    const cardHeight = Math.round(cw / ratio)
    const x = minCol * (cw + GAP)
    const y = colHeights[minCol]
    items.push({ id: video.id, video, x, y, width: cw, height: cardHeight })
    colHeights[minCol] += cardHeight + GAP
  }
  layoutItems.value = items
  containerHeight.value = Math.max(...colHeights)
}

// ─── Virtualization ────────────────────────────────────────────────────────
const viewportHeight = ref(800)

const visibleItems = computed(() => {
  const top = scrollTop.value - VIEWPORT_MARGIN
  const bottom = scrollTop.value + viewportHeight.value + VIEWPORT_MARGIN
  return layoutItems.value.filter((item) => item.y + item.height > top && item.y < bottom)
})

const handleScroll = (e) => {
  scrollTop.value = e.target.scrollTop
}

// ─── On-demand processing ──────────────────────────────────────────────────
// Items inside viewport + PROCESS_LOOKAHEAD that still need ffprobe/ffmpeg.
// We debounce so rapid scrolling doesn't spam IPC on every pixel.
let processTimer = null
function scheduleProcess() {
  clearTimeout(processTimer)
  processTimer = setTimeout(() => {
    const top = scrollTop.value
    const bottom = top + viewportHeight.value + PROCESS_LOOKAHEAD
    const needsWork = layoutItems.value
      .filter((item) => item.y + item.height > top && item.y < bottom)
      .filter((item) => !item.video.thumbnailUrl || !item.video.width)
      .map((item) => item.video.filePath)
    if (needsWork.length) processVisible(needsWork)
  }, 150)
}

// ─── Sticky scroll ─────────────────────────────────────────────────────────
// When dims arrive and buildLayout() shifts card positions, preserve the
// user's scroll position so the viewport doesn't jump.
let savedScrollTop = null
function saveScroll() {
  if (rootRef.value) savedScrollTop = rootRef.value.scrollTop
}
function restoreScroll() {
  if (rootRef.value && savedScrollTop !== null) {
    rootRef.value.scrollTop = savedScrollTop
    savedScrollTop = null
  }
}

// Watch dims/thumb arriving — after layout rebuilds, restore scroll and
// schedule the next batch of on-demand processing for the new viewport.
watch(
  visibleItems,
  () => {
    nextTick(() => {
      restoreScroll()
      scheduleProcess()
    })
  },
  { flush: 'post' }
)

const getColsForWidth = (w) => {
  if (w < 480) return 1
  if (w < 720) return 2
  if (w < 1024) return 3
  if (w < 1440) return 4
  return 5
}

const updateLayout = () => {
  if (!rootRef.value) return
  saveScroll()
  const w = rootRef.value.clientWidth - 32
  viewportHeight.value = rootRef.value.clientHeight
  const cols = getColsForWidth(w)
  const cw = Math.floor((w - (cols - 1) * GAP) / cols)
  colCount.value = cols
  colWidth.value = cw
  buildLayout(filteredVideos.value, cols, cw)
}

let resizeObserver = null
watch(
  filteredVideos,
  () =>
    nextTick(() => {
      updateLayout()
      scheduleProcess()
    }),
  { flush: 'post' }
)

// ─── Context menu ──────────────────────────────────────────────────────────
const ctxMenu = ref(null)
const ctxRef = ref(null)

const openContextMenu = (e, video) => {
  e.preventDefault()
  // Clamp to viewport so menu doesn't go offscreen
  const menuW = 190,
    menuH = 160
  const x = Math.min(e.clientX, window.innerWidth - menuW - 8)
  const y = Math.min(e.clientY, window.innerHeight - menuH - 8)
  ctxMenu.value = { video, x, y }
}

const closeContextMenu = () => {
  ctxMenu.value = null
}

const ctxShowInFolder = () => {
  window.electronAPI?.showInFolder(ctxMenu.value.video.filePath)
  closeContextMenu()
}
const ctxCopyPath = async () => {
  await window.electronAPI?.copyPath(ctxMenu.value.video.filePath)
  closeContextMenu()
}
const ctxToggleFavorite = () => {
  toggleFavorite(ctxMenu.value.video.id)
  closeContextMenu()
}
const ctxOpenModal = () => {
  openModal(ctxMenu.value.video)
  closeContextMenu()
}

const handleGlobalMousedown = (e) => {
  if (ctxRef.value && !ctxRef.value.contains(e.target)) closeContextMenu()
}

// ─── Modal + keyboard nav ──────────────────────────────────────────────────
const modalVideo = ref(null)
const modalIndex = ref(-1)

const openModal = (video) => {
  modalVideo.value = video
  modalIndex.value = filteredVideos.value.findIndex((v) => v.id === video.id)
}

const closeModal = () => {
  modalVideo.value = null
  modalIndex.value = -1
}

const navigateModal = (dir) => {
  const list = filteredVideos.value
  if (!list.length) return
  const next = modalIndex.value + dir
  if (next < 0 || next >= list.length) return
  modalIndex.value = next
  modalVideo.value = list[next]
}

const handleKey = (e) => {
  if (e.key === 'Escape' && ctxMenu.value) closeContextMenu()
}

// ─── Drag & drop ───────────────────────────────────────────────────────────
const isDraggingFolder = ref(false)

function onGalleryDragOver(e) {
  e.preventDefault()
  isDraggingFolder.value = true
}

function onGalleryDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) {
    isDraggingFolder.value = false
  }
}

async function onGalleryDrop(e) {
  e.preventDefault()
  isDraggingFolder.value = false
  const file = e.dataTransfer.files[0]
  if (!file?.path) return
  await loadFolder(file.path)
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────
onMounted(() => {
  resizeObserver = new ResizeObserver(() => updateLayout())
  if (rootRef.value) resizeObserver.observe(rootRef.value)
  updateLayout()
  document.addEventListener('keydown', handleKey)
  document.addEventListener('mousedown', handleGlobalMousedown)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  document.removeEventListener('keydown', handleKey)
  document.removeEventListener('mousedown', handleGlobalMousedown)
})
</script>

<template>
  <div
    class="gallery-root"
    ref="rootRef"
    @scroll="handleScroll"
    :class="{ 'is-dragging': isDraggingFolder }"
    @dragover="onGalleryDragOver"
    @dragleave="onGalleryDragLeave"
    @drop="onGalleryDrop"
  >
    <!-- Drop overlay -->
    <Transition name="drop-overlay">
      <div v-if="isDraggingFolder" class="drop-overlay" aria-hidden="true">
        <div class="drop-overlay-inner">
          <svg width="32" height="32" viewBox="0 0 16 16" fill="currentColor">
            <path
              d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.764c.414 0 .811.162 1.104.451l.897.898A1.5 1.5 0 0 0 9.37 3.8H13.5A1.5 1.5 0 0 1 15 5.3v7.2A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5z"
            />
          </svg>
          <span>Suelta para abrir esta carpeta</span>
        </div>
      </div>
    </Transition>
    <!-- ── Toolbar ──────────────────────────────────────────────────────── -->
    <div class="gallery-toolbar" v-if="!isLoading && videos.length">
      <div class="search-wrap">
        <svg
          class="search-icon"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          v-model="searchQuery"
          class="search-input"
          placeholder="Buscar por nombre…"
          spellcheck="false"
        />
        <button v-if="searchQuery" class="search-clear" @click="searchQuery = ''">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="sort-wrap">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
        >
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="14" y2="12" />
          <line x1="3" y1="18" x2="8" y2="18" />
        </svg>
        <select v-model="sortBy" class="sort-select">
          <option v-for="opt in SORT_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </div>

      <button
        class="fav-filter-btn"
        :class="{ active: showFavoritesOnly }"
        @click="showFavoritesOnly = !showFavoritesOnly"
        title="Solo favoritos"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          :fill="showFavoritesOnly ? 'currentColor' : 'none'"
          stroke="currentColor"
          stroke-width="2"
        >
          <polygon
            points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
          />
        </svg>
        <span>Favoritos</span>
        <span v-if="showFavoritesOnly" class="fav-count">{{ filteredVideos.length }}</span>
      </button>

      <span class="result-count" v-if="searchQuery || showFavoritesOnly">
        {{ filteredVideos.length }} resultado{{ filteredVideos.length !== 1 ? 's' : '' }}
      </span>
    </div>

    <!-- Skeleton -->
    <VideoSkeleton v-if="isLoading" :count="16" :cols="colCount" />

    <!-- Virtual canvas -->
    <div
      v-else-if="layoutItems.length"
      class="gallery-canvas"
      :style="{ height: containerHeight + 56 + 'px' }"
    >
      <TransitionGroup name="card-remove">
        <div
          v-for="item in visibleItems"
          :key="item.id"
          class="gallery-card"
          :style="{
            position: 'absolute',
            left: item.x + 'px',
            top: item.y + 'px',
            width: item.width + 'px',
            height: item.height + 'px'
          }"
          @click="openModal(item.video)"
          @contextmenu="openContextMenu($event, item.video)"
        >
          <Transition name="thumb-fade">
            <img
              v-if="item.video.thumbnailUrl"
              :key="item.video.thumbnailUrl"
              :src="item.video.thumbnailUrl"
              class="card-thumb"
              draggable="false"
              loading="lazy"
              decoding="async"
            />
            <div v-else class="card-thumb-placeholder">
              <div class="thumb-shimmer" />
            </div>
          </Transition>

          <!-- Favorite button -->
          <button
            class="card-fav-btn"
            :class="{ active: isFavorite(item.video.id) }"
            @click.stop="toggleFavorite(item.video.id)"
            title="Favorito"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              :fill="isFavorite(item.video.id) ? 'currentColor' : 'none'"
              stroke="currentColor"
              stroke-width="2"
            >
              <polygon
                points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
              />
            </svg>
          </button>

          <!-- Duration badge -->
          <div v-if="formatDuration(item.video.duration)" class="card-duration">
            {{ formatDuration(item.video.duration) }}
          </div>

          <!-- Hover overlay -->
          <div class="card-overlay">
            <span class="card-filename">{{ item.video.fileName }}</span>
            <div class="card-meta-row">
              <span class="card-ext">{{ item.video.ext }}</span>
              <span class="card-size">{{ item.video.sizeFormatted }}</span>
            </div>
          </div>

          <!-- Play icon -->
          <div class="card-play-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </div>
        </div>
      </TransitionGroup>

      <div :class="{ 'modal-open': !!modalVideo }" :style="{ top: containerHeight + 8 + 'px' }">
        {{ filteredVideos.length }} video{{ filteredVideos.length !== 1 ? 's' : '' }}
        <template v-if="filteredVideos.length !== videos.length"> de {{ videos.length }}</template>
      </div>
    </div>

    <!-- Empty search -->
    <div v-else-if="!isLoading && (searchQuery || showFavoritesOnly)" class="gallery-empty">
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <p>
        Sin resultados para <em>{{ searchQuery || 'favoritos' }}</em>
      </p>
    </div>

    <!-- Empty folder -->
    <div v-else-if="!isLoading" class="gallery-empty">
      <p>No se encontraron videos en esta carpeta.</p>
    </div>

    <!-- Context menu -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        ref="ctxRef"
        class="ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      >
        <button class="ctx-item" @click="ctxOpenModal">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          Reproducir
        </button>
        <button class="ctx-item" @click="ctxToggleFavorite">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            :fill="ctxMenu && isFavorite(ctxMenu.video.id) ? 'currentColor' : 'none'"
            stroke="currentColor"
            stroke-width="2"
          >
            <polygon
              points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
            />
          </svg>
          {{ ctxMenu && isFavorite(ctxMenu.video.id) ? 'Quitar favorito' : 'Marcar favorito' }}
        </button>
        <div class="ctx-divider" />
        <button class="ctx-item" @click="ctxShowInFolder">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path
              d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.764c.414 0 .811.162 1.104.451l.897.898A1.5 1.5 0 0 0 9.37 3.8H13.5A1.5 1.5 0 0 1 15 5.3v7.2A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5z"
            />
          </svg>
          Mostrar en carpeta
        </button>
        <button class="ctx-item" @click="ctxCopyPath">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          Copiar ruta
        </button>
      </div>
    </Teleport>

    <VideoModal
      :video="modalVideo"
      :has-prev="modalIndex > 0"
      :has-next="modalIndex < filteredVideos.length - 1"
      @close="closeModal"
      @prev="navigateModal(-1)"
      @next="navigateModal(1)"
    />
  </div>
</template>

<style scoped>
.gallery-root {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 16px 16px;
  position: relative;
  scroll-behavior: smooth;
  transition: background 0.15s;
}

.gallery-root.is-dragging {
  background: var(--accent-subtle);
}

/* ─── Drop overlay ────────────────────────────────────────────────────────── */
.drop-overlay {
  position: fixed;
  inset: 0;
  z-index: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed var(--accent);
  border-radius: var(--radius-lg);
  pointer-events: none;
}

.drop-overlay-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--accent);
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  background: var(--bg-elevated);
  padding: 28px 40px;
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-modal);
}

.drop-overlay-enter-active,
.drop-overlay-leave-active {
  transition: opacity 0.15s ease;
}
.drop-overlay-enter-from,
.drop-overlay-leave-to {
  opacity: 0;
}

/* ─── Toolbar ─────────────────────────────────────────────────────────────── */
.gallery-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 160px;
  max-width: 320px;
}

.search-icon {
  position: absolute;
  left: 9px;
  color: var(--text-tertiary);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 6px 28px 6px 28px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.15s;
}
.search-input::placeholder {
  color: var(--text-tertiary);
}
.search-input:focus {
  border-color: var(--accent);
}

.search-clear {
  position: absolute;
  right: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  background: var(--text-tertiary);
  border: none;
  border-radius: 50%;
  cursor: pointer;
  color: var(--bg-elevated);
  padding: 0;
  opacity: 0.7;
  transition: opacity 0.15s;
}
.search-clear:hover {
  opacity: 1;
}

.sort-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-tertiary);
}

.sort-select {
  padding: 5px 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-primary);
  cursor: pointer;
  outline: none;
  transition: border-color 0.15s;
}
.sort-select:focus {
  border-color: var(--accent);
}

.fav-filter-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  font-family: var(--font-display);
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.fav-filter-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.fav-filter-btn.active {
  background: var(--accent-subtle);
  border-color: var(--accent);
  color: var(--accent);
}

.fav-count {
  background: var(--accent);
  color: var(--text-on-accent);
  font-size: 9.5px;
  padding: 1px 5px;
  border-radius: 8px;
}

.result-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

/* ─── Canvas ──────────────────────────────────────────────────────────────── */
.gallery-canvas {
  position: relative;
  width: 100%;
}

/* ─── Card ────────────────────────────────────────────────────────────────── */
.gallery-card {
  border-radius: var(--radius-md);
  overflow: hidden;
  cursor: pointer;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease,
    border-color 0.2s ease;
}
.gallery-card:hover {
  will-change: transform;
  transform: scale(1.018);
  box-shadow: var(--shadow-lg);
  border-color: transparent;
  z-index: 10;
}
.gallery-card:hover .card-overlay {
  opacity: 1;
}
.gallery-card:hover .card-play-icon {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1);
}
.gallery-card:hover .card-fav-btn {
  opacity: 1;
}

/* ─── Thumbnail ───────────────────────────────────────────────────────────── */
.card-thumb,
.card-thumb-placeholder {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
.card-thumb {
  object-fit: cover;
}
.card-thumb-placeholder {
  background: var(--bg-elevated);
  overflow: hidden;
}

.thumb-shimmer {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    105deg,
    transparent 40%,
    rgba(255, 255, 255, 0.06) 50%,
    transparent 60%
  );
  background-size: 200% 100%;
  animation: shimmer-slide 1.8s ease-in-out infinite;
}
[data-theme='light'] .thumb-shimmer {
  background: linear-gradient(
    105deg,
    transparent 40%,
    rgba(255, 255, 255, 0.55) 50%,
    transparent 60%
  );
  background-size: 200% 100%;
}
@keyframes shimmer-slide {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
}
.thumb-fade-enter-active {
  transition: opacity 0.3s ease;
}
.thumb-fade-enter-from {
  opacity: 0;
}

/* ─── Card remove transition (no-stream files on first scan) ──────────────── */
.card-remove-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
  pointer-events: none;
}
.card-remove-leave-to {
  opacity: 0;
  transform: scale(0.95);
}

/* ─── Favorite button ─────────────────────────────────────────────────────── */
.card-fav-btn {
  position: absolute;
  top: 7px;
  right: 7px;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  border: none;
  border-radius: 50%;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.7);
  opacity: 0;
  transition:
    opacity 0.2s,
    color 0.15s,
    background 0.15s;
  padding: 0;
}
.card-fav-btn.active {
  opacity: 1 !important;
  color: #f5c518;
}
.card-fav-btn:hover {
  color: #f5c518;
  background: rgba(0, 0, 0, 0.65);
}

/* ─── Duration badge ──────────────────────────────────────────────────────── */
.card-duration {
  position: absolute;
  bottom: 8px;
  right: 8px;
  z-index: 3;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.92);
  background: rgba(0, 0, 0, 0.58);
  backdrop-filter: blur(3px);
  padding: 2px 6px;
  border-radius: 4px;
  letter-spacing: 0.03em;
  pointer-events: none;
}

/* ─── Overlay ─────────────────────────────────────────────────────────────── */
.card-overlay {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 32px 10px 10px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.72) 0%, transparent 100%);
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
  z-index: 2;
}
.card-filename {
  display: block;
  font-family: var(--font-mono);
  font-size: 10px;
  color: rgba(255, 255, 255, 0.9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 3px;
}
.card-meta-row {
  display: flex;
  align-items: center;
  gap: 5px;
}
.card-ext {
  font-family: var(--font-mono);
  font-size: 8.5px;
  letter-spacing: 0.06em;
  color: var(--accent);
  background: rgba(0, 0, 0, 0.4);
  padding: 1px 5px;
  border-radius: 3px;
}
.card-size {
  font-family: var(--font-mono);
  font-size: 9px;
  color: rgba(255, 255, 255, 0.5);
}

/* ─── Play icon ───────────────────────────────────────────────────────────── */
.card-play-icon {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) scale(0.7);
  opacity: 0;
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
  color: rgba(255, 255, 255, 0.85);
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  border-radius: 50%;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding-left: 3px;
  z-index: 3;
  pointer-events: none;
}

/* ─── Context menu ────────────────────────────────────────────────────────── */
.ctx-menu {
  position: fixed;
  z-index: 9000;
  min-width: 190px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-modal);
  padding: 4px;
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}
.ctx-item svg {
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.ctx-item:hover {
  background: var(--bg-app);
}
.ctx-item:hover svg {
  color: var(--accent);
}
.ctx-divider {
  height: 1px;
  background: var(--border-subtle);
  margin: 3px 0;
}

/* ─── Footer ──────────────────────────────────────────────────────────────── */
.gallery-footer {
  position: absolute;
  left: 0;
  right: 0;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-tertiary);
  padding: 16px 0;
  letter-spacing: 0.03em;
  transition: opacity 0.25s;
}
.gallery-footer.modal-open {
  opacity: 0;
}

/* ─── Empty ───────────────────────────────────────────────────────────────── */
.gallery-empty {
  height: calc(100% - 60px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-tertiary);
}
.gallery-empty em {
  color: var(--text-secondary);
  font-style: normal;
}
</style>
