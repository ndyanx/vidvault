import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import { join, extname } from 'path'
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
// dimensions-cache.json  → { [filePath]: { width, height, duration, mtime } }
// thumbnails live in     → userData/thumbnails/{id}.jpg  (keyed by video id)

function getCachePath() {
  return join(app.getPath('userData'), 'dimensions-cache.json')
}

function getThumbnailDir() {
  return join(app.getPath('userData'), 'thumbnails')
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
    const p = getCachePath()
    const dir = join(p, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(p, JSON.stringify(cache), 'utf-8')
  } catch (err) {
    console.error('[cache] Failed to save:', err)
  }
}

// ─── ffprobe: get dimensions + duration ───────────────────────────────────
async function getVideoDimensions(filePath) {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', filePath],
      { timeout: 8000 }
    )
    const data = JSON.parse(stdout)
    const stream = data.streams?.[0]
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

// ─── ffmpeg: extract a single thumbnail frame ──────────────────────────────
// Seeks to 10% of duration (or 1s fallback) for a representative frame.
// Saves as JPEG to thumbnailDir/{id}.jpg
async function generateThumbnail(filePath, id, duration) {
  const thumbDir = getThumbnailDir()
  if (!existsSync(thumbDir)) mkdirSync(thumbDir, { recursive: true })

  const outPath = join(thumbDir, `${id}.jpg`)

  // Pick seek time: 10% into video, min 1s, max 30s
  const seekTime = duration ? Math.min(Math.max(duration * 0.1, 1), 30).toFixed(2) : '1'

  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-ss',
        seekTime, // seek before input for speed
        '-i',
        filePath,
        '-frames:v',
        '1', // single frame
        '-vf',
        'scale=480:-2', // scale to 480px wide, keep aspect
        '-q:v',
        '2', // JPEG quality (2=best, 31=worst)
        '-y', // overwrite
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
// Returns immediately with videos (thumbnailUrl populated for cached ones).
// Then generates missing thumbnails in background, pushing each via IPC.
ipcMain.handle('fs:readVideos', async (event, dirPath) => {
  if (!dirPath) return []

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

  // 2. Dimensions cache
  const cache = loadCache()
  let cacheChanged = false

  const needDimProbe = rawVideos.filter((v) => {
    const cached = cache[v.filePath]
    return !cached || cached.mtime !== v.mtime
  })

  if (needDimProbe.length > 0) {
    const tasks = needDimProbe.map((v) => async () => {
      const dims = await getVideoDimensions(v.filePath)
      if (dims) {
        cache[v.filePath] = { ...dims, mtime: v.mtime }
        cacheChanged = true
      }
    })
    await runWithConcurrency(tasks, 8)
  }

  if (cacheChanged) saveCache(cache)

  // 3. Attach dimensions + thumbnail (if already cached on disk)
  const thumbDir = getThumbnailDir()

  const videos = rawVideos.map((v) => {
    const dims = cache[v.filePath]
    const thumbPath = join(thumbDir, `${v.id}.jpg`)
    const thumbExists = existsSync(thumbPath)
    return {
      ...v,
      width: dims?.width || null,
      height: dims?.height || null,
      duration: dims?.duration || null,
      thumbnailUrl: thumbExists ? `localvideo://local/${encodeURIComponent(thumbPath)}` : null
    }
  })

  // 4. Return immediately so renderer can render the gallery now
  // Videos with thumbnailUrl already set will show image instantly.
  // The rest will get pushed once ffmpeg finishes.

  // Fire-and-forget background thumbnail generation
  const needThumb = videos.filter((v) => !v.thumbnailUrl)

  if (needThumb.length > 0) {
    // Don't await — run in background
    ;(async () => {
      const tasks = needThumb.map((v) => async () => {
        // Check sender is still alive before doing work
        if (event.sender.isDestroyed()) return

        const outPath = await generateThumbnail(v.filePath, v.id, v.duration)
        if (!outPath) return
        if (event.sender.isDestroyed()) return

        event.sender.send('thumbnail:ready', {
          id: v.id,
          thumbnailUrl: `localvideo://local/${encodeURIComponent(outPath)}`
        })
      })

      // Use concurrency 4 for thumbnails — ffmpeg is heavier than ffprobe
      await runWithConcurrency(tasks, 4)
    })()
  }

  return videos
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
