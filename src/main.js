const fileInput = document.getElementById('audioFile')
const analyzeBtn = document.getElementById('analyzeBtn')
const statusDiv = document.getElementById('status')
const statusText = document.getElementById('statusText')
const spinner = document.getElementById('spinner')
const playerSection = document.getElementById('playerSection')
const audioPlayer = document.getElementById('audioPlayer')
const timelineWrapper = document.querySelector('.timeline-wrapper')
const timelineInner = document.querySelector('.timeline-inner')
const canvas = document.getElementById('timelineCanvas')
const cursorCanvas = document.getElementById('cursorCanvas')

const PIXELS_PER_SECOND = 80
const TIMELINE_HEIGHT = 200
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const CURSOR_X_RATIO = 0.5
const chordMenu = document.getElementById('chordMenu')
const chordMenuTitle = document.getElementById('chordMenuTitle')
const chordMenuInput = document.getElementById('chordMenuInput')
const chordMenuSave = document.getElementById('chordMenuSave')
const chordMenuCancel = document.getElementById('chordMenuCancel')
const exportBtn = document.getElementById('exportBtn')

let editingIndex = -1
let currentFile = null
let audioDuration = 0
let analysisChords = []
let audioObjectUrl = null
let userScrolling = false
let userScrollTimer = null
let lastProgrammaticScroll = -1
let renderFrame = 0
let lastCursorTime = -1
let isDraggingProgress = false
let staticCanvasWidth = 0
let staticCanvasHeight = 0
let pixelRatio = 1

const playPauseBtn = document.getElementById('playPauseBtn')
const playIcon = document.getElementById('playIcon')
const pauseIcon = document.getElementById('pauseIcon')
const progressWrap = document.getElementById('progressWrap')
const progressFill = document.getElementById('progressFill')
const progressThumb = document.getElementById('progressThumb')
const currentTimeEl = document.getElementById('currentTime')
const totalTimeEl = document.getElementById('totalTime')
const muteBtn = document.getElementById('muteBtn')
const volOnIcon = document.getElementById('volOnIcon')
const volOffIcon = document.getElementById('volOffIcon')

function setStatus(message, { loading = false, error = false } = {}) {
  statusText.textContent = message
  statusDiv.classList.toggle('analyzing', loading)
  statusDiv.classList.toggle('has-error', error)
  spinner.style.display = loading ? 'inline-block' : 'none'
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const minutes = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} КБ`
    : `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
}

function selectAudioFile(file) {
  if (!file) return
  if (!file.type.startsWith('audio/') && !/\.(mp3|wav|wave|m4a|mp4|ogg|oga|flac|aac|webm)$/i.test(file.name)) {
    setStatus('Выбери аудиофайл поддерживаемого формата.', { error: true })
    return
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    setStatus(`Файл слишком большой (${formatBytes(file.size)}). Максимум — 50 МБ.`, { error: true })
    return
  }
  if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl)

  currentFile = file
  analysisChords = []
  audioDuration = 0
  analyzeBtn.disabled = false
  audioObjectUrl = URL.createObjectURL(file)
  audioPlayer.src = audioObjectUrl
  playerSection.style.display = 'block'
  timelineWrapper.style.display = 'none'
  document.body.classList.add('no-timeline')
  setStatus(`Выбран файл: ${file.name} · ${formatBytes(file.size)}`)
  fileInput.title = file.name
  fileInput.setAttribute('aria-label', `Выбран файл ${file.name}`)
}

fileInput.addEventListener('change', event => selectAudioFile(event.target.files?.[0]))

const fileDrop = document.querySelector('.file-drop')
if (fileDrop) {
  ;['dragenter', 'dragover'].forEach(type => fileDrop.addEventListener(type, event => {
    event.preventDefault()
    fileDrop.classList.add('is-dragging')
  }))
  ;['dragleave', 'drop'].forEach(type => fileDrop.addEventListener(type, event => {
    event.preventDefault()
    fileDrop.classList.remove('is-dragging')
  }))
  fileDrop.addEventListener('drop', event => {
    const file = [...(event.dataTransfer?.files || [])].find(item =>
      item.type.startsWith('audio/') || /\.(mp3|wav|wave|m4a|mp4|ogg|oga|flac|aac|webm)$/i.test(item.name)
    )
    if (file) selectAudioFile(file)
    else setStatus('В перетаскиваемой области не найден аудиофайл.', { error: true })
  })
}

