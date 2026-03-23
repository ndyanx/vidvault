<script setup>
// EmptyState.vue
// Folder thumbnails are no longer stored in localStorage.
// The main process derives thumb paths deterministically from filePath,
// so we can't reconstruct them here without an IPC call.
// Instead we show a clean folder-icon placeholder for all recent entries.
// If you want previews back, the right approach would be a new IPC handler
// `store:getFolderThumb(path)` that checks the bucketed thumbnail dir.

import { useVideoLibrary } from '../composables/useVideoLibrary.js'

const { openFolderDialog, folderHistory, loadFolder, deleteFromHistory } = useVideoLibrary()
</script>

<template>
  <div class="empty-root">
    <div class="empty-card">
      <!-- Deco grid -->
      <div class="deco-grid" aria-hidden="true">
        <div v-for="i in 9" :key="i" class="deco-cell" :style="{ animationDelay: `${i * 0.08}s` }">
          <div class="deco-inner" />
        </div>
      </div>

      <div class="empty-content">
        <div class="empty-icon-wrap">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path
              d="M22.54 6.42a2.78 2.78 0 0 0-1.94-1.95C18.88 4 12 4 12 4s-6.88 0-8.6.47a2.78 2.78 0 0 0-1.94 1.95A29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58A2.78 2.78 0 0 0 3.4 19.53C5.12 20 12 20 12 20s6.88 0 8.6-.47a2.78 2.78 0 0 0 1.94-1.95A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58z"
            />
            <polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02" />
          </svg>
        </div>
        <h1 class="empty-title">Sin videos</h1>
        <p class="empty-desc">
          Abre una carpeta con tus videos locales y aparecerán organizados en un masonry gallery.
        </p>
        <button class="open-btn" @click="openFolderDialog">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
            <path
              d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.764c.414 0 .811.162 1.104.451l.897.898A1.5 1.5 0 0 0 9.37 3.8H13.5A1.5 1.5 0 0 1 15 5.3v7.2A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5z"
            />
          </svg>
          Abrir carpeta
        </button>
        <p class="empty-hint">mp4 · mov · mkv · avi · webm y más</p>
      </div>
    </div>

    <!-- Recent folders -->
    <div v-if="folderHistory.length" class="recents">
      <div class="recents-header">Recientes</div>
      <div class="recents-grid">
        <div
          v-for="entry in folderHistory"
          :key="entry.path"
          class="recent-card"
          @click="loadFolder(entry.path)"
        >
          <div class="recent-thumb">
            <div class="recent-thumb-placeholder">
              <svg
                width="20"
                height="20"
                viewBox="0 0 16 16"
                fill="currentColor"
                style="color: var(--text-tertiary)"
              >
                <path
                  d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.764c.414 0 .811.162 1.104.451l.897.898A1.5 1.5 0 0 0 9.37 3.8H13.5A1.5 1.5 0 0 1 15 5.3v7.2A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5z"
                />
              </svg>
            </div>
          </div>

          <div class="recent-info">
            <span class="recent-name">{{ entry.name }}</span>
            <span class="recent-path">{{ entry.path }}</span>
          </div>

          <button
            class="recent-remove"
            @click.stop="deleteFromHistory(entry.path)"
            title="Eliminar del historial"
          >
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
      </div>
    </div>
  </div>
</template>

<style scoped>
.empty-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 40px;
  gap: 28px;
  overflow-y: auto;
}

/* ─── Main card ───────────────────────────────────────────────────────────── */
.empty-card {
  position: relative;
  width: 100%;
  max-width: 420px;
  background: var(--bg-surface);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-xl);
  overflow: hidden;
  box-shadow: var(--shadow-md);
  flex-shrink: 0;
}

.deco-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
  padding: 2px;
  height: 160px;
  background: var(--border-subtle);
}
.deco-cell {
  background: var(--bg-elevated);
  border-radius: 4px;
  overflow: hidden;
  animation: pulse-cell 3s ease-in-out infinite;
}
.deco-inner {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, var(--bg-app) 0%, var(--bg-elevated) 100%);
}
.deco-cell:nth-child(2) .deco-inner,
.deco-cell:nth-child(5) .deco-inner,
.deco-cell:nth-child(8) .deco-inner {
  background: linear-gradient(135deg, var(--accent-subtle) 0%, var(--bg-elevated) 100%);
}
.deco-cell:nth-child(5) .deco-inner {
  opacity: 0.6;
}

@keyframes pulse-cell {
  0%,
  100% {
    opacity: 0.5;
  }
  50% {
    opacity: 1;
  }
}

.empty-content {
  padding: 32px 36px 36px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 10px;
}
.empty-icon-wrap {
  color: var(--accent);
  margin-bottom: 4px;
}
.empty-title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
}
.empty-desc {
  font-size: 13.5px;
  color: var(--text-secondary);
  line-height: 1.6;
  max-width: 280px;
}

.open-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 10px 22px;
  background: var(--accent);
  color: var(--text-on-accent);
  border: none;
  border-radius: var(--radius-md);
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.15s,
    transform 0.1s;
}
.open-btn:hover {
  background: var(--accent-hover);
}
.open-btn:active {
  transform: scale(0.97);
}

.empty-hint {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-tertiary);
  letter-spacing: 0.05em;
}

/* ─── Recents ─────────────────────────────────────────────────────────────── */
.recents {
  width: 100%;
  max-width: 560px;
}

.recents-header {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-tertiary);
  margin-bottom: 8px;
  padding-left: 2px;
}

.recents-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.recent-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
  position: relative;
}
.recent-card:hover {
  background: var(--bg-elevated);
  border-color: var(--border-medium);
}
.recent-card:hover .recent-remove {
  opacity: 1;
}

.recent-thumb {
  width: 48px;
  height: 32px;
  border-radius: 5px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg-elevated);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-subtle);
}
.recent-thumb-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.recent-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.recent-name {
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.recent-path {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recent-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-tertiary);
  opacity: 0;
  flex-shrink: 0;
  transition:
    opacity 0.15s,
    background 0.15s,
    color 0.15s;
}
.recent-remove:hover {
  background: rgba(220, 50, 40, 0.12);
  color: #dc3228;
}
</style>
