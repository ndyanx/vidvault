import { app, BrowserWindow, ipcMain, dialog, protocol, shell, clipboard } from 'electron'
import { join, extname } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  readdirSync,
  statSync,
  createReadStream,
  existsSync,
  readFileSync,
  mkdirSync,
  renameSync
} from 'fs'
import { writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'

// ─── Debounce helper ───────────────────────────────────────────────────────
function debounce(fn, ms) {
  let timer = null
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

const execFileAsync = promisify(execFile)

// ─── Video extensions ──────────────────────────────────────────────────────
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.mkv',
  '.avi',
  '.webm',
  '.m4v',
  '.wmv',
  '.flv',
  '.3gp',
  '.ts',
  '.mts'
])

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.ts': 'video/mp2t',
  '.mts': 'video/mp2t'
}

// ─── Register protocol before app ready ───────────────────────────────────
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'localvideo',
    privileges: {
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
])

// ─── app-state.json ────────────────────────────────────────────────────────
// Single JSON file in userData that replaces all localStorage usage.
// Shape: { lastFolder, folderHistory, favorites }
// - lastFolder:    string | null
// - folderHistory: [{ path, name, lastOpened }]   max 8 entries
// - favorites:     string[]                        video IDs

function getStatePath() {
  return join(app.getPath('userData'), 'app-state.json')
}

const DEFAULT_STATE = { lastFolder: null, folderHistory: [], favorites: [], theme: null }

function loadState() {
  try {
    const p = getStatePath()
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, 'utf-8'))
      // Merge with defaults so missing keys don't break older installs
      return { ...DEFAULT_STATE, ...parsed }
    }
  } catch {
    /* corrupt — start fresh */
  }
  return { ...DEFAULT_STATE }
}

const debouncedWriteState = debounce(async (state) => {
  try {
    await writeFile(getStatePath(), JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    console.error('[state] Failed to save:', err)
  }
}, 300)

function saveState(state) {
  debouncedWriteState(state)
}

// In-memory copy so we don't read from disk on every IPC call
let appState = null

function getState() {
  if (!appState) appState = loadState()
  return appState
}

function patchState(updater) {
  const s = getState()
  updater(s)
  saveState(s)
  return s
}

// ─── IPC: app-state store ──────────────────────────────────────────────────
// Thin key-based API so the renderer doesn't need to know the full structure.
// Supported keys: 'lastFolder', 'folderHistory', 'favorites'

ipcMain.handle('store:get', (_event, key) => {
  return getState()[key] ?? null
})

ipcMain.handle('store:set', (_event, key, value) => {
  patchState((s) => {
    s[key] = value
  })
})

ipcMain.handle('store:getAll', () => {
  return getState()
})

// ─── dimensions-cache.json ─────────────────────────────────────────────────
function getCachePath() {
  return join(app.getPath('userData'), 'dimensions-cache.json')
}

function getThumbnailDir() {
  return join(app.getPath('userData'), 'thumbnails')
}

/**
 * Bucketed thumbnail path: thumbnails/{xx}/{yy}/{sha1hash}.jpg
 * SHA-1 of filePath → uniform distribution, ~13 files/leaf at 3,500 thumbs.
 */
function thumbPathForFile(filePath) {
  const hash = createHash('sha1').update(filePath).digest('hex')
  const l1 = hash.slice(0, 2)
  const l2 = hash.slice(2, 4)
  return {
    hash,
    dir: join(getThumbnailDir(), l1, l2),
    path: join(getThumbnailDir(), l1, l2, `${hash}.jpg`)
  }
}

/**
 * One-time migration: flat thumbnails/{base64id}.jpg → bucketed layout.
 * Runs via setImmediate so it never delays startup.
 */
function migrateFlatThumbnails(cache) {
  const thumbDir = getThumbnailDir()
  let moved = 0
  for (const filePath of Object.keys(cache)) {
    const oldId = Buffer.from(filePath).toString('base64').replace(/[+/=]/g, '_')
    const oldPath = join(thumbDir, `${oldId}.jpg`)
    if (!existsSync(oldPath)) continue
    const { dir: newDir, path: newPath } = thumbPathForFile(filePath)
    if (existsSync(newPath)) continue
    try {
      if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true })
      renameSync(oldPath, newPath)
      moved++
    } catch (err) {
      console.warn(`[migrate] Could not move ${oldPath}:`, err.message)
    }
  }
  if (moved > 0) console.log(`[migrate] Moved ${moved} thumbnails to bucketed layout`)
}

// In-memory copy so we don't read from disk on every IPC call
let dimCacheMemory = null