analyzeBtn.addEventListener('click', async () => {
  if (!currentFile) return
  analyzeBtn.disabled = true
  setStatus('Загружаем файл и ставим анализ в очередь…', { loading: true })

  const formData = new FormData()
  formData.append('file', currentFile, currentFile.name)

  try {
    const response = await fetch('/analyze', { method: 'POST', body: formData })
    let data
    try {
      data = await response.json()
    } catch {
      throw new Error(`Сервер вернул некорректный ответ (${response.status}).`)
    }
    if (!response.ok) {
      const error = new Error(data.detail || `Ошибка сервера: ${response.status}`)
      error.status = response.status
      throw error
    }
    if (!Array.isArray(data.chords)) throw new Error('Сервер вернул результат в неизвестном формате.')

    analysisChords = data.chords
      .filter(chord => typeof chord.chord === 'string' && Number.isFinite(Number(chord.time)) && Number.isFinite(Number(chord.duration)))
      .map(chord => ({ chord: chord.chord, time: Math.max(0, Number(chord.time)), duration: Math.max(0, Number(chord.duration)) }))

    setStatus(`Анализ завершён. Найдено аккордов: ${analysisChords.length}`)
    timelineWrapper.style.display = 'block'
    document.body.classList.remove('no-timeline')
    setupTimelineCanvases()
    drawStaticTimeline()
    drawCursor(audioPlayer.currentTime)
    scrollToTimeline()
  } catch (error) {
    console.error('Audio analysis failed:', error)
    const retryHint = error.status === 503 ? ' Попробуй повторить чуть позже.' : ''
    setStatus(`${error.message}${retryHint}`, { error: true })
  } finally {
    analyzeBtn.disabled = !currentFile
  }
})

audioPlayer.addEventListener('loadedmetadata', () => {
  audioDuration = Number.isFinite(audioPlayer.duration) ? audioPlayer.duration : 0
  totalTimeEl.textContent = formatTime(audioDuration)
  updateProgress()
  if (audioDuration > 0 && analysisChords.length) {
    setupTimelineCanvases()
    drawStaticTimeline()
  }
})
audioPlayer.addEventListener('error', () => setStatus('Не удалось воспроизвести этот аудиофайл в браузере.', { error: true }))

function setupCanvas(canvasElement, width, height) {
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  canvasElement.style.width = `${width}px`
  canvasElement.style.height = `${height}px`
  const pixelWidth = Math.max(1, Math.round(width * ratio))
  const pixelHeight = Math.max(1, Math.round(height * ratio))
  if (canvasElement.width !== pixelWidth || canvasElement.height !== pixelHeight) {
    canvasElement.width = pixelWidth
    canvasElement.height = pixelHeight
  }
  const context = canvasElement.getContext('2d')
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  return context
}

function setupTimelineCanvases() {
  if (!audioDuration) return
  const fullWidth = Math.max(1, Math.ceil(audioDuration * PIXELS_PER_SECOND))
  const viewportWidth = Math.max(1, timelineWrapper.clientWidth)
  const canvasWidth = Math.min(fullWidth, viewportWidth)
  timelineInner.style.width = `${fullWidth}px`
  timelineInner.style.height = `${TIMELINE_HEIGHT}px`
  pixelRatio = Math.max(1, window.devicePixelRatio || 1)
  setupCanvas(canvas, canvasWidth, TIMELINE_HEIGHT)
  setupCanvas(cursorCanvas, canvasWidth, TIMELINE_HEIGHT)
  staticCanvasWidth = canvasWidth
  staticCanvasHeight = TIMELINE_HEIGHT
}

