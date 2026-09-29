const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const APP_FOLDER_NAME = 'AulaMedia';

function resolvePackagedBinary(...parts) {
  // En desarrollo: node_modules del proyecto
  // Empaquetado: binarios fuera del asar (asarUnpack)
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', ...parts);
  }
  return path.join(__dirname, '..', 'node_modules', ...parts);
}

const YTDLP_PATH = resolvePackagedBinary(
  'youtube-dl-exec',
  'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

function executablePath(candidate) {
  if (!candidate) return null;
  // app.asar se puede leer, pero Windows no puede ejecutar un .exe que vive ahí.
  const unpacked = candidate.includes(`${path.sep}app.asar${path.sep}`)
    ? candidate.replace(
        `${path.sep}app.asar${path.sep}`,
        `${path.sep}app.asar.unpacked${path.sep}`
      )
    : candidate;
  if (fs.existsSync(unpacked)) return unpacked;
  if (!candidate.includes(`${path.sep}app.asar${path.sep}`) && fs.existsSync(candidate)) {
    return candidate;
  }
  return null;
}

function getFfmpegPath() {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [resolvePackagedBinary('ffmpeg-static', name)];
  try {
    candidates.push(require('ffmpeg-static'));
  } catch {
    /* ignore */
  }
  for (const candidate of candidates) {
    const resolved = executablePath(candidate);
    if (resolved) return resolved;
  }
  return null;
}

const ffmpegPath = getFfmpegPath();

function parseFfmpegClock(value) {
  const match = String(value || '').match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function transcodeForProjector(inputPath, outputPath, onPercent) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      reject(new Error('No se encontró FFmpeg para adaptar el video.'));
      return;
    }

    const args = [
      '-y',
      '-i',
      inputPath,
      '-c:v',
      'libx264',
      '-profile:v',
      'main',
      '-level',
      '4.0',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-vf',
      "scale='min(1920,iw)':-2",
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-ar',
      '44100',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart',
      outputPath,
    ];

    const child = spawn(ffmpegPath, args, { windowsHide: true, shell: false });
    let stderr = '';
    let duration = 0;

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const dur = text.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
      if (dur) duration = parseFfmpegClock(dur[1]) || duration;
      const time = text.match(/time=\s*(\d+:\d+:\d+(?:\.\d+)?)/);
      if (time && duration > 0 && onPercent) {
        const current = parseFfmpegClock(time[1]);
        onPercent(Math.max(0, Math.min(100, (current / duration) * 100)));
      }
    });

    child.on('error', (err) => {
      console.error('[ffmpeg spawn]', ffmpegPath, err);
      reject(new Error('No se pudo iniciar la conversión para el proyector.'));
    });

    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        resolve(outputPath);
        return;
      }
      if (fs.existsSync(outputPath)) {
        try {
          fs.unlinkSync(outputPath);
        } catch {
          /* ignore */
        }
      }
      console.error('[ffmpeg projector]', stderr.slice(-500));
      reject(new Error('No se pudo adaptar el video para el proyector.'));
    });
  });
}

function getLibraryRoot() {
  return path.join(app.getPath('documents'), APP_FOLDER_NAME);
}

function ensureLibraryFolders() {
  const root = getLibraryRoot();
  const folders = {
    root,
    videos: path.join(root, 'Videos'),
    audio: path.join(root, 'Audio'),
    subs: path.join(root, 'Subtitulos'),
  };

  for (const folder of Object.values(folders)) {
    fs.mkdirSync(folder, { recursive: true });
  }

  return folders;
}

function sanitizeFilename(name) {
  return (
    String(name || 'sin-titulo')
      .replace(/%/g, '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'sin-titulo'
  );
}

function isYouTubeUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    return (
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtu.be'
    );
  } catch {
    return false;
  }
}