function loadCache() {
  if (dimCacheMemory) return dimCacheMemory
  try {
    const p = getCachePath()
    if (existsSync(p)) {
      dimCacheMemory = JSON.parse(readFileSync(p, 'utf-8'))
      return dimCacheMemory
    }
  } catch {
    /* corrupt — start fresh */
  }
  dimCacheMemory = {}
  return dimCacheMemory
}

const debouncedWriteCache = debounce(async (cache) => {
  try {
    await writeFile(getCachePath(), JSON.stringify(cache), 'utf-8')
  } catch (err) {
    console.error('[cache] Failed to save:', err)
  }
}, 300)

function saveCache(cache) {
  dimCacheMemory = cache // mantener memoria sincronizada
  debouncedWriteCache(cache)
}

// ─── On-demand processor ──────────────────────────────────────────────────
// Priority queue processor. The renderer sends viewport filePaths on every
// scroll. Instead of cancelling pending work, we:
//   1. Promote newly-visible paths to the front of the queue
//   2. Drop paths that left the viewport and haven't started yet
//   3. Never interrupt in-flight ffprobe/ffmpeg — they always finish
//
// Cards fill in order of visibility, scroll never resets progress, and the
// CPU stays busy with useful work at all times.
class OnDemandProcessor {
  constructor() {
    this._running = 0
    this._limit = 4 // slight bump — ffprobe is mostly I/O wait
    this._queue = [] // ordered list of pending filePaths
    this._inFlight = new Set() // filePaths currently being processed
    this._ctx = null // { cache, send, alive, onDone } — updated each reprioritize
  }

  // Called by pipeline:process on every scroll/layout event.
  // filePaths are ordered: viewport-visible first, lookahead after.
  reprioritize(filePaths, ctx) {
    this._ctx = ctx

    const incoming = new Set(filePaths)

    // Drop queued items no longer in the incoming set (scrolled off-screen,
    // not started yet — no point processing cards the user already passed).
    this._queue = this._queue.filter((fp) => incoming.has(fp))

    // Prepend new paths not already queued or in-flight (preserve their order).
    const alreadyScheduled = new Set([...this._queue, ...this._inFlight])
    const toAdd = filePaths.filter((fp) => !alreadyScheduled.has(fp))
    this._queue = [...toAdd, ...this._queue]

    this._drain()
  }

  _drain() {
    while (this._running < this._limit && this._queue.length > 0) {
      const fp = this._queue.shift()
      this._inFlight.add(fp)
      this._running++
      this._run(fp).finally(() => {
        this._inFlight.delete(fp)
        this._running--
        const ctx = this._ctx
        if (ctx?.onDone?.cacheChanged) {
          ctx.onDone.cacheChanged = false
          saveCache(ctx.cache)
        }
        this._drain()
      })
    }
  }

  async _run(filePath) {
    const ctx = this._ctx
    if (!ctx || !ctx.alive()) return

    const { cache, send, onDone } = ctx
    const v = onDone.videoMap.get(filePath)
    if (!v) return

    // ── dims ────────────────────────────────────────────────────────────────
    let dims = cache[filePath]
    if (!dims || dims.mtime !== v.mtime) {
      const result = await getVideoDimensions(filePath)
      if (!ctx.alive()) return
      if (!result) {
        cache[filePath] = { noStream: true, mtime: v.mtime }
        onDone.cacheChanged = true
        send('video:no-stream', { id: v.id })
        return
      }
      cache[filePath] = { ...result, mtime: v.mtime }
      onDone.cacheChanged = true
      dims = result
      send('dims:ready', { id: v.id, ...dims })
    }

    // ── thumbnail ───────────────────────────────────────────────────────────
    const { path: thumbPath } = thumbPathForFile(filePath)
    if (existsSync(thumbPath)) {
      // Thumb on disk — emit if renderer doesn't have it yet (FS race guard).
      if (!v.thumbnailUrl) {
        const url = `localvideo://local/${encodeURIComponent(thumbPath)}`
        v.thumbnailUrl = url
        send('thumbnail:ready', { id: v.id, thumbnailUrl: url })
      }
      return
    }

    if (!ctx.alive()) return
    const outPath = await generateThumbnail(filePath, dims.duration)
    if (!outPath || !ctx.alive()) return
    const url = `localvideo://local/${encodeURIComponent(outPath)}`
    v.thumbnailUrl = url
    send('thumbnail:ready', { id: v.id, thumbnailUrl: url })
  }

  // Hard reset — called when a new folder is loaded.
  reset() {
    this._queue = []
    this._inFlight.clear()
    // In-flight promises finish naturally; send() is gated by alive() = false.
  }
}

