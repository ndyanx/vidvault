import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { readdirSync, statSync, createReadStream } from 'fs'

// ─── Video extensions supported ───────────────────────────────────────────
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

// MIME types for video seeking headers
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

// ─── Register custom protocol BEFORE app ready ────────────────────────────
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
  // ─── Protocol handler with Range Request support ─────────────────────
  // This is what allows the <video> element to seek (jump to any point).
  //
  // How seeking works:
  //   1. <video> wants to jump to minute 2:30
  //   2. Browser sends: Range: bytes=5242880-   (from byte 5MB onwards)
  //   3. We open a ReadStream starting at that byte offset
  //   4. We respond with 206 Partial Content + the correct byte range
  //   5. Video plays from that point instantly
  //
  // Without this, net.fetch(file://) responds with the full file every
  // time, causing seeks to hang or silently fail.

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

      // ── Parse Range header ──────────────────────────────────────────
      // Format: "bytes=START-END" or "bytes=START-" (open-ended)
      const rangeHeader = request.headers.get('range')

      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
        if (!match) {
          return new Response('Invalid Range', { status: 416 })
        }

        const start = parseInt(match[1], 10)
        // If end is omitted, serve until the end of file.
        // Clamp to fileSize - 1 to avoid reading past EOF.
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
        const chunkSize = end - start + 1

        if (start >= fileSize || end >= fileSize || start > end) {
          // Range Not Satisfiable
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileSize}` }
          })
        }

        // Create a ReadStream for exactly the requested byte range
        const stream = createReadStream(filePath, { start, end })

        // Convert Node.js ReadStream → Web ReadableStream (what Response expects)
        const webStream = nodeStreamToWebStream(stream)

        return new Response(webStream, {
          status: 206, // Partial Content
          headers: {
            'Content-Type': mimeType,
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes'
          }
        })
      }

      // ── No Range header: serve full file ────────────────────────────
      // This happens on the very first load or when the browser
      // wants the complete file (e.g. for duration detection).
      const stream = createReadStream(filePath)
      const webStream = nodeStreamToWebStream(stream)

      return new Response(webStream, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(fileSize),
          'Accept-Ranges': 'bytes' // tells the browser seeking is supported
        }
      })
    } catch (err) {
      console.error('[localvideo protocol] Unhandled error:', err)
      return new Response('Internal Error', { status: 500 })
    }
  })

  electronApp.setAppUserModelId('com.vidvault')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ─── Helper: Node.js ReadStream → Web ReadableStream ─────────────────────
// The Fetch API / Response constructor expects a Web ReadableStream,
// but fs.createReadStream() returns a Node.js stream. This bridges them.
function nodeStreamToWebStream(nodeStream) {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => {
        controller.enqueue(chunk)
      })
      nodeStream.on('end', () => {
        controller.close()
      })
      nodeStream.on('error', (err) => {
        controller.error(err)
      })
    },
    cancel() {
      nodeStream.destroy()
    }
  })
}

// ─── IPC: Open folder dialog ───────────────────────────────────────────────
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Seleccionar carpeta de videos'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// ─── IPC: Read all videos from a directory ────────────────────────────────
ipcMain.handle('fs:readVideos', (_event, dirPath) => {
  if (!dirPath) return []

  const videos = []

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

      const videoUrl = `localvideo://local/${encodeURIComponent(fullPath)}`

      videos.push({
        id: Buffer.from(fullPath).toString('base64').replace(/[+/=]/g, '_'),
        fileName: entry.name,
        filePath: fullPath,
        videoUrl,
        size: stat.size,
        createdAt: stat.birthtimeMs || stat.ctimeMs,
        modifiedAt: stat.mtimeMs,
        ext: ext.slice(1).toUpperCase()
      })
    }
  }

  walk(dirPath)
  videos.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return videos
})