function chordColor(name) {
  const match = name.match(/^[A-G][#b]?(.*)$/)
  const suffix = match ? match[1] : ''
  if (name === 'N') return '#59645b'
  if (suffix.startsWith('m') && !suffix.startsWith('maj')) return '#9aa9ff'
  return '#c8f169'
}

// Static chord blocks are redrawn only when the viewport scrolls or changes size.
function drawStaticTimeline() {
  if (!audioDuration || !staticCanvasWidth) return
  const ctx = canvas.getContext('2d')
  const scrollLeft = timelineWrapper.scrollLeft
  const width = staticCanvasWidth
  const height = staticCanvasHeight
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#202923'
  ctx.fillRect(0, 0, width, height)

  const visibleStart = scrollLeft / PIXELS_PER_SECOND
  const visibleEnd = (scrollLeft + width) / PIXELS_PER_SECOND
  const firstTick = Math.floor(visibleStart / 10) * 10
  ctx.fillStyle = '#829083'
  ctx.font = '10px "DM Mono", monospace'
  ctx.textAlign = 'left'
  for (let time = firstTick; time <= Math.min(audioDuration, visibleEnd) + 10; time += 10) {
    const x = time * PIXELS_PER_SECOND - scrollLeft
    if (x < -2 || x > width + 2) continue
    ctx.fillRect(x, height - 15, 1, 10)
    ctx.fillText(`${time.toFixed(0)}s`, x + 2, height - 5)
  }

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, width, height - 20)
  ctx.clip()
  for (const chord of analysisChords) {
    const chordEnd = chord.time + chord.duration
    if (chordEnd < visibleStart || chord.time > visibleEnd) continue
    const x = chord.time * PIXELS_PER_SECOND - scrollLeft
    const endX = chordEnd * PIXELS_PER_SECOND - scrollLeft
    const blockWidth = Math.max(endX - x, 2)
    ctx.fillStyle = chordColor(chord.chord)
    ctx.fillRect(x, 10, blockWidth, height - 30)
    ctx.strokeStyle = 'rgba(15, 22, 17, .28)'
    ctx.lineWidth = 1
    ctx.strokeRect(x + .5, 10.5, Math.max(1, blockWidth - 1), height - 31)
    if (blockWidth > 25) {
      ctx.fillStyle = '#172016'
      ctx.font = 'bold 19px "DM Mono", monospace'
      ctx.textAlign = 'center'
      ctx.fillText(chord.chord, x + blockWidth / 2, height / 2, Math.max(20, blockWidth - 8))
    }
  }
  ctx.restore()
}

// The playhead lives on its own transparent canvas; chord blocks are not repainted per frame.
function drawCursor(time) {
  if (!audioDuration || !staticCanvasWidth) return
  const ctx = cursorCanvas.getContext('2d')
  const width = staticCanvasWidth
  ctx.clearRect(0, 0, width, TIMELINE_HEIGHT)
  if (!Number.isFinite(time)) return
  const x = time * PIXELS_PER_SECOND - timelineWrapper.scrollLeft
  if (x < 0 || x > width) return
  ctx.strokeStyle = '#f1f3e9'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, TIMELINE_HEIGHT)
  ctx.stroke()
}

function findChordAt(clientX, clientY) {
  if (!analysisChords.length || !staticCanvasWidth) return -1
  const rect = canvas.getBoundingClientRect()
  const localX = clientX - rect.left
  const localY = clientY - rect.top
  if (localY < 10 || localY > TIMELINE_HEIGHT - 20) return -1
  const time = (localX + timelineWrapper.scrollLeft) / PIXELS_PER_SECOND
  for (let i = 0; i < analysisChords.length; i++) {
    const c = analysisChords[i]
    if (time >= c.time && time < c.time + c.duration) return i
  }
  return -1
}