// ─── ffprobe ───────────────────────────────────────────────────────────────
async function getVideoDimensions(filePath) {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', filePath],
      { timeout: 8000 }
    )
    const stream = JSON.parse(stdout).streams?.[0]
    if (!stream) return null
    const width = stream.coded_width || stream.width
    const height = stream.coded_height || stream.height
    const rotation = Math.abs(
      parseInt(stream.tags?.rotate || stream.side_data_list?.[0]?.rotation || '0', 10)
    )
    const isRotated = rotation === 90 || rotation === 270
    return {
      width: isRotated ? height : width,
      height: isRotated ? width : height,
      duration: parseFloat(stream.duration) || null
    }
  } catch {
    return null
  }
}

// ─── ffmpeg thumbnail ──────────────────────────────────────────────────────
async function generateThumbnail(filePath, duration) {
  const { dir, path: outPath } = thumbPathForFile(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const seekTime = '1' // duration ? Math.min(Math.max(duration * 0.1, 1), 30).toFixed(2) : '1'
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-ss',
        seekTime,
        '-i',
        filePath,
        '-frames:v',
        '1',
        '-vf',
        'scale=480:-2',
        '-q:v',
        '2',
        '-y',
        outPath
      ],
      { timeout: 60000 }
    )
    return outPath
  } catch (err) {
    console.error(`[thumbnail] Failed for ${filePath}`)
    console.error('code:', err.code)
    console.error('stdout:', err.stdout)
    console.error('stderr:', err.stderr) // 🔥 ESTE ES EL IMPORTANTE
    return null
  }
}

// ─── On-demand processor instance ────────────────────────────────────────
// One global instance — replaced videoMap on every loadFolder.
// pipelineToken gates all async work: incremented on cancel/folder-change.
let pipelineToken = 0
const processor = new OnDemandProcessor()

// ─── Folder watcher (poll-based) ──────────────────────────────────────────
// Simple 30-second poll: re-reads the watched directory and compares the set
// of video filePaths against the last known snapshot.  If anything was added
// or removed the renderer is notified via 'folder:changed' so it can reload.
// No chokidar — no quirks, no extra dependency, no surprises.
const POLL_INTERVAL = 30_000 // ms

let watchTimer = null
let watchedDir = null
let watchSnapshot = new Map()

function collectVideoEntries(dirPath) {
  const found = new Map() // filePath → mtime
  const walk = (currentPath) => {
    let entries
    try {
      entries = readdirSync(currentPath, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) walk(join(currentPath, entry.name))
        continue
      }
      const dotIndex = entry.name.lastIndexOf('.')
      if (dotIndex === -1) continue
      const ext = entry.name.slice(dotIndex).toLowerCase()
      if (!VIDEO_EXTENSIONS.has(ext)) continue
      const fullPath = join(currentPath, entry.name)
      try {
        found.set(fullPath, statSync(fullPath).mtimeMs)
      } catch {
        // file disappeared between readdir and stat — skip
      }
    }
  }
  walk(dirPath)
  return found
}

function startFolderWatch(dirPath) {
  stopFolderWatch()
  watchedDir = dirPath
  watchSnapshot = collectVideoEntries(dirPath)

  watchTimer = setInterval(() => {
    if (!watchedDir) return
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) { stopFolderWatch(); return }

    const current = collectVideoEntries(watchedDir)

    // Detect added, removed, or modified (same path, different mtime)
    const added = []
    const removed = []
    for (const [p, mtime] of current) {
      if (!watchSnapshot.has(p)) added.push(p)
      else if (watchSnapshot.get(p) !== mtime) added.push(p) // treat modified as re-add
    }
    for (const p of watchSnapshot.keys()) {
      if (!current.has(p)) removed.push(p)
    }

    if (added.length || removed.length) {
      watchSnapshot = current
      win.webContents.send('folder:changed', { added, removed })
    }
  }, POLL_INTERVAL)
}

function stopFolderWatch() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null }
  watchedDir = null
  watchSnapshot = new Map()
}

