import { app, BrowserWindow, ipcMain, dialog, protocol, shell, clipboard } from 'electron'
import { join, extname } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  readdirSync,
  statSync,
  createReadStream,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync
} from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'

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

const MAX_HISTORY = 8

function getStatePath() {
  return join(app.getPath('userData'), 'app-state.json')
}

const DEFAULT_STATE = { lastFolder: null, folderHistory: [], favorites: [] }

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

function saveState(state) {
  try {
    writeFileSync(getStatePath(), JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    console.error('[state] Failed to save:', err)
  }
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

function loadCache() {
  try {
    const p = getCachePath()
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    /* corrupt — start fresh */
  }
  return {}
}

function saveCache(cache) {
  try {
    writeFileSync(getCachePath(), JSON.stringify(cache), 'utf-8')
  } catch (err) {
    console.error('[cache] Failed to save:', err)
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
  const seekTime = duration ? Math.min(Math.max(duration * 0.1, 1), 30).toFixed(2) : '1'
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
      { timeout: 15000 }
    )
    return outPath
  } catch (err) {
    console.error(`[thumbnail] Failed for ${filePath}:`, err.message)
    return null
  }
}

// ─── Concurrency limiter ───────────────────────────────────────────────────
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length)
  let index = 0
  const worker = async () => {
    while (index < tasks.length) {
      const current = index++
      results[current] = await tasks[current]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

// ─── Window ────────────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 600,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.on('ready-to-show', () => win.show())
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
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
  let cacheChanged = false
  const needDimProbe = rawVideos.filter((v) => {
    const c = cache[v.filePath]
    return !c || c.mtime !== v.mtime
  })
  if (needDimProbe.length > 0) {
    await runWithConcurrency(
      needDimProbe.map((v) => async () => {
        const dims = await getVideoDimensions(v.filePath)
        if (dims) {
          cache[v.filePath] = { ...dims, mtime: v.mtime }
          cacheChanged = true
        }
      }),
      8
    )
  }
  if (cacheChanged) saveCache(cache)

  const videos = rawVideos.map((v) => {
    const dims = cache[v.filePath]
    const { path: thumbPath } = thumbPathForFile(v.filePath)
    const thumbExists = existsSync(thumbPath)
    return {
      ...v,
      width: dims?.width || null,
      height: dims?.height || null,
      duration: dims?.duration || null,
      thumbnailUrl: thumbExists ? `localvideo://local/${encodeURIComponent(thumbPath)}` : null
    }
  })

  // Skip audio-only files (no video stream = no width from ffprobe)
  const needThumb = videos.filter((v) => !v.thumbnailUrl && v.width)
  if (needThumb.length > 0) {
    ;(async () => {
      await runWithConcurrency(
        needThumb.map((v) => async () => {
          if (event.sender.isDestroyed()) return
          const outPath = await generateThumbnail(v.filePath, v.duration)
          if (!outPath || event.sender.isDestroyed()) return
          event.sender.send('thumbnail:ready', {
            id: v.id,
            thumbnailUrl: `localvideo://local/${encodeURIComponent(outPath)}`
          })
        }),
        4
      )
    })()
  }

  return videos
})

// ─── IPC: Shell utilities ──────────────────────────────────────────────────
ipcMain.handle('shell:showInFolder', (_event, filePath) => shell.showItemInFolder(filePath))
ipcMain.handle('shell:copyPath', (_event, filePath) => clipboard.writeText(filePath))

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