/** Acepta "90", "1:30" o "1:02:03" → segundos */
function parseTimeToSeconds(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (n < 0) throw new Error('El tiempo no puede ser negativo.');
    return n;
  }

  const parts = raw.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p === '' || Number.isNaN(Number(p)))) {
    throw new Error('Usá tiempos como 1:30 o 90 (segundos).');
  }

  const nums = parts.map(Number);
  let seconds = 0;
  if (nums.length === 2) seconds = nums[0] * 60 + nums[1];
  else seconds = nums[0] * 3600 + nums[1] * 60 + nums[2];

  if (seconds < 0) throw new Error('El tiempo no puede ser negativo.');
  return seconds;
}

function formatSectionTime(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function resolveTrimRange(trimFrom, trimTo) {
  const from = parseTimeToSeconds(trimFrom);
  const to = parseTimeToSeconds(trimTo);

  if (from == null && to == null) {
    return null;
  }

  const start = from == null ? 0 : from;
  const end = to == null ? null : to;

  if (end != null && end <= start) {
    throw new Error('El tiempo "Hasta" tiene que ser mayor que "Desde".');
  }

  return { start, end };
}

function findById(dir, id, preferredExts) {
  for (const ext of preferredExts) {
    const candidate = path.join(dir, `${id}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }

  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  const match = files.find((f) => f === `${id}` || f.startsWith(`${id}.`) || f.includes(`[${id}]`));
  return match ? path.join(dir, match) : null;
}

function findSubtitleFiles(dir, id) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${id}`) && /\.(srt|vtt|ass)$/i.test(f))
    .map((f) => path.join(dir, f))
    .sort((a, b) => {
      // Preferir .srt sobre .vtt
      const ae = path.extname(a).toLowerCase();
      const be = path.extname(b).toLowerCase();
      if (ae === '.srt' && be !== '.srt') return -1;
      if (be === '.srt' && ae !== '.srt') return 1;
      return a.localeCompare(b);
    });
}

function scoreSubtitleLang(code) {
  const c = String(code || '').toLowerCase();
  if (c === 'es' || c === 'es-419' || c === 'es-es' || c === 'es-mx' || c === 'es-ar') return 100;
  if (c.startsWith('es-') || c.startsWith('es')) return 90;
  if (c === 'en' || c === 'en-us' || c === 'en-gb') return 80;
  if (c.startsWith('en-') || c.startsWith('en')) return 70;
  return 10;
}

function parseLangMap(raw) {
  if (!raw || raw === 'NA' || raw === 'null' || raw === 'none') return [];
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? Object.keys(data) : [];
  } catch {
    return [];
  }
}

async function pickSubtitleLang(url) {
  const { stdout } = await runYtDlp([
    url,
    ...YT_BASE_ARGS,
    '--print',
    '%(subtitles)j',
    '--print',
    '%(automatic_captions)j',
  ]);

  const lines = stdout
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const langs = [
    ...new Set([...parseLangMap(lines[0]), ...parseLangMap(lines[1])]),
  ];

  if (!langs.length) return null;

  langs.sort((a, b) => scoreSubtitleLang(b) - scoreSubtitleLang(a) || a.localeCompare(b));
  return langs[0];
}

function subtitleDownloadArgs(subsDir, videoId, lang) {
  return [
    '--skip-download',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs',
    lang,
    '--sub-format',
    'srt/best',
    '--convert-subs',
    'srt',
    '--output',
    path.join(subsDir, `${videoId}.%(ext)s`),
  ];
}

function renameKeepExt(fromPath, title) {
  const ext = path.extname(fromPath);
  let target = path.join(path.dirname(fromPath), `${title}${ext}`);
  if (fromPath === target) return fromPath;

  if (fs.existsSync(target)) {
    target = path.join(path.dirname(fromPath), `${title} (${Date.now()})${ext}`);
  }

  fs.renameSync(fromPath, target);
  return target;
}