function openChordMenu(index, clientX, clientY) {
  editingIndex = index
  const chord = analysisChords[index]
  chordMenuTitle.textContent = `${chord.chord} · ${formatTime(chord.time)}–${formatTime(chord.time + chord.duration)}`
  chordMenuInput.value = chord.chord
  chordMenu.hidden = false

  // позиционируем относительно окна, не вылезая за края
  const menuWidth = 220
  const menuHeight = 140
  let left = clientX + 8
  let top = clientY + 8
  if (left + menuWidth > window.innerWidth - 8) left = clientX - menuWidth - 8
  if (top + menuHeight > window.innerHeight - 8) top = clientY - menuHeight - 8
  chordMenu.style.left = `${Math.max(8, left)}px`
  chordMenu.style.top = `${Math.max(8, top)}px`

  chordMenuInput.focus()
  chordMenuInput.select()
}

function closeChordMenu(save) {
  if (editingIndex < 0) return
  if (save) {
    const value = chordMenuInput.value.trim()
    if (value && value !== analysisChords[editingIndex].chord) {
      analysisChords[editingIndex].chord = value
      drawStaticTimeline()
      setStatus(`Аккорд обновлён: ${value}`)
    }
  }
  chordMenu.hidden = true
  editingIndex = -1
}

function seekTimeline(clientX) {
  if (!audioDuration) return
  const rect = canvas.getBoundingClientRect()
  const localX = Math.max(0, Math.min(staticCanvasWidth, clientX - rect.left))
  audioPlayer.currentTime = Math.max(0, Math.min(audioDuration, (localX + timelineWrapper.scrollLeft) / PIXELS_PER_SECOND))
  drawCursor(audioPlayer.currentTime)
  updateProgress()
  autoScrollToCursor(audioPlayer.currentTime)
}
canvas.addEventListener('click', event => seekTimeline(event.clientX))

timelineWrapper.addEventListener('scroll', () => {
  if (!audioDuration) return
  const currentScroll = timelineWrapper.scrollLeft
  if (lastProgrammaticScroll >= 0 && Math.abs(currentScroll - lastProgrammaticScroll) <= 2) {
    lastProgrammaticScroll = -1
    drawStaticTimeline()
    drawCursor(audioPlayer.currentTime)
    return
  }
  userScrolling = true
  clearTimeout(userScrollTimer)
  userScrollTimer = setTimeout(() => { userScrolling = false }, 1200)
  drawStaticTimeline()
  drawCursor(audioPlayer.currentTime)
}, { passive: true })

function autoScrollToCursor(time) {
  if (!timelineWrapper || userScrolling) return
  const cursorX = time * PIXELS_PER_SECOND
  const viewWidth = timelineWrapper.clientWidth
  const maxScroll = Math.max(0, timelineWrapper.scrollWidth - viewWidth)
  const target = Math.max(0, Math.min(maxScroll, cursorX - viewWidth * CURSOR_X_RATIO))
  if (Math.abs(timelineWrapper.scrollLeft - target) > 2) {
    lastProgrammaticScroll = target
    timelineWrapper.scrollLeft = target
  }
}

function stopRenderLoop() {
  if (renderFrame) cancelAnimationFrame(renderFrame)
  renderFrame = 0
}
function renderLoop() {
  drawCursor(audioPlayer.currentTime)
  autoScrollToCursor(audioPlayer.currentTime)
  renderFrame = requestAnimationFrame(renderLoop)
}
audioPlayer.addEventListener('play', () => {
  stopRenderLoop()
  renderFrame = requestAnimationFrame(renderLoop)
})
audioPlayer.addEventListener('pause', () => {
  stopRenderLoop()
  drawCursor(audioPlayer.currentTime)
})
audioPlayer.addEventListener('timeupdate', () => {
  updateProgress()
  if (audioPlayer.paused) drawCursor(audioPlayer.currentTime)
})
audioPlayer.addEventListener('ended', () => {
  stopRenderLoop()
  drawCursor(audioDuration)
})

