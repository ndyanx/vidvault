<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useVideoLibrary } from '../composables/useVideoLibrary.js'
import VideoSkeleton from './VideoSkeleton.vue'
import VideoModal from './VideoModal.vue'

const { videos, isLoading, updateVideoDimensions } = useVideoLibrary()

// ─── Progressive render ────────────────────────────────────────────────────
// Same strategy as the original: render INITIAL_RENDER first, then add
// BATCH_SIZE per idle frame so the thread never blocks on large libraries.
const INITIAL_RENDER = 20
const BATCH_SIZE = 20
const renderedCount = ref(INITIAL_RENDER)
let idleCallbackId = null
let isMounted = false

const scheduleProgressiveRender = () => {
  if (renderedCount.value >= videos.value.length) return
  const tick = () => {
    renderedCount.value = Math.min(renderedCount.value + BATCH_SIZE, videos.value.length)
    if (renderedCount.value < videos.value.length) {
      idleCallbackId = requestIdleCallback(tick, { timeout: 300 })
    }
  }
  idleCallbackId = requestIdleCallback(tick, { timeout: 300 })
}

// Watch for library changes (new folder loaded)
let prevSignature = ''
const getSignature = (vs) => vs.map((v) => v.id).join('|')

watch(
  videos,
  (newVideos) => {
    if (!isMounted) return
    const sig = getSignature(newVideos)
    if (sig === prevSignature) return
    prevSignature = sig

    if (idleCallbackId) cancelIdleCallback(idleCallbackId)
    renderedCount.value = INITIAL_RENDER
    rebuildColumns(INITIAL_RENDER, colCount.value)
    scheduleProgressiveRender()
  },
  { flush: 'post' }
)

// ─── Aspect ratio ──────────────────────────────────────────────────────────
const runtimeRatios = ref({})

const getCardAspect = (video) => {
  if (video.width && video.height) return `${video.width} / ${video.height}`
  if (runtimeRatios.value[video.id]) return `${runtimeRatios.value[video.id]} / 1`
  return '9 / 16' // default portrait until metadata loads
}

const handleMetadata = (e, video) => {
  const { videoWidth, videoHeight } = e.target
  if (!videoWidth || !videoHeight) return
  if (video.width && video.height) return

  const ratio = videoWidth / videoHeight
  runtimeRatios.value = { ...runtimeRatios.value, [video.id]: ratio }
  updateVideoDimensions(video.id, videoWidth, videoHeight)
}

// ─── Responsive columns via ResizeObserver ─────────────────────────────────
const rootRef = ref(null)
const colCount = ref(4)

const getColsForWidth = (w) => {
  if (w < 480) return 1
  if (w < 720) return 2
  if (w < 1024) return 3
  if (w < 1440) return 4
  return 5
}

// ─── Column distribution (incremental O(batch), not O(n²)) ────────────────
const columnArrays = ref(Array.from({ length: colCount.value }, () => []))

const rebuildColumns = (count, cols) => {
  const result = Array.from({ length: cols }, () => [])
  videos.value.slice(0, count).forEach((v, i) => result[i % cols].push(v))
  columnArrays.value = result
}

watch(
  colCount,
  (newCols) => {
    rebuildColumns(renderedCount.value, newCols)
  },
  { flush: 'post' }
)

watch(
  renderedCount,
  (newCount, oldCount) => {
    if (newCount <= oldCount) return
    const cols = colCount.value
    const newVideos = videos.value.slice(oldCount, newCount)
    newVideos.forEach((v, i) => {
      columnArrays.value[(oldCount + i) % cols].push(v)
    })
    columnArrays.value = [...columnArrays.value]
  },
  { flush: 'post' }
)

let resizeObserver = null
const initResizeObserver = () => {
  if (!rootRef.value) return
  const w = rootRef.value.offsetWidth || window.innerWidth
  colCount.value = getColsForWidth(w)
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const width = entry.contentRect.width
      if (width > 0) colCount.value = getColsForWidth(width)
    }
  })
  resizeObserver.observe(rootRef.value)
}

// ─── IntersectionObserver (play/pause on viewport) ─────────────────────────
const visibleMap = ref({})
const videoEls = {}
const playTimers = {}
const PLAY_DELAY = 1800 // ms before autoplay starts

const schedulePlay = (id) => {
  if (playTimers[id]) return
  playTimers[id] = setTimeout(() => {
    delete playTimers[id]
    if (!modalVideo.value) videoEls[id]?.play().catch(() => {})
  }, PLAY_DELAY)
}

const cancelPlay = (id) => {
  if (playTimers[id]) {
    clearTimeout(playTimers[id])
    delete playTimers[id]
  }
}

const setCardRef = (el) => {
  if (el) intersectionObserver?.observe(el)
}

const setVideoRef = (el, id) => {
  if (el) videoEls[id] = el
  else delete videoEls[id]
}

let intersectionObserver = null

const initIntersectionObserver = () => {
  intersectionObserver = new IntersectionObserver(
    (entries) => {
      const next = { ...visibleMap.value }
      let changed = false

      entries.forEach((entry) => {
        const id = entry.target.dataset.videoid
        if (!id) return
        if (entry.isIntersecting) {
          if (!next[id]) {
            next[id] = true
            changed = true
          }
          schedulePlay(id)
        } else {
          if (next[id]) {
            delete next[id]
            changed = true
          }
          cancelPlay(id)
          videoEls[id]?.pause()
        }
      })

      if (changed) visibleMap.value = next
    },
    { rootMargin: '200px 0px 200px 0px', threshold: 0 }
  )
}