function renameSubtitle(fromPath, title, videoId) {
  const ext = path.extname(fromPath);
  const base = path.basename(fromPath, ext);
  let langSuffix = '';

  if (videoId && base.startsWith(videoId)) {
    langSuffix = base.slice(videoId.length); // ej. ".en" o ".en-nP7-2PuUl7o"
  } else {
    const parts = base.split('.');
    if (parts.length > 1) langSuffix = `.${parts.slice(1).join('.')}`;
  }

  let target = path.join(path.dirname(fromPath), `${title}${langSuffix}${ext}`);
  if (fromPath === target) return fromPath;
  if (fs.existsSync(target)) {
    target = path.join(path.dirname(fromPath), `${title}${langSuffix} (${Date.now()})${ext}`);
  }
  fs.renameSync(fromPath, target);
  return target;
}

/** Convierte SRT/VTT a texto limpio para imprimir o usar en clase */
function subtitleToPlainText(content) {
  const lines = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const chunks = [];
  let current = [];

  const isIndex = (line) => /^\d+$/.test(line.trim());
  const isTime = (line) =>
    /\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}/.test(line) ||
    /^\d{1,2}:\d{2}[.,]\d{1,3}\s*-->/.test(line);
  const isMeta = (line) => {
    const t = line.trim();
    return (
      !t ||
      /^WEBVTT/i.test(t) ||
      /^NOTE\b/i.test(t) ||
      /^STYLE\b/i.test(t) ||
      /^REGION\b/i.test(t) ||
      /^X-TIMESTAMP/i.test(t) ||
      /^Kind:/i.test(t) ||
      /^Language:/i.test(t)
    );
  };

  const flush = () => {
    if (!current.length) return;
    const text = current
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\.*?\}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) chunks.push(text);
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (isMeta(trimmed) && !current.length) continue;
    if (isIndex(trimmed) || isTime(trimmed)) {
      flush();
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }
    current.push(trimmed);
  }
  flush();

  // Evitar líneas repetidas consecutivas (común en auto-subs)
  const unique = [];
  for (const chunk of chunks) {
    if (unique[unique.length - 1] !== chunk) unique.push(chunk);
  }

  return unique.join('\n\n').trim() + (unique.length ? '\n' : '');
}

function writePlainSubtitleText(subtitlePath, title) {
  if (!subtitlePath || !fs.existsSync(subtitlePath)) return null;

  const content = fs.readFileSync(subtitlePath, 'utf8');
  const plain = subtitleToPlainText(content);
  if (!plain.trim()) return null;

  let target = path.join(path.dirname(subtitlePath), `${title}.txt`);
  if (fs.existsSync(target)) {
    target = path.join(path.dirname(subtitlePath), `${title} (${Date.now()}).txt`);
  }

  fs.writeFileSync(target, plain, 'utf8');
  return target;
}