// ─── Window ────────────────────────────────────────────────────────────────
function createWindow() {
  const savedTheme = getState().theme // null | 'dark' | 'light'
  const symbolColor = savedTheme === 'light' ? '#a09890' : '#8a8078' // default dark

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 600,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    // ─── Title bar ─────────────────────────────────────────────────────────
    // 'hidden' on macOS keeps traffic lights, on Windows activates WCO when
    // combined with titleBarOverlay.
    titleBarStyle: 'hidden',
    // Windows only: native controls overlay + acrylic background material
    ...(process.platform === 'win32' && {
      titleBarOverlay: {
        color: '#00000000', // transparent so acrylic shows through
        symbolColor, // matches --text-tertiary per saved theme
        height: 48 // matches our Vue titlebar height
      },
      backgroundMaterial: 'acrylic'
    }),
    // macOS only: vibrancy for the frosted glass effect
    ...(process.platform === 'darwin' && {
      vibrancy: 'under-window',
      visualEffectState: 'active'
    }),
    backgroundColor: '#00000000',
    // ───────────────────────────────────────────────────────────────────────
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.on('ready-to-show', () => win.show())

  // ── Drag & drop de carpetas ──────────────────────────────────────────────
  // Con contextIsolation:true el renderer NO puede leer file.path desde el
  // evento drop del DOM — el objeto File no expone el path real del filesystem.
  // Solución: interceptar el drop en el main process directamente.
  //
  // Electron expone los paths reales via ipcMain 'drop-folder' que el preload
  // dispara usando webUtils.getPathForFile() — disponible en Electron 32+.
  // Para versiones anteriores, usamos la ruta alternativa: el renderer envía
  // el fileName y el main lo resuelve desde el último drag-enter registrado.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ─── Single instance lock ──────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

// ─── App ready ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  protocol.handle('localvideo', (request) => {
    try {
      const filePath = decodeURIComponent(request.url.slice('localvideo://local/'.length))
      let stat
      try {
        stat = statSync(filePath)
      } catch {
        return new Response('File not found', { status: 404 })
      }

      const fileSize = stat.size
      const ext = extname(filePath).toLowerCase()
      const mimeType =
        ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : MIME_TYPES[ext] || 'video/mp4'
      const rangeHeader = request.headers.get('range')

      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
        if (!match) return new Response('Invalid Range', { status: 416 })
        const start = parseInt(match[1], 10)
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
        const chunkSize = end - start + 1
        if (start >= fileSize || end >= fileSize || start > end) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileSize}` }
          })
        }
        return new Response(nodeStreamToWebStream(createReadStream(filePath, { start, end })), {
          status: 206,
          headers: {
            'Content-Type': mimeType,
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes'
          }
        })
      }

      return new Response(nodeStreamToWebStream(createReadStream(filePath)), {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(fileSize),
          'Accept-Ranges': 'bytes'
        }
      })
    } catch (err) {
      console.error('[localvideo protocol] error:', err)
      return new Response('Internal Error', { status: 500 })
    }
  })

  electronApp.setAppUserModelId('com.vidvault')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // Preload state into memory + run migrations in background
  getState()
  setImmediate(() => migrateFlatThumbnails(loadCache()))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ─── IPC: Cancel active pipeline ──────────────────────────────────────────
// The renderer calls this at the start of every loadFolder so the previous
// pipeline stops consuming CPU as soon as possible.
ipcMain.on('pipeline:cancel', () => {
  pipelineToken++ // invalidates all in-flight work for the current folder
  processor.reset() // clear queue so stale paths don't run after folder change
  stopFolderWatch() // stop polling — new loadFolder will restart it
})

// ─── IPC: Process visible videos on-demand ────────────────────────────────
// The renderer sends filePaths ordered: viewport-visible first, lookahead after.
// We reprioritize the queue rather than cancelling — cards fill in scroll order.
ipcMain.on('pipeline:process', (event, filePaths) => {
  if (!Array.isArray(filePaths) || !filePaths.length) return
  if (!processor._onDone?.videoMap?.size) return
  const cache = loadCache()
  const myToken = pipelineToken
  const send = (channel, data) => {
    if (pipelineToken !== myToken) return
    if (event.sender.isDestroyed()) return
    event.sender.send(channel, data)
  }
  const alive = () => pipelineToken === myToken && !event.sender.isDestroyed()
  processor.reprioritize(filePaths, { cache, send, alive, onDone: processor._onDone })
})

// ─── IPC: Open folder dialog ───────────────────────────────────────────────
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Seleccionar carpeta de videos'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// ─── IPC: Read videos ─────────────────────────────────────────────────────
ipcMain.handle('fs:readVideos', async (event, dirPath) => {
  if (!dirPath) return []
  try {
    if (!statSync(dirPath).isDirectory()) return { error: 'not_found' }
  } catch {
    return { error: 'not_found' }
  }

  const rawVideos = []
  const walk = (currentPath) => {
    let entries
    try {
      entries = readdirSync(currentPath, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) walk(fullPath)
        continue
      }
      const dotIndex = entry.name.lastIndexOf('.')
      if (dotIndex === -1) continue
      const ext = entry.name.slice(dotIndex).toLowerCase()
      if (!VIDEO_EXTENSIONS.has(ext)) continue
      let fileStat
      try {
        fileStat = statSync(fullPath)
      } catch {
        continue
      }
      rawVideos.push({
        id: Buffer.from(fullPath).toString('base64').replace(/[+/=]/g, '_'),
        fileName: entry.name,
        filePath: fullPath,
        videoUrl: `localvideo://local/${encodeURIComponent(fullPath)}`,
        size: fileStat.size,
        mtime: fileStat.mtimeMs,
        createdAt: fileStat.birthtimeMs || fileStat.ctimeMs,
        modifiedAt: fileStat.mtimeMs,
        ext: ext.slice(1).toUpperCase()
      })
    }
  }
  walk(dirPath)
  rawVideos.sort((a, b) => b.modifiedAt - a.modifiedAt)

  const cache = loadCache()

  // ── Stale cache cleanup ─────────────────────────────────────────────────
  // Remove cache entries whose file no longer exists on disk.  Runs after
  // walk() so we have the fresh filePath set to compare against.
  const freshPaths = new Set(rawVideos.map((v) => v.filePath))
  let cacheChanged = false
  for (const cachedPath of Object.keys(cache)) {
    if (!freshPaths.has(cachedPath) && !existsSync(cachedPath)) {
      delete cache[cachedPath]
      cacheChanged = true
    }
  }
  if (cacheChanged) saveCache(cache)

  // Build initial response using only cached dimensions — return immediately
  // so the renderer can paint cards right away.
  // Files whose cache entry has noStream:true (and whose mtime hasn't changed)
  // are excluded upfront — no card is ever shown for them, avoiding the
  // "blank card that disappears" flash on revisited folders.
  const videos = rawVideos.reduce((acc, v) => {
    const dims = cache[v.filePath]
    if (dims?.noStream && dims.mtime === v.mtime) return acc // skip silently
    const { path: thumbPath } = thumbPathForFile(v.filePath)
    const thumbExists = existsSync(thumbPath)
    acc.push({
      ...v,
      width: dims?.width || null,
      height: dims?.height || null,
      duration: dims?.duration || null,
      thumbnailUrl: thumbExists ? `localvideo://local/${encodeURIComponent(thumbPath)}` : null
    })
    return acc
  }, [])

  // Invalidate any in-flight on-demand work from the previous folder.
  // Reset queue + bump token atomically before returning videos so the
  // renderer can never call pipeline:process before videoMap is ready.
  pipelineToken++
  processor.reset()
  const videoMap = new Map(videos.map((v) => [v.filePath, v]))
  processor._onDone = { videoMap, cacheChanged: false }

  // Return immediately — no background work starts here.
  // The renderer will call pipeline:process with the visible filePaths.

  // Start polling so the renderer is notified if files are added/removed.
  startFolderWatch(dirPath)

  return videos
})