function updatePlayPauseIcon() {
  playIcon.style.display = audioPlayer.paused ? '' : 'none'
  pauseIcon.style.display = audioPlayer.paused ? 'none' : ''
}
function updateProgress() {
  const duration = audioPlayer.duration
  if (!Number.isFinite(duration) || duration <= 0) return
  const percent = Math.max(0, Math.min(100, audioPlayer.currentTime / duration * 100))
  progressFill.style.width = `${percent}%`
  progressThumb.style.left = `${percent}%`
  currentTimeEl.textContent = formatTime(audioPlayer.currentTime)
}
playPauseBtn.addEventListener('click', async () => {
  try {
    if (audioPlayer.paused) await audioPlayer.play()
    else audioPlayer.pause()
  } catch (error) {
    console.error('Playback error:', error)
    setStatus('Браузер не смог запустить воспроизведение.', { error: true })
  }
})
audioPlayer.addEventListener('play', updatePlayPauseIcon)
audioPlayer.addEventListener('pause', updatePlayPauseIcon)

function seekProgress(clientX) {
  const rect = progressWrap.getBoundingClientRect()
  if (!rect.width || !Number.isFinite(audioPlayer.duration)) return
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  audioPlayer.currentTime = ratio * audioPlayer.duration
  updateProgress()
  drawCursor(audioPlayer.currentTime)
  autoScrollToCursor(audioPlayer.currentTime)
}
progressWrap.addEventListener('pointerdown', event => {
  isDraggingProgress = true
  progressWrap.setPointerCapture?.(event.pointerId)
  seekProgress(event.clientX)
})
progressWrap.addEventListener('pointermove', event => {
  if (isDraggingProgress) seekProgress(event.clientX)
})
progressWrap.addEventListener('pointerup', () => { isDraggingProgress = false })
progressWrap.addEventListener('pointercancel', () => { isDraggingProgress = false })

muteBtn.addEventListener('click', () => { audioPlayer.muted = !audioPlayer.muted })
audioPlayer.addEventListener('volumechange', () => {
  const muted = audioPlayer.muted || audioPlayer.volume === 0
  volOnIcon.style.display = muted ? 'none' : ''
  volOffIcon.style.display = muted ? '' : 'none'
})

document.addEventListener('keydown', event => {
  const active = document.activeElement
  if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA' || active?.isContentEditable) return
  if (!currentFile) return
  const step = event.shiftKey ? 1 : 5
  switch (event.code) {
    case 'Space':
      event.preventDefault()
      if (audioPlayer.paused) audioPlayer.play().catch(error => console.error('Playback error:', error))
      else audioPlayer.pause()
      break
    case 'ArrowLeft':
      event.preventDefault()
      audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - step)
      drawCursor(audioPlayer.currentTime); updateProgress(); autoScrollToCursor(audioPlayer.currentTime)
      break
    case 'ArrowRight':
      event.preventDefault()
      audioPlayer.currentTime = Math.min(audioDuration, audioPlayer.currentTime + step)
      drawCursor(audioPlayer.currentTime); updateProgress(); autoScrollToCursor(audioPlayer.currentTime)
      break
    case 'Home':
      event.preventDefault(); audioPlayer.currentTime = 0
      drawCursor(0); updateProgress(); autoScrollToCursor(0)
      break
    case 'End':
      event.preventDefault(); audioPlayer.currentTime = audioDuration
      drawCursor(audioDuration); updateProgress(); autoScrollToCursor(audioDuration)
      break
    case 'ArrowUp':
      event.preventDefault(); audioPlayer.volume = Math.min(1, audioPlayer.volume + .1)
      break
    case 'ArrowDown':
      event.preventDefault(); audioPlayer.volume = Math.max(0, audioPlayer.volume - .1)
      break
    case 'KeyM':
      event.preventDefault(); audioPlayer.muted = !audioPlayer.muted
      break
  }
})

function scrollToTimeline() {
  const timelineSection = document.querySelector('.timeline-heading')
  if (!timelineSection) return
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  timelineSection.scrollIntoView({
    behavior: prefersReducedMotion ? 'auto' : 'smooth',
    block: 'start',
  })
}