function parseSubtitleTimestamp(value) {
  const raw = String(value || '').trim().replace(',', '.');
  const match = raw.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number((match[4] || '0').padEnd(3, '0'));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function formatSrtTimestamp(totalSeconds) {
  const safe = Math.max(0, totalSeconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);

  return (
    `${String(hours).padStart(2, '0')}:` +
    `${String(minutes).padStart(2, '0')}:` +
    `${String(seconds).padStart(2, '0')},` +
    `${String(millis).padStart(3, '0')}`
  );
}

/**
 * Recorta un .srt/.vtt al rango [start, end] y corre los tiempos a 0
 * para que coincidan con un video/audio recortado.
 */
function trimSubtitleFile(subtitlePath, trim) {
  if (!subtitlePath || !trim || !fs.existsSync(subtitlePath)) return subtitlePath;

  const start = trim.start || 0;
  const end = trim.end == null ? Number.POSITIVE_INFINITY : trim.end;
  const content = fs.readFileSync(subtitlePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = content.split(/\r?\n/);
  const cues = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || /^WEBVTT/i.test(line) || /^NOTE\b/i.test(line) || /^STYLE\b/i.test(line)) {
      i += 1;
      continue;
    }

    if (/^\d+$/.test(line) && i + 1 < lines.length && /-->/.test(lines[i + 1])) {
      i += 1;
    }

    if (i >= lines.length || !/-->/.test(lines[i])) {
      i += 1;
      continue;
    }

    const timeLine = lines[i].trim();
    const parts = timeLine.split('-->');
    if (parts.length < 2) {
      i += 1;
      continue;
    }

    const cueStart = parseSubtitleTimestamp(parts[0].trim().split(/\s+/)[0]);
    const cueEnd = parseSubtitleTimestamp(parts[1].trim().split(/\s+/)[0]);
    i += 1;

    const textLines = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i]);
      i += 1;
    }
    while (i < lines.length && lines[i].trim() === '') i += 1;

    if (cueStart == null || cueEnd == null) continue;
    if (cueEnd <= start || cueStart >= end) continue;

    const clippedStart = Math.max(cueStart, start);
    const clippedEnd = Math.min(cueEnd, end);
    if (clippedEnd <= clippedStart) continue;

    cues.push({
      start: clippedStart - start,
      end: clippedEnd - start,
      text: textLines.join('\n').trim(),
    });
  }

  const body = cues
    .map((cue, index) => {
      return (
        `${index + 1}\n` +
        `${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}\n` +
        `${cue.text}`
      );
    })
    .join('\n\n');

  const nextPath = subtitlePath.replace(/\.(vtt|ass)$/i, '.srt');
  fs.writeFileSync(nextPath, body ? `${body}\n` : '', 'utf8');

  if (nextPath !== subtitlePath && fs.existsSync(subtitlePath)) {
    try {
      fs.unlinkSync(subtitlePath);
    } catch {
      /* ignore */
    }
  }

  return nextPath;
}

function friendlyYtError(stderr = '', fallback) {
  const text = String(stderr);
  const lower = text.toLowerCase();

  if (lower.includes('private video') || lower.includes('login required')) {
    return 'Este video es privado o requiere iniciar sesión.';
  }
  if (lower.includes('video unavailable') || lower.includes('not available')) {
    return 'Este video no está disponible.';
  }
  if (lower.includes('sign in to confirm') || lower.includes('bot')) {
    return 'YouTube bloqueó la descarga temporalmente. Probá más tarde.';
  }
  if (lower.includes('ffmpeg')) {
    return 'Falta FFmpeg para convertir. Reinstalá las dependencias con npm install.';
  }
  if (lower.includes('requested format is not available')) {
    return 'No hay un formato descargable para este video. Probá otro enlace.';
  }
  if (lower.includes('http error 403') || lower.includes('403: forbidden')) {
    return 'YouTube bloqueó esta descarga (403). Cerrá la app, abrila de nuevo y probá otra vez.';
  }
  if (lower.includes('too many requests') || lower.includes('http error 429')) {
    return 'YouTube limitó las descargas un momento. Esperá unos segundos y probá de nuevo.';
  }
  if (lower.includes('no subtitles') || lower.includes('there are no subtitles')) {
    return 'Este video no tiene subtítulos disponibles.';
  }

  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^ERROR:/i.test(l));

  if (line) return line.replace(/^ERROR:\s*/i, '').slice(0, 220);
  return fallback;
}

function emitProcessLines(chunk, state, onLine) {
  const text = state.buffer + chunk.toString();
  const parts = text.split(/\r\n|\n|\r/);
  state.buffer = parts.pop() || '';
  for (const part of parts) {
    const line = part.trim();
    if (line) onLine(line);
  }
}

