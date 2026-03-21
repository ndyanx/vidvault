<script setup>
import { useVideoLibrary } from '../composables/useVideoLibrary.js'

const props = defineProps({
  isDark: Boolean
})
const emit = defineEmits(['toggle-theme'])

const { folderName, openFolderDialog, isLoading, videos } = useVideoLibrary()
</script>

<template>
  <header class="titlebar">
    <!-- macOS traffic light spacer -->
    <div class="traffic-lights-spacer" />

    <!-- App name -->
    <div class="titlebar-brand">
      <span class="brand-icon">▣</span>
      <span class="brand-name">VidVault</span>
    </div>

    <!-- Center: current folder info -->
    <div class="titlebar-center">
      <Transition name="fade">
        <div v-if="folderName" class="folder-pill">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path
              d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.764c.414 0 .811.162 1.104.451l.897.898A1.5 1.5 0 0 0 9.37 3.8H13.5A1.5 1.5 0 0 1 15 5.3v7.2A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5z"
            />
          </svg>
          <span class="folder-name">{{ folderName }}</span>
          <span v-if="videos.length > 0" class="video-count">{{ videos.length }}</span>
        </div>
      </Transition>
    </div>

    <!-- Right controls -->
    <div class="titlebar-controls">
      <!-- Open folder -->
      <button
        class="ctrl-btn open-btn"
        @click="openFolderDialog"
        :disabled="isLoading"
        title="Abrir carpeta de videos"
      >
        <svg v-if="!isLoading" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path
            d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.764c.414 0 .811.162 1.104.451l.897.898A1.5 1.5 0 0 0 9.37 3.8H13.5A1.5 1.5 0 0 1 15 5.3v7.2A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5z"
          />
        </svg>
        <svg
          v-else
          class="spin"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        <span>{{ isLoading ? 'Cargando…' : 'Abrir carpeta' }}</span>
      </button>

      <!-- Theme toggle -->
      <button
        class="ctrl-btn icon-btn"
        @click="$emit('toggle-theme')"
        :title="isDark ? 'Modo claro' : 'Modo oscuro'"
      >
        <!-- Sun -->
        <svg
          v-if="isDark"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
        <!-- Moon -->
        <svg
          v-else
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  height: 48px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px 0 0;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-subtle);
  -webkit-app-region: drag; /* makes the titlebar draggable in Electron */
  flex-shrink: 0;
  position: relative;
  z-index: 100;
}

/* All interactive children must opt out of drag */
button,
a,
input {
  -webkit-app-region: no-drag;
}

.traffic-lights-spacer {
  width: 72px; /* macOS traffic lights: ~68px */
  flex-shrink: 0;
}

.titlebar-brand {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
}

.brand-icon {
  font-size: 15px;
  color: var(--accent);
  line-height: 1;
}

.brand-name {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-primary);
}

.titlebar-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.folder-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 20px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  max-width: 320px;
}

.folder-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font-weight: 500;
}

.video-count {
  background: var(--accent-subtle);
  color: var(--accent);
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 10px;
  flex-shrink: 0;
}

.titlebar-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}

.ctrl-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  transition:
    background 0.15s,
    border-color 0.15s,
    transform 0.1s;
}

.ctrl-btn:hover:not(:disabled) {
  background: var(--bg-app);
  border-color: var(--border-strong);
}

.ctrl-btn:active:not(:disabled) {
  transform: scale(0.97);
}

.ctrl-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.open-btn {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-subtle);
}

.open-btn:hover:not(:disabled) {
  background: var(--accent);
  color: var(--text-on-accent);
  border-color: var(--accent);
}

.icon-btn {
  padding: 6px 8px;
  color: var(--text-secondary);
}

.icon-btn:hover {
  color: var(--text-primary);
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* Transition */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
