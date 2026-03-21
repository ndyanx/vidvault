<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  video: { type: Object, default: null }
})

const emit = defineEmits(['close'])

const videoRef = ref(null)

// Play when modal opens, pause when closes
watch(
  () => props.video,
  async (newVideo) => {
    if (newVideo && videoRef.value) {
      await nextTick()
      videoRef.value.play().catch(() => {})
    }
  }
)

// Close on Escape
const handleKey = (e) => {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  document.addEventListener('keydown', handleKey)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKey)
})

function formatSize(bytes) {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

import { nextTick } from 'vue'
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="video" class="modal-backdrop" @click.self="$emit('close')">
        <div class="modal-container">
          <!-- Header -->
          <div class="modal-header">
            <div class="modal-file-info">
              <span class="modal-ext-badge">{{ video.ext }}</span>
              <span class="modal-filename selectable">{{ video.fileName }}</span>
            </div>
            <div class="modal-meta">
              <span class="meta-chip">{{ formatSize(video.size) }}</span>
              <span v-if="video.width && video.height" class="meta-chip"
                >{{ video.width }}×{{ video.height }}</span
              >
            </div>
            <button class="close-btn" @click="$emit('close')" title="Cerrar (Esc)">
              <svg
                width="16"
                height="16"
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

          <!-- Video -->
          <div class="modal-video-wrap">
            <video
              ref="videoRef"
              :src="video.videoUrl"
              controls
              autoplay
              loop
              class="modal-video"
            />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.82);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.modal-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: min(90vw, 1000px);
  max-height: 92vh;
  gap: 12px;
}

.modal-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.modal-file-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.modal-ext-badge {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.06em;
  color: var(--accent);
  background: var(--accent-subtle);
  border: 1px solid var(--accent);
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}

.modal-filename {
  font-family: var(--font-mono);
  font-size: 12px;
  color: rgba(255, 255, 255, 0.75);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modal-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.meta-chip {
  font-family: var(--font-mono);
  font-size: 10px;
  color: rgba(255, 255, 255, 0.45);
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12);
  padding: 2px 8px;
  border-radius: 20px;
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: rgba(255, 255, 255, 0.7);
  transition:
    background 0.15s,
    color 0.15s;
  flex-shrink: 0;
}

.close-btn:hover {
  background: rgba(220, 50, 40, 0.7);
  border-color: transparent;
  color: white;
}

.modal-video-wrap {
  flex: 1;
  min-height: 0;
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-video {
  width: 100%;
  height: 100%;
  max-height: calc(92vh - 80px);
  object-fit: contain;
  display: block;
}

/* Transition */
.modal-enter-active {
  transition: opacity 0.22s ease;
}
.modal-leave-active {
  transition: opacity 0.18s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-active .modal-container {
  animation: modal-slide-up 0.22s ease;
}
.modal-leave-active .modal-container {
  animation: modal-slide-down 0.18s ease;
}

@keyframes modal-slide-up {
  from {
    transform: translateY(20px) scale(0.98);
    opacity: 0;
  }
  to {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
}
@keyframes modal-slide-down {
  from {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
  to {
    transform: translateY(12px) scale(0.98);
    opacity: 0;
  }
}

@media (max-width: 600px) {
  .modal-backdrop {
    padding: 12px;
  }
  .modal-video {
    max-height: calc(95vh - 70px);
  }
}
</style>