function runYtDlp(args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(YTDLP_PATH)) {
      reject(new Error('No se encontró yt-dlp. Corré npm install en la carpeta del proyecto.'));
      return;
    }

    const child = spawn(YTDLP_PATH, args, {
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      },
    });

    let stdout = '';
    let stderr = '';
    const outState = { buffer: '' };
    const errState = { buffer: '' };

    const handleLine = (line) => {
      if (onLine) onLine(line);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      emitProcessLines(chunk, outState, handleLine);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      process.stdout.write(chunk.toString());
      emitProcessLines(chunk, errState, handleLine);
    });

    child.on('error', (err) => {
      reject(new Error(`No se pudo iniciar yt-dlp: ${err.message}`));
    });

    child.on('close', (code) => {
      if (outState.buffer.trim()) handleLine(outState.buffer.trim());
      if (errState.buffer.trim()) handleLine(errState.buffer.trim());

      if (code === 0) resolve({ stdout, stderr });
      else {
        console.error('[yt-dlp failed]', code, stderr.slice(-800));
        reject(
          Object.assign(new Error(friendlyYtError(stderr, 'Falló la descarga.')), {
            stderr,
            stdout,
            code,
          })
        );
      }
    });
  });
}

function parseDownloadPercent(line) {
  const marker = line.match(/AULA_PROGRESS:\s*(\d+(?:\.\d+)?)\s*%?/i);
  if (marker) return Number(marker[1]);

  const classic = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
  if (classic) return Number(classic[1]);

  const bytes = line.match(/AULA_BYTES:(\d+):(\d+)/i);
  if (bytes) {
    const downloaded = Number(bytes[1]);
    const total = Number(bytes[2]);
    if (total > 0) return (downloaded / total) * 100;
  }

  return null;
}

function mapDownloadToOverall(downloadPercent) {
  return 8 + Math.max(0, Math.min(100, downloadPercent)) * 0.8;
}

const YT_BASE_ARGS = [
  '--no-playlist',
  '--no-warnings',
  '--extractor-args',
  // android_vr obtiene el video pero Google responde 403 al bajarlo
  'youtube:player_client=android',
];

const YT_PROGRESS_ARGS = [
  '--progress',
  '--newline',
  '--progress-template',
  'AULA_PROGRESS:%(progress._percent_str)s',
  '--progress-template',
  'download:AULA_BYTES:%(progress.downloaded_bytes)s:%(progress.total_bytes|0)s',
];

