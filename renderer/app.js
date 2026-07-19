const urlInput = document.getElementById('url');
const btnDownload = document.getElementById('btnDownload');
const statusPanel = document.getElementById('statusPanel');
const statusText = document.getElementById('statusText');
const statusPercent = document.getElementById('statusPercent');
const barFill = document.getElementById('barFill');
const libraryPath = document.getElementById('libraryPath');
const modeButtons = document.querySelectorAll('.mode');
const mediaOptions = document.getElementById('mediaOptions');
const withSubsWrap = document.getElementById('withSubsWrap');
const withSubs = document.getElementById('withSubs');
const trimFrom = document.getElementById('trimFrom');
const trimTo = document.getElementById('trimTo');

let selectedMode = 'video';
let busy = false;

function syncOptionsVisibility() {
  const isSubsOnly = selectedMode === 'subs';
  withSubsWrap.hidden = isSubsOnly;
  if (isSubsOnly) withSubs.checked = false;
  mediaOptions.hidden = false;
}

modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (busy) return;
    modeButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedMode = btn.dataset.mode;
    syncOptionsVisibility();
  });
});

function setStatus({ message, percent = 0, state = '' }) {
  statusPanel.hidden = false;
  statusPanel.classList.remove('error', 'done');
  if (state) statusPanel.classList.add(state);
  statusText.textContent = message;
  const safe = Math.max(0, Math.min(100, percent));
  statusPercent.textContent = `${Math.round(safe)}%`;
  barFill.style.width = `${safe}%`;
}

async function refreshLibrary() {
  const info = await window.aulaMedia.getLibraryInfo();
  libraryPath.textContent = info.root;
}

document.getElementById('btnOpenRoot').addEventListener('click', () => {
  window.aulaMedia.openFolder('root');
});

document.getElementById('btnOpenVideos').addEventListener('click', () => {
  window.aulaMedia.openFolder('videos');
});

document.getElementById('btnOpenAudio').addEventListener('click', () => {
  window.aulaMedia.openFolder('audio');
});

document.getElementById('btnOpenSubs').addEventListener('click', () => {
  window.aulaMedia.openFolder('subs');
});

window.aulaMedia.onProgress((data) => {
  setStatus({
    message: data.message,
    percent: data.percent ?? 0,
    state: data.status === 'done' ? 'done' : '',
  });
});

btnDownload.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus({ message: 'Pegá un enlace de YouTube.', percent: 0, state: 'error' });
    urlInput.focus();
    return;
  }

  busy = true;
  btnDownload.disabled = true;
  setStatus({ message: 'Iniciando…', percent: 2 });

  try {
    const result = await window.aulaMedia.startDownload({
      url,
      mode: selectedMode,
      withSubs: selectedMode !== 'subs' && withSubs.checked,
      trimFrom: trimFrom.value.trim(),
      trimTo: trimTo.value.trim(),
    });

    const extra = [
      result.subtitlePath ? 'subtítulos' : null,
      result.textPath ? 'texto' : null,
    ]
      .filter(Boolean)
      .join(' + ');
    const extraNote = extra ? ` + ${extra}` : '';
    const trimNote = result.trimmed ? ' (recorte)' : '';
    setStatus({
      message: `Listo: ${result.title}${trimNote}${extraNote}`,
      percent: 100,
      state: 'done',
    });
  } catch (err) {
    setStatus({
      message: err?.message || 'No se pudo descargar.',
      percent: 0,
      state: 'error',
    });
  } finally {
    busy = false;
    btnDownload.disabled = false;
  }
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnDownload.click();
});

syncOptionsVisibility();
refreshLibrary().catch(() => {
  libraryPath.textContent = 'No se pudo leer la carpeta de biblioteca.';
});
