// Options page logic

const $censorChar = document.getElementById('censorChar');
const $beepVolume = document.getElementById('beepVolume');
const $domainWhitelist = document.getElementById('domainWhitelist');
const $customPatterns = document.getElementById('customPatterns');
const $statTotal = document.getElementById('stat-total');
const $statToday = document.getElementById('stat-today');
const $resetStats = document.getElementById('reset-stats');
const $saved = document.getElementById('saved-indicator');

let _saveTimer = null;
function showSaved() {
  $saved.classList.add('show');
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => $saved.classList.remove('show'), 1500);
}

async function load() {
  const data = await chrome.storage.local.get([
    'censorChar', 'beepVolume', 'domainWhitelist', 'customPatterns', 'stats',
  ]);
  $censorChar.value = data.censorChar || '*';
  $beepVolume.value = typeof data.beepVolume === 'number' ? data.beepVolume : 0.6;
  $domainWhitelist.value = (data.domainWhitelist || []).join('\n');
  $customPatterns.value = (data.customPatterns || []).join('\n');

  const s = data.stats || { totalCensored: 0, byDay: {} };
  const today = new Date().toISOString().slice(0, 10);
  $statTotal.textContent = String(s.totalCensored || 0);
  $statToday.textContent = String(s.byDay?.[today] || 0);
}

function parseLines(text) {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

async function save(patch) {
  await chrome.storage.local.set(patch);
  showSaved();
}

$censorChar.addEventListener('input', () => {
  const v = ($censorChar.value || '*').slice(0, 1);
  save({ censorChar: v });
});

$beepVolume.addEventListener('input', () => {
  const v = Math.max(0, Math.min(1, parseFloat($beepVolume.value) || 0));
  save({ beepVolume: v });
});

$domainWhitelist.addEventListener('input', () => {
  save({ domainWhitelist: parseLines($domainWhitelist.value) });
});

$customPatterns.addEventListener('input', () => {
  save({ customPatterns: parseLines($customPatterns.value) });
});

$resetStats.addEventListener('click', async () => {
  if (!confirm('Azzerare tutte le statistiche?')) return;
  await chrome.storage.local.set({ stats: { totalCensored: 0, byDay: {} } });
  $statTotal.textContent = '0';
  $statToday.textContent = '0';
});

load();