function createWindow() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'icon.png')
    : path.join(__dirname, '..', 'assets', 'icon.png');
  // electron-builder pone el icono en win; el png también vive en asar
  const iconCandidates = [
    iconPath,
    path.join(__dirname, '..', 'assets', 'icon.png'),
    path.join(process.resourcesPath, 'app.asar', 'assets', 'icon.png'),
  ];
  const resolvedIcon = iconCandidates.find((p) => fs.existsSync(p));

  const win = new BrowserWindow({
    width: 920,
    height: 780,
    minWidth: 760,
    minHeight: 620,
    title: 'Aula Media',
    backgroundColor: '#f3efe6',
    icon: resolvedIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.aulamedia.app');
  }
  ensureLibraryFolders();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('library:getInfo', async () => {
  const folders = ensureLibraryFolders();
  return {
    root: folders.root,
    videos: folders.videos,
    audio: folders.audio,
    subs: folders.subs,
  };
});

ipcMain.handle('library:openFolder', async (_event, kind) => {
  const folders = ensureLibraryFolders();
  const map = {
    videos: folders.videos,
    audio: folders.audio,
    subs: folders.subs,
    root: folders.root,
  };
  await shell.openPath(map[kind] || folders.root);
  return true;
});

ipcMain.handle('download:start', async (event, payload) => {
  const { url, mode, withSubs = false, trimFrom = '', trimTo = '', forProjector = false } = payload || {};
  const cleanUrl = String(url || '').trim();
  if (!isYouTubeUrl(cleanUrl)) {
    throw new Error('Pegá un enlace válido de YouTube.');
  }

  let trim;
  try {
    trim = mode === 'subs' ? null : resolveTrimRange(trimFrom, trimTo);
  } catch (err) {
    throw new Error(err.message);
  }

  const folders = ensureLibraryFolders();
  const isAudio = mode === 'audio';
  const isSubsOnly = mode === 'subs';
  const wantSubs = isSubsOnly || Boolean(withSubs);
  const outputDir = isAudio ? folders.audio : isSubsOnly ? folders.subs : folders.videos;

  const send = (data) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('download:progress', data);
    }
  };

  send({ status: 'info', message: 'Obteniendo datos del video…', percent: 0 });

  let videoId = 'video';
  let title = 'sin-titulo';

  try {
    const { stdout } = await runYtDlp([
      cleanUrl,
      ...YT_BASE_ARGS,
      '--print',
      '%(id)s',
      '--print',
      '%(title)s',
    ]);
    const lines = stdout
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    videoId = sanitizeFilename(lines[0] || 'video');
    title = sanitizeFilename(lines[1] || videoId);
  } catch (err) {
    throw new Error(err.message || 'No se pudo leer el video. Revisá el enlace o tu conexión.');
  }

  const mediaTemplate = path.join(outputDir, `${videoId}.%(ext)s`);
  const trimmedLabel = trim
    ? ` (${formatSectionTime(trim.start)}-${trim.end == null ? 'fin' : formatSectionTime(trim.end)})`
    : '';
  const finalTitle = sanitizeFilename(`${title}${trimmedLabel}`);

  let subLang = null;
  if (wantSubs) {
    send({
      status: 'info',
      message: `Buscando subtítulos: ${title}`,
      percent: 5,
      title,
    });
    try {
      subLang = await pickSubtitleLang(cleanUrl);
    } catch (err) {
      console.error('[pickSubtitleLang]', err.message);
    }
    if (isSubsOnly && !subLang) {
      throw new Error('Este video no tiene subtítulos disponibles (ni manuales ni automáticos).');
    }
  }

  send({
    status: 'info',
    message: isSubsOnly
      ? `Descargando subtítulos (${subLang}): ${title}`
      : isAudio
        ? `Preparando audio: ${title}`
        : `Preparando video: ${title}`,
    percent: 8,
    title,
  });

  const args = [cleanUrl, ...YT_BASE_ARGS, ...YT_PROGRESS_ARGS];

  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    args.push('--ffmpeg-location', ffmpegPath);
  }

  if (isSubsOnly) {
    args.push(...subtitleDownloadArgs(folders.subs, videoId, subLang));
  } else {
    args.push('--output', mediaTemplate);

    if (trim) {
      const endPart = trim.end == null ? 'inf' : formatSectionTime(trim.end);
      args.push(
        '--download-sections',
        `*${formatSectionTime(trim.start)}-${endPart}`,
        '--force-keyframes-at-cuts'
      );
    }

    if (isAudio) {
      args.push(
        '--extract-audio',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '0',
        '--format',
        'bestaudio/best/ba/b'
      );
    } else {
      args.push('--format', 'bv*+ba/b', '--merge-output-format', 'mp4');
    }
  }

  let lastPercent = 8;

  try {
    await runYtDlp(args, {
      onLine: (line) => {
        const downloadPct = parseDownloadPercent(line);
        if (downloadPct != null) {
          const overall = Math.max(lastPercent, Math.min(88, mapDownloadToOverall(downloadPct)));
          lastPercent = overall;
          send({
            status: 'progress',
            message: isSubsOnly
              ? 'Descargando subtítulos…'
              : isAudio
                ? 'Descargando audio…'
                : 'Descargando video…',
            percent: overall,
            title,
          });
          return;
        }

        if (/\[ExtractAudio\]|\[Merger\]|\[Fixup|Deleting original|\[SubtitlesConvertor\]/i.test(line)) {
          lastPercent = Math.max(lastPercent, 92);
          send({
            status: 'progress',
            message: isSubsOnly
              ? 'Convirtiendo subtítulos…'
              : isAudio
                ? 'Convirtiendo a MP3…'
                : 'Uniendo / recortando…',
            percent: lastPercent,
            title,
          });
        }
      },
    });
  } catch (err) {
    throw new Error(err.message || 'Falló la descarga. Probá de nuevo o con otro enlace.');
  }

  // Subtítulos en un segundo paso: si fallan, el video/audio igual queda guardado
  if (!isSubsOnly && wantSubs && subLang) {
    send({
      status: 'progress',
      message: `Descargando subtítulos (${subLang})…`,
      percent: Math.max(lastPercent, 93),
      title,
    });

    try {
      await runYtDlp([cleanUrl, ...YT_BASE_ARGS, ...subtitleDownloadArgs(folders.subs, videoId, subLang)]);
    } catch (err) {
      console.error('[subs optional failed]', err.message);
    }
  }

  let savedPath = null;
  let subtitlePath = null;
  let textPath = null;
  let trimmed = Boolean(trim);

  if (isSubsOnly) {
    const subs = findSubtitleFiles(folders.subs, videoId);
    if (!subs.length) {
      throw new Error('No se encontraron subtítulos para este video (ni manuales ni automáticos).');
    }
    subtitlePath = renameSubtitle(subs[0], finalTitle, videoId);
    for (const extra of subs.slice(1)) {
      try {
        renameSubtitle(extra, finalTitle, videoId);
      } catch {
        /* ignore */
      }
    }
    textPath = writePlainSubtitleText(subtitlePath, finalTitle);
    savedPath = textPath || subtitlePath;
  } else {
    savedPath = findById(
      outputDir,
      videoId,
      isAudio ? ['.mp3', '.m4a', '.webm', '.opus'] : ['.mp4', '.mkv', '.webm']
    );

    if (savedPath) {
      savedPath = renameKeepExt(savedPath, finalTitle);
    }

    if (!isAudio && forProjector && savedPath && fs.existsSync(savedPath)) {
      send({
        status: 'progress',
        message: 'Adaptando para el proyector…',
        percent: 90,
        title,
      });

      let projectorOut = path.join(path.dirname(savedPath), `${finalTitle} (proyector).mp4`);
      if (fs.existsSync(projectorOut)) {
        projectorOut = path.join(
          path.dirname(savedPath),
          `${finalTitle} (proyector ${Date.now()}).mp4`
        );
      }

      const converted = await transcodeForProjector(savedPath, projectorOut, (pct) => {
        send({
          status: 'progress',
          message: 'Adaptando para el proyector…',
          percent: 90 + pct * 0.09,
          title,
        });
      });

      if (savedPath !== converted && fs.existsSync(savedPath)) {
        try {
          fs.unlinkSync(savedPath);
        } catch {
          /* ignore */
        }
      }
      savedPath = converted;
    }

    if (wantSubs) {
      const subs = findSubtitleFiles(folders.subs, videoId);
      if (subs.length) {
        subtitlePath = renameSubtitle(subs[0], finalTitle, videoId);
        for (const extra of subs.slice(1)) {
          try {
            renameSubtitle(extra, finalTitle, videoId);
          } catch {
            /* ignore */
          }
        }
        textPath = writePlainSubtitleText(subtitlePath, finalTitle);
      }
    }
  }

  const folderLabel = isSubsOnly ? 'Subtitulos' : isAudio ? 'Audio' : 'Videos';
  const bits = [`Guardado en ${folderLabel}`];
  if (trimmed) bits.push('recorte');
  if (!isAudio && !isSubsOnly && forProjector) bits.push('proyector');
  if (subtitlePath && !isSubsOnly) bits.push('subtítulos');
  if (textPath) bits.push('texto .txt');

  send({
    status: 'done',
    message: `Listo. ${bits.join(' · ')}`,
    percent: 100,
    title: finalTitle,
    savedPath: savedPath || outputDir,
    subtitlePath,
    textPath,
    folder: outputDir,
  });

  return {
    title: finalTitle,
    savedPath: savedPath || outputDir,
    subtitlePath,
    textPath,
    folder: outputDir,
    mode,
    trimmed,
    forProjector: Boolean(!isAudio && !isSubsOnly && forProjector),
  };
});
