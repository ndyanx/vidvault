<script setup>
import { useVideoLibrary } from '../composables/useVideoLibrary.js'
const { openFolderDialog } = useVideoLibrary()
</script>

<template>
  <div class="empty-root">
    <div class="empty-card">
      <!-- Grid decoration -->
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
  </div>
</template>

<style scoped>
.empty-root {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
}

.empty-card {
  position: relative;
  width: 100%;
  max-width: 420px;
  background: var(--bg-surface);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-xl);
  overflow: hidden;
  box-shadow: var(--shadow-md);
}

/* 3×3 animated grid decoration at top */
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

.deco-cell:nth-child(2) .deco-inner {
  background: linear-gradient(135deg, var(--accent-subtle) 0%, var(--bg-elevated) 100%);
}
.deco-cell:nth-child(5) .deco-inner {
  background: linear-gradient(135deg, var(--accent-subtle) 0%, var(--bg-elevated) 100%);
  opacity: 0.6;
}
.deco-cell:nth-child(8) .deco-inner {
  background: linear-gradient(135deg, var(--accent-subtle) 0%, var(--bg-elevated) 100%);
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
</style>