// ─── Skeleton state ────────────────────────────────────────────────────────
// Show skeleton during loading OR during the initial progressive render
const showSkeleton = computed(() => isLoading.value)

// ─── Modal ─────────────────────────────────────────────────────────────────
const modalVideo = ref(null)

const openModal = (video) => {
  // Pause all grid videos
  Object.values(videoEls).forEach((el) => el?.pause())
  Object.keys(playTimers).forEach((id) => cancelPlay(id))
  modalVideo.value = video
}

const closeModal = () => {
  modalVideo.value = null
  // Resume visible videos after modal closes
  nextTick(() => {
    Object.entries(visibleMap.value).forEach(([id, visible]) => {
      if (visible) schedulePlay(id)
    })
  })
}

// ─── Lifecycle ────────────────────────────────────────────────────────────
onMounted(() => {
  isMounted = true
  initResizeObserver()
  initIntersectionObserver()

  if (videos.value.length > 0) {
    prevSignature = getSignature(videos.value)
    rebuildColumns(INITIAL_RENDER, colCount.value)
    scheduleProgressiveRender()
  }
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  intersectionObserver?.disconnect()
  if (idleCallbackId) cancelIdleCallback(idleCallbackId)
  Object.keys(playTimers).forEach((id) => cancelPlay(id))
})
</script>

<template>
  <div class="gallery-root" ref="rootRef">
    <!-- Skeleton while loading -->
    <VideoSkeleton v-if="showSkeleton" :count="16" :cols="colCount" />

    <!-- Masonry grid -->
    <div v-else class="gallery-masonry" :class="{ 'modal-open': !!modalVideo }">
      <div v-for="(col, colIdx) in columnArrays" :key="colIdx" class="gallery-col">
        <div
          v-for="video in col"
          :key="video.id"
          class="gallery-card"
          :data-videoid="video.id"
          :ref="(el) => setCardRef(el)"
          @click="openModal(video)"
        >
          <!-- Aspect ratio sizer -->
          <div class="card-ratio" :style="{ aspectRatio: getCardAspect(video) }">
            <!-- Skeleton shimmer until video metadata loads -->
            <div v-if="!runtimeRatios[video.id] && !video.width" class="card-skeleton">
              <div class="card-shimmer" />
            </div>

            <!-- Video element -->
            <video
              v-if="visibleMap[video.id]"
              :ref="(el) => setVideoRef(el, video.id)"
              :src="video.videoUrl"
              muted
              loop
              playsinline
              preload="metadata"
              class="card-video"
              @loadedmetadata="handleMetadata($event, video)"
            />

            <!-- Placeholder when off-screen -->
            <div v-else class="card-placeholder" />

            <!-- Hover overlay with filename -->
            <div class="card-overlay">
              <span class="card-filename">{{ video.fileName }}</span>
              <div class="card-meta-row">
                <span class="card-ext">{{ video.ext }}</span>
                <span class="card-size">{{ video.sizeFormatted }}</span>
              </div>
            </div>

            <!-- Play icon on hover -->
            <div class="card-play-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer count -->
    <div
      v-if="!showSkeleton && videos.length > 0"
      class="gallery-footer"
      :class="{ 'modal-open': !!modalVideo }"
    >
      {{
        renderedCount < videos.length
          ? `Mostrando ${renderedCount} de ${videos.length} videos…`
          : `${videos.length} video${videos.length !== 1 ? 's' : ''}`
      }}
    </div>

    <!-- Modal -->
    <VideoModal :video="modalVideo" @close="closeModal" />
  </div>
</template>

<style scoped>
.gallery-root {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px;
  scroll-behavior: smooth;
}

/* ─── Masonry ─────────────────────────────────────────────────────────────── */
.gallery-masonry {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  position: relative;
}

/* Dim overlay behind modal using ::after — avoids repainting all children */
.gallery-masonry::after {
  content: '';
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0);
  pointer-events: none;
  z-index: 1999;
  transition: background 0.25s ease;
}

.gallery-masonry.modal-open::after {
  background: rgba(0, 0, 0, 0.5);
  pointer-events: auto;
}

.gallery-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ─── Card ────────────────────────────────────────────────────────────────── */
.gallery-card {
  width: 100%;
  border-radius: var(--radius-md);
  overflow: hidden;
  cursor: pointer;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  flex-shrink: 0;
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
}

.gallery-card:hover .card-overlay {
  opacity: 1;
}

.gallery-card:hover .card-play-icon {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1);
}

/* ─── Card ratio wrapper ──────────────────────────────────────────────────── */
.card-ratio {
  width: 100%;
  position: relative;
  overflow: hidden;
}

/* ─── Video & placeholder ─────────────────────────────────────────────────── */
.card-video,
.card-placeholder {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.card-placeholder {
  background: var(--bg-elevated);
}

/* ─── Per-card skeleton shimmer ───────────────────────────────────────────── */
.card-skeleton {
  position: absolute;
  inset: 0;
  background: var(--bg-elevated);
  overflow: hidden;
  z-index: 1;
}

.card-shimmer {
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, transparent 35%, var(--border-medium) 50%, transparent 65%);
  background-size: 200% 100%;
  animation: card-shimmer 1.6s ease-in-out infinite;
}

@keyframes card-shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
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
  font-weight: 400;
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
  padding-left: 3px; /* optical centering of triangle */
  z-index: 3;
  pointer-events: none;
}

/* ─── Footer ──────────────────────────────────────────────────────────────── */
.gallery-footer {
  text-align: center;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-tertiary);
  padding: 24px 0 12px;
  transition: opacity 0.25s ease;
  letter-spacing: 0.03em;
}

.gallery-footer.modal-open {
  opacity: 0;
}
</style>
