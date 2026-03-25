import { app, BrowserWindow, ipcMain, dialog, protocol, shell, clipboard, Menu } from 'electron'
import { join, extname } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createReadStream, existsSync, mkdirSync, renameSync } from 'fs'
import { readFile, writeFile, readdir, stat } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'

function debounce(fn, ms) {
  let timer = null
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

const execFileAsync = promisify(execFile)

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

// Must be registered before app is ready
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

// Persisted state in userData/app-state.json.
// Shape: { lastFolder, folderHistory, favorites, theme }
// - folderHistory: [{ path, name, lastOpened }]  max 8 entries
// - favorites:     string[]  (video IDs)
function getStatePath() {
  return join(app.getPath('userData'), 'app-state.json')
}

const DEFAULT_STATE = { lastFolder: null, folderHistory: [], favorites: [], theme: null }

// #3 fix: async readFile instead of readFileSync
async function loadState() {
  try {
    const p = getStatePath()
    const raw = await readFile(p, 'utf-8')
    const parsed = JSON.parse(raw)
    // Merge with defaults so missing keys don't break older installs
    return { ...DEFAULT_STATE, ...parsed }
  } catch {
    /* file missing or corrupt — start fresh */
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

let appState = null
let appStatePromise = null

// #2 fix: lazy async loader — first call triggers the disk read; subsequent
// calls return the in-memory object immediately via the resolved promise.
// The state is NEVER read synchronously at module scope or at startup.
function getState() {
  if (appState) return Promise.resolve(appState)
  if (!appStatePromise) {
    appStatePromise = loadState().then((s) => {
      appState = s
      return s
    })
  }
  return appStatePromise
}

async function patchState(updater) {
  const s = await getState()
  updater(s)
  saveState(s)
  return s
}

// Thin key-based IPC API — renderer doesn't need to know the full state shape
ipcMain.handle('store:get', async (_event, key) => {
  const s = await getState()
  return s[key] ?? null
})

ipcMain.handle('store:set', async (_event, key, value) => {
  await patchState((s) => {
    s[key] = value
  })
})

ipcMain.handle('store:getAll', async () => {
  return getState()
})

function getCachePath() {
  return join(app.getPath('userData'), 'dimensions-cache.json')
}

function getThumbnailDir() {
  return join(app.getPath('userData'), 'thumbnails')
}

// Bucketed path: thumbnails/{xx}/{yy}/{sha1}.jpg
// SHA-1 of filePath gives ~13 files/leaf at 3,500 thumbs
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

// One-time migration from flat thumbnails/{base64id}.jpg to bucketed layout.
// Runs via setImmediate so it never delays startup.
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

let dimCacheMemory = null
let dimCachePromise = null

// #3 fix: async readFile instead of readFileSync, with lazy promise to avoid
// multiple concurrent reads.
async function loadCache() {
  if (dimCacheMemory) return dimCacheMemory
  if (!dimCachePromise) {
    dimCachePromise = (async () => {
      try {
        const p = getCachePath()
        const raw = await readFile(p, 'utf-8')
        dimCacheMemory = JSON.parse(raw)
      } catch {
        /* file missing or corrupt — start fresh */
        dimCacheMemory = {}
      }
      return dimCacheMemory
    })()
  }
  return dimCachePromise
}

const debouncedWriteCache = debounce(async (cache) => {
  try {
    await writeFile(getCachePath(), JSON.stringify(cache), 'utf-8')
  } catch (err) {
    console.error('[cache] Failed to save:', err)
  }
}, 300)

function saveCache(cache) {
  dimCacheMemory = cache
  debouncedWriteCache(cache)
}

// Priority queue processor for on-demand ffprobe/ffmpeg work.
// The renderer sends viewport filePaths on every scroll. Instead of cancelling
// pending work, we promote newly-visible paths to the front and drop paths that
// have scrolled off and haven't started yet. In-flight jobs always finish.
class OnDemandProcessor {
  constructor() {
    this._running = 0
    this._limit = 4 // ffprobe is mostly I/O wait, so a small concurrency bump is fine
    this._queue = []
    this._inFlight = new Set()
    this._ctx = null // { cache, send, alive, onDone } — updated each reprioritize
  }

  // Called on every scroll/layout event. filePaths: visible first, lookahead after.
  reprioritize(filePaths, ctx) {
    this._ctx = ctx

    const incoming = new Set(filePaths)

    // Drop queued items that scrolled off-screen and haven't started yet
    this._queue = this._queue.filter((fp) => incoming.has(fp))

    // Prepend new paths not already queued or in-flight
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

    // Get/refresh dimensions
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

    // Generate thumbnail if not already on disk
    const { path: thumbPath } = thumbPathForFile(filePath)
    if (existsSync(thumbPath)) {
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

  // Hard reset — called when a new folder is loaded
  reset() {
    this._queue = []
    this._inFlight.clear()
    // In-flight promises finish naturally; send() is gated by alive() = false
  }
}

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
    // Account for rotation metadata so portrait videos report correct dimensions
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

async function generateThumbnail(filePath, duration) {
  const { dir, path: outPath } = thumbPathForFile(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const seekTime = '1'
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
    console.error('stderr:', err.stderr)
    return null
  }
}

// One global processor — videoMap is replaced on every folder load.
// pipelineToken gates all async work: incremented on cancel/folder-change.
let pipelineToken = 0
const processor = new OnDemandProcessor()

// Poll-based folder watcher: re-reads the directory every 30s and notifies
// the renderer via 'folder:changed' if files were added, removed, or modified.
const POLL_INTERVAL = 30_000

let watchTimer = null
let watchedDir = null
let watchSnapshot = new Map()

// #3 fix: async readdir/stat instead of readdirSync/statSync
async function collectVideoEntries(dirPath) {
  const found = new Map() // filePath → mtime
  const walk = async (currentPath) => {
    let entries
    try {
      entries = await readdir(currentPath, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) await walk(join(currentPath, entry.name))
          return
        }
        const dotIndex = entry.name.lastIndexOf('.')
        if (dotIndex === -1) return
        const ext = entry.name.slice(dotIndex).toLowerCase()
        if (!VIDEO_EXTENSIONS.has(ext)) return
        const fullPath = join(currentPath, entry.name)
        try {
          const s = await stat(fullPath)
          found.set(fullPath, s.mtimeMs)
        } catch {
          // file disappeared between readdir and stat — skip
        }
      })
    )
  }
  await walk(dirPath)
  return found
}

// #3 fix: startFolderWatch is now async; setInterval callback uses async IIFE
async function startFolderWatch(dirPath) {
  stopFolderWatch()
  watchedDir = dirPath
  watchSnapshot = await collectVideoEntries(dirPath)
  try {
    const s = await stat(dirPath)
    watchSnapshot._rootMtime = s.mtimeMs
  } catch {
    watchSnapshot._rootMtime = 0
  }

  watchTimer = setInterval(async () => {
    if (!watchedDir) return
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) {
      stopFolderWatch()
      return
    }

    // Fast-path: skip full walk if root mtime hasn't changed
    try {
      const s = await stat(watchedDir)
      if (s.mtimeMs === watchSnapshot._rootMtime) return
      watchSnapshot._rootMtime = s.mtimeMs
    } catch {
      // folder disappeared — let collectVideoEntries handle it
    }

    const current = await collectVideoEntries(watchedDir)

    const added = []
    const removed = []
    for (const [p, mtime] of current) {
      if (!watchSnapshot.has(p)) added.push(p)
      else if (watchSnapshot.get(p) !== mtime) added.push(p) // treat modified as re-add
    }
    for (const p of watchSnapshot.keys()) {
      if (p === '_rootMtime') continue
      if (!current.has(p)) removed.push(p)
    }

    if (added.length || removed.length) {
      watchSnapshot = current
      win.webContents.send('folder:changed', { added, removed })
    }
  }, POLL_INTERVAL)
}

function stopFolderWatch() {
  if (watchTimer) {
    clearInterval(watchTimer)
    watchTimer = null
  }
  watchedDir = null
  watchSnapshot = new Map()
}

// #2 fix: createWindow is async so it can await getState() without blocking
// the main process synchronously at startup.
async function createWindow() {
  const savedTheme = (await getState()).theme
  const symbolColor = savedTheme === 'light' ? '#a09890' : '#8a8078'

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 600,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    // 'hidden' keeps traffic lights on macOS; enables WCO on Windows with titleBarOverlay
    titleBarStyle: 'hidden',
    ...(process.platform === 'win32' && {
      titleBarOverlay: {
        color: '#00000000',
        symbolColor, // matches --text-tertiary for the saved theme
        height: 48
      },
      backgroundMaterial: 'acrylic'
    }),
    ...(process.platform === 'darwin' && {
      vibrancy: 'under-window',
      visualEffectState: 'active'
    }),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.on('ready-to-show', () => win.show())

  // With contextIsolation:true the renderer can't read File.path from a drop event.
  // Folder paths come via IPC from the preload using webUtils.getPathForFile().
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

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

Menu.setApplicationMenu(null)

// #2 fix: whenReady uses an async IIFE so we can await createWindow() without
// converting the .then() callback itself into an async function, which is the
// pattern Electron expects. getState() is kicked off lazily in the background
// so it's warm by the time the renderer makes its first store:getAll call.
app.whenReady().then(async () => {
  // The localvideo protocol handler only serves local files; stat here is fine
  // because it runs inside an async handler that is not the main event-loop tick.
  protocol.handle('localvideo', async (request) => {
    try {
      const filePath = decodeURIComponent(request.url.slice('localvideo://local/'.length))
      let fileStat
      try {
        fileStat = await stat(filePath)
      } catch {
        return new Response('File not found', { status: 404 })
      }

      const fileSize = fileStat.size
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

  // #2 fix: kick off the lazy state load in the background so it's warm by the
  // time the renderer makes its first store:getAll call — but don't block startup.
  // createWindow() will await getState() too, but by then the promise is already
  // in flight so it resolves immediately from memory.
  setImmediate(() => getState())
  // Migrate thumbnails only after the cache is loaded, without blocking startup.
  setImmediate(async () => migrateFlatThumbnails(await loadCache()))

  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Cancel active pipeline — called by renderer before every loadFolder
ipcMain.on('pipeline:cancel', () => {
  pipelineToken++
  processor.reset()
  stopFolderWatch()
})

// Reprioritize the processing queue based on current viewport.
// filePaths are ordered: visible first, lookahead after.
// #3 fix: loadCache() is now async so we await it before reprioritizing.
ipcMain.on('pipeline:process', async (event, filePaths) => {
  if (!Array.isArray(filePaths) || !filePaths.length) return
  if (!processor._onDone?.videoMap?.size) return
  const cache = await loadCache()
  const myToken = pipelineToken
  const send = (channel, data) => {
    if (pipelineToken !== myToken) return
    if (event.sender.isDestroyed()) return
    event.sender.send(channel, data)
  }
  const alive = () => pipelineToken === myToken && !event.sender.isDestroyed()
  processor.reprioritize(filePaths, { cache, send, alive, onDone: processor._onDone })
})

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Seleccionar carpeta de videos'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// #3 fix: fs:readVideos handler — walk is now fully async with readdir/stat
ipcMain.handle('fs:readVideos', async (event, dirPath) => {
  if (!dirPath) return []
  try {
    const s = await stat(dirPath)
    if (!s.isDirectory()) return { error: 'not_found' }
  } catch {
    return { error: 'not_found' }
  }

  const rawVideos = []
  const walk = async (currentPath) => {
    let entries
    try {
      entries = await readdir(currentPath, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(currentPath, entry.name)
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) await walk(fullPath)
          return
        }
        const dotIndex = entry.name.lastIndexOf('.')
        if (dotIndex === -1) return
        const ext = entry.name.slice(dotIndex).toLowerCase()
        if (!VIDEO_EXTENSIONS.has(ext)) return
        let fileStat
        try {
          fileStat = await stat(fullPath)
        } catch {
          return
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
      })
    )
  }
  await walk(dirPath)
  rawVideos.sort((a, b) => b.modifiedAt - a.modifiedAt)

  const cache = await loadCache()

  // Remove cache entries for files that no longer exist on disk
  const freshPaths = new Set(rawVideos.map((v) => v.filePath))
  let cacheChanged = false
  for (const cachedPath of Object.keys(cache)) {
    if (!freshPaths.has(cachedPath) && !existsSync(cachedPath)) {
      delete cache[cachedPath]
      cacheChanged = true
    }
  }
  if (cacheChanged) saveCache(cache)

  // Build the initial response using only cached dimensions so the renderer
  // can paint cards immediately. Files with noStream:true and unchanged mtime
  // are excluded to avoid a blank-card flash on revisited folders.
  const videos = rawVideos.reduce((acc, v) => {
    const dims = cache[v.filePath]
    if (dims?.noStream && dims.mtime === v.mtime) return acc
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

  // Bump token and reset queue before returning so the renderer can never call
  // pipeline:process before videoMap is ready
  pipelineToken++
  processor.reset()
  const videoMap = new Map(videos.map((v) => [v.filePath, v]))
  processor._onDone = { videoMap, cacheChanged: false }

  startFolderWatch(dirPath).catch(console.error)

  return videos
})

// Returns a localvideo:// URL for the first available thumbnail in dirPath
// #3 fix: loadCache() is async — handler is now async too
ipcMain.handle('store:getFolderThumb', async (_event, dirPath) => {
  if (!dirPath) return null
  const cache = await loadCache()
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

ipcMain.handle('shell:showInFolder', (_event, filePath) => {
  if (!filePath || typeof filePath !== 'string') return
  shell.showItemInFolder(filePath)
})
ipcMain.handle('shell:copyPath', (_event, filePath) => {
  if (!filePath || typeof filePath !== 'string') return
  clipboard.writeText(filePath)
})

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
