import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  readdirSync,
  statSync,
  createReadStream,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync
} from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'

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

// ─── Cache helpers ─────────────────────────────────────────────────────────
// Cache lives in %APPDATA%/vidvault/dimensions-cache.json
// Each entry key = filePath, value = { width, height, mtime }
// If mtime matches the current file mtime, the cached dimensions are valid.

function getCachePath() {
  const userDataPath = app.getPath('userData')
  return join(userDataPath, 'dimensions-cache.json')
}

function loadCache() {
  try {
    const cachePath = getCachePath()
    if (existsSync(cachePath)) {
      return JSON.parse(readFileSync(cachePath, 'utf-8'))
    }
  } catch {
    // corrupt cache — start fresh
  }
  return {}
}

function saveCache(cache) {
  try {
    const cachePath = getCachePath()
    const dir = join(cachePath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(cachePath, JSON.stringify(cache), 'utf-8')
  } catch (err) {
    console.error('[cache] Failed to save:', err)
  }
}

// ─── ffprobe ───────────────────────────────────────────────────────────────
async function getVideoDimensions(filePath) {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_streams',
        '-select_streams',
        'v:0', // only first video stream
        filePath
      ],
      { timeout: 8000 }
    )

    const data = JSON.parse(stdout)
    const stream = data.streams?.[0]
    if (!stream) return null

    // Some videos store dimensions rotated — handle display rotation
    const width = stream.coded_width || stream.width
    const height = stream.coded_height || stream.height

    // Check for rotation tag (common in phone recordings)
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

// ─── Concurrency limiter ───────────────────────────────────────────────────
// Runs async tasks with at most `limit` running at once.
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length)
  let index = 0

  const worker = async () => {
    while (index < tasks.length) {
      const current = index++
      results[current] = await tasks[current]()
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker)
  await Promise.all(workers)
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

app.whenReady().then(() => {
  // ─── localvideo:// protocol with Range Request support ────────────────
  protocol.handle('localvideo', (request) => {
    try {
      const encoded = request.url.slice('localvideo://local/'.length)
      const filePath = decodeURIComponent(encoded)

      let stat
      try {
        stat = statSync(filePath)
      } catch {
        return new Response('File not found', { status: 404 })
      }

      const fileSize = stat.size
      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
      const mimeType = MIME_TYPES[ext] || 'video/mp4'
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

// ─── IPC: Read videos + extract dimensions via ffprobe ────────────────────
ipcMain.handle('fs:readVideos', async (_event, dirPath) => {
  if (!dirPath) return []

  // Check if directory exists before doing anything
  try {
    const stat = statSync(dirPath)
    if (!stat.isDirectory()) return { error: 'not_found' }
  } catch {
    return { error: 'not_found' }
  }

  // 1. Scan directory
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

      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }

      rawVideos.push({
        id: Buffer.from(fullPath).toString('base64').replace(/[+/=]/g, '_'),
        fileName: entry.name,
        filePath: fullPath,
        videoUrl: `localvideo://local/${encodeURIComponent(fullPath)}`,
        size: stat.size,
        mtime: stat.mtimeMs,
        createdAt: stat.birthtimeMs || stat.ctimeMs,
        modifiedAt: stat.mtimeMs,
        ext: ext.slice(1).toUpperCase()
      })
    }
  }

  walk(dirPath)
  rawVideos.sort((a, b) => b.modifiedAt - a.modifiedAt)

  // 2. Load dimension cache
  const cache = loadCache()
  let cacheChanged = false

  // 3. Determine which videos need ffprobe (not in cache or mtime changed)
  const needProbe = rawVideos.filter((v) => {
    const cached = cache[v.filePath]
    return !cached || cached.mtime !== v.mtime
  })

  // 4. Run ffprobe with concurrency limit of 8
  if (needProbe.length > 0) {
    const tasks = needProbe.map((v) => async () => {
      const dims = await getVideoDimensions(v.filePath)
      if (dims) {
        cache[v.filePath] = { ...dims, mtime: v.mtime }
        cacheChanged = true
      }
    })
    await runWithConcurrency(tasks, 8)
  }

  // 5. Save updated cache
  if (cacheChanged) saveCache(cache)

  // 6. Attach dimensions to each video
  return rawVideos.map((v) => {
    const dims = cache[v.filePath]
    return {
      ...v,
      width: dims?.width || null,
      height: dims?.height || null,
      duration: dims?.duration || null
    }
  })
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