window.addEventListener('resize', () => {
  if (!audioDuration || !analysisChords.length) return
  setupTimelineCanvases()
  drawStaticTimeline()
  drawCursor(audioPlayer.currentTime)
})

window.addEventListener('beforeunload', () => {
  stopRenderLoop()
  clearTimeout(userScrollTimer)
  if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl)
})

canvas.addEventListener('contextmenu', event => {
  const idx = findChordAt(event.clientX, event.clientY)
  if (idx < 0) return  // не блокируем стандартное меню на пустом месте
  event.preventDefault()
  openChordMenu(idx, event.clientX, event.clientY)
})

chordMenuSave.addEventListener('click', () => closeChordMenu(true))
chordMenuCancel.addEventListener('click', () => closeChordMenu(false))
chordMenuInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); closeChordMenu(true) }
  if (e.key === 'Escape') { e.preventDefault(); closeChordMenu(false) }
})

// клик вне меню — закрыть без сохранения (или сохранить — на твой вкус)
document.addEventListener('pointerdown', e => {
  if (editingIndex >= 0 && !chordMenu.contains(e.target) && e.target !== canvas) {
    closeChordMenu(true)  // или false, если хочешь отмену
  }
})

const exportPdfBtn = document.getElementById('exportPdfBtn')

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildPrintHtml() {
  const fileName = currentFile?.name || 'track'
  const exportedAt = new Date().toLocaleString('ru-RU', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })

  // Сетка по 4 аккорда
  const GRID = 4
  const gridRows = []
  for (let i = 0; i < analysisChords.length; i += GRID) {
    const chunk = analysisChords.slice(i, i + GRID)
    const cells = chunk.map(c => `<td>${escapeHtml(c.chord)}</td>`).join('')
    gridRows.push(`<tr><td class="time">[${formatTime(chunk[0].time)}]</td>${cells}</tr>`)
  }

  // Подробный список
  const detailRows = analysisChords.map(c => `
    <tr>
      <td class="time">${formatTime(c.time)} — ${formatTime(c.time + c.duration)}</td>
      <td class="chord">${escapeHtml(c.chord)}</td>
    </tr>
  `).join('')

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>HARMONIC — ${escapeHtml(fileName)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a;
    line-height: 1.5;
    margin: 0;
  }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: #666; font-size: 12px; margin-bottom: 24px; }
  h2 { font-size: 13px; margin: 28px 0 8px; text-transform: uppercase; letter-spacing: 0.08em; color: #333; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td { padding: 4px 6px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  td.time { color: #888; white-space: nowrap; font-family: "Courier New", monospace; width: 1%; }
  td.chord { font-weight: 600; }
  .grid td:not(.time) { width: 22%; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #ddd; color: #999; font-size: 10px; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  <h1>HARMONIC — карта аккордов</h1>
  <div class="sub">
    ${escapeHtml(fileName)} · ${formatTime(audioDuration)} · ${analysisChords.length} аккордов<br>
    Экспорт: ${exportedAt}
  </div>

  <h2>Сетка (по 4 аккорда)</h2>
  <table class="grid">
    ${gridRows.join('')}
  </table>

  <h2>Подробно</h2>
  <table>
    ${detailRows}
  </table>

  <div class="footer">Сгенерировано HARMONIC</div>
</body>
</html>`
}

exportPdfBtn.addEventListener('click', () => {
  if (!analysisChords.length) return

  const html = buildPrintHtml()
  const win = window.open('', '_blank')
  if (!win) {
    setStatus('Браузер заблокировал всплывающее окно. Разреши всплывающие окна для этого сайта.', { error: true })
    return
  }
  win.document.open()
  win.document.write(html)
  win.document.close()

  const triggerPrint = () => {
    try {
      win.focus()
      win.print()
    } catch (e) {
      console.error('Print failed:', e)
    }
  }
  win.onload = triggerPrint
  setTimeout(triggerPrint, 500)

  setStatus('Открыто окно печати — выбери «Сохранить как PDF»')
})