// ─── IPC: Get first available thumbnail for a folder ─────────────────────
// Scans the dimensions cache for files belonging to dirPath and returns the
// localvideo:// URL of the first thumbnail that exists on disk.
ipcMain.handle('store:getFolderThumb', (_event, dirPath) => {
  if (!dirPath) return null
  const cache = loadCache()
  const normalDir = dirPath.replace(/\\/g, '/')
  for (const filePath of Object.keys(cache)) {
    const normalFile = filePath.replace(/\\/g, '/')
    if (!normalFile.startsWith(normalDir)) continue
    if (cache[filePath]?.noStream) continue
    const { path: thumbPath } = thumbPathForFile(filePath)
    if (existsSync(thumbPath)) {
      return `localvideo://local/${encodeURIComponent(thumbPath)}`
    }
  }
  return null
})

// ─── IPC: Shell utilities ──────────────────────────────────────────────────
ipcMain.handle('shell:showInFolder', (_event, filePath) => {
  if (!filePath || typeof filePath !== 'string') return
  shell.showItemInFolder(filePath)
})
ipcMain.handle('shell:copyPath', (_event, filePath) => {
  if (!filePath || typeof filePath !== 'string') return
  clipboard.writeText(filePath)
})

// ─── Helper: Node stream → Web ReadableStream ──────────────────────────────
function nodeStreamToWebStream(nodeStream) {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => controller.enqueue(chunk))
      nodeStream.on('end', () => controller.close())
      nodeStream.on('error', (err) => controller.error(err))
    },
    cancel() {
      nodeStream.destroy()
    }
  })
}
