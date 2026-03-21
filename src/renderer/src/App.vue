<script setup>
import { onMounted } from 'vue'
import { useTheme } from './composables/useTheme.js'
import { useVideoLibrary } from './composables/useVideoLibrary.js'
import TitleBar from './components/TitleBar.vue'
import GalleryPanel from './components/GalleryPanel.vue'
import EmptyState from './components/EmptyState.vue'

const { isDark, toggle } = useTheme()
const { init, isEmpty, isLoading } = useVideoLibrary()

onMounted(() => init())
</script>

<template>
  <div class="app-root">
    <TitleBar :isDark="isDark" @toggle-theme="toggle" />
    <main class="app-body">
      <EmptyState v-if="isEmpty && !isLoading" />
      <GalleryPanel v-else />
    </main>
  </div>
</template>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-app);
  overflow: hidden;
}

.app-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
</style>
