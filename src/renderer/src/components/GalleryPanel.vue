<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useVideoLibrary } from '../composables/useVideoLibrary.js'
import VideoSkeleton from './VideoSkeleton.vue'
import VideoModal from './VideoModal.vue'

const { videos, isLoading } = useVideoLibrary()

// ─── Constants ────────────────────────────────────────────────────────────
const GAP = 10
const VIEWPORT_MARGIN = 400
const DEFAULT_RATIO = 9 / 16

// ─── Refs ──────────────────────────────────────────────────────────────────
const rootRef = ref(null)
const colCount = ref(4)
const colWidth = ref(200)
const scrollTop = ref(0)
const containerHeight = ref(0)

// ─── Layout ────────────────────────────────────────────────────────────────
// layoutItems[i] = { id, video, x, y, width, height }
// Keeping video ref here is fine — it's a single shared reactive object,
// not duplicated data (no large buffers, just metadata).
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
  return layoutItems.value.filter((item) => {
    const itemBottom = item.y + item.height
    return itemBottom > top && item.y < bottom
  })
})

// ─── Scroll ────────────────────────────────────────────────────────────────
const handleScroll = (e) => {
  scrollTop.value = e.target.scrollTop
}

// ─── Responsive columns ────────────────────────────────────────────────────
const getColsForWidth = (w) => {
  if (w < 480) return 1
  if (w < 720) return 2
  if (w < 1024) return 3
  if (w < 1440) return 4
  return 5
}

const updateLayout = () => {
  if (!rootRef.value) return
  const w = rootRef.value.clientWidth - 32
  viewportHeight.value = rootRef.value.clientHeight
  const cols = getColsForWidth(w)
  const cw = Math.floor((w - (cols - 1) * GAP) / cols)
  colCount.value = cols
  colWidth.value = cw
  buildLayout(videos.value, cols, cw)
}

let resizeObserver = null

// ─── Rebuild layout when videos change (e.g. thumbnails updating dimensions)
watch(videos, () => nextTick(() => updateLayout()), { flush: 'post', deep: false })

// ─── Modal ─────────────────────────────────────────────────────────────────
const modalVideo = ref(null)

const openModal = (video) => {
  modalVideo.value = video
}

const closeModal = () => {
  modalVideo.value = null
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────
onMounted(() => {
  resizeObserver = new ResizeObserver(() => updateLayout())
  if (rootRef.value) resizeObserver.observe(rootRef.value)
  updateLayout()
})

onUnmounted(() => {
  resizeObserver?.disconnect()
})
</script>

<template>
  <div class="gallery-root" ref="rootRef" @scroll="handleScroll">
    <!-- Skeleton while loading -->
    <VideoSkeleton v-if="isLoading" :count="16" :cols="colCount" />

    <!-- Virtual canvas -->
    <div
      v-else-if="layoutItems.length"
      class="gallery-canvas"
      :style="{ height: containerHeight + 56 + 'px' }"
    >
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
      >
        <!-- Thumbnail image — shows skeleton shimmer until thumbnailUrl arrives -->
        <Transition name="thumb-fade">
          <img
            v-if="item.video.thumbnailUrl"
            :key="item.video.thumbnailUrl"
            :src="item.video.thumbnailUrl"
            class="card-thumb"
            draggable="false"
            loading="lazy"
          />
          <div v-else class="card-thumb-placeholder">
            <div class="thumb-shimmer" />
          </div>
        </Transition>

        <!-- Hover overlay -->
        <div class="card-overlay">
          <span class="card-filename">{{ item.video.fileName }}</span>
          <div class="card-meta-row">
            <span class="card-ext">{{ item.video.ext }}</span>
            <span class="card-size">{{ item.video.sizeFormatted }}</span>
          </div>
        </div>

        <!-- Play icon (always visible on hover) -->
        <div class="card-play-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </div>
      </div>

      <!-- Footer -->
      <div
        class="gallery-footer"
        :class="{ 'modal-open': !!modalVideo }"
        :style="{ top: containerHeight + 8 + 'px' }"
      >
        {{ videos.length }} video{{ videos.length !== 1 ? 's' : '' }} · {{ visibleItems.length }} en
        pantalla
      </div>
    </div>

    <!-- Empty -->
    <div v-else-if="!isLoading" class="gallery-empty">
      <p>No se encontraron videos en esta carpeta.</p>
    </div>

    <VideoModal :video="modalVideo" @close="closeModal" />
  </div>
</template>

<style scoped>
.gallery-root {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px;
  position: relative;
  scroll-behavior: smooth;
}

.gallery-canvas {
  position: relative;
  width: 100%;
}

/* ─── Card ─────────────────────────────────────────────────────────────── */
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

/* ─── Thumbnail ─────────────────────────────────────────────────────────── */
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

/* Shimmer inside placeholder while thumbnail loads */
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

/* Smooth thumbnail appearance */
.thumb-fade-enter-active {
  transition: opacity 0.3s ease;
}
.thumb-fade-enter-from {
  opacity: 0;
}

/* ─── Overlay ─────────────────────────────────────────────────────────── */
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

/* ─── Play icon ─────────────────────────────────────────────────────────── */
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

/* ─── Footer ─────────────────────────────────────────────────────────────── */
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

/* ─── Empty ──────────────────────────────────────────────────────────────── */
.gallery-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-tertiary);
}
</style>
