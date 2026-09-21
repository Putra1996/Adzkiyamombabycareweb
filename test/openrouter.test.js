// Tes regresi OpenRouter: harus tetap berfungsi walau akun belum punya kredit.
//
// Konteks nyata: akun OpenRouter pengguna membalas HTTP 402
//   "Insufficient credits. This account never purchased credits."
// untuk SEMUA model berbayar, sehingga OpenRouter selalu gagal dan perannya
// sebagai cadangan Gemini tidak pernah jalan.
//
// Perbaikan yang dikunci tes ini:
//   • deteksi 402 -> otomatis pindah ke model GRATIS (`:free`),
//   • daftar model gratis diambil dari API (bukan hardcode), dengan
//     penyaringan model non-teks dan peringkat kualitas,
//   • mode "hanya model gratis" dipakai untuk permintaan berikutnya,
//   • 401 (kunci salah) tidak dicoba berulang-ulang (hemat waktu & kuota),
//   • hedging tidak memakai kunci yang sudah terbukti ditolak.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function block(marker) {
  const i = serverSrc.indexOf(marker);
  assert.ok(i > 0, `blok "${marker}" tidak ada di server.js`);
  const end = serverSrc.indexOf('\n}\n', i);
  return serverSrc.slice(i, end + 3);
}

function makeSandbox(opts) {
  const o = opts || {};
  const calls = { models: 0, chat: [] };
  const paidStatus = o.paidStatus === undefined ? 402 : o.paidStatus;
  const freeFails = !!o.freeFails;
  const listFails = !!o.listFails;

  const FREE = [
    { id: 'google/gemini-2.0-flash-exp:free', context_length: 1000000, pricing: { prompt: '0', completion: '0' } },
    { id: 'deepseek/deepseek-chat-v3-0324:free', context_length: 163000, pricing: { prompt: '0', completion: '0' } },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', context_length: 128000, pricing: { prompt: '0', completion: '0' } },
    { id: 'text-embedding-3-small', context_length: 8000, pricing: { prompt: '0', completion: '0' } }
  ];
  const PAID = [
    { id: 'google/gemini-2.5-flash', context_length: 1000000, pricing: { prompt: '0.0000003', completion: '0.0000025' } },
    { id: 'openrouter/auto', context_length: 2000000, pricing: { prompt: '0.000001', completion: '0.000003' } }
  ];

  const resp = (status, body) => ({
    ok: status < 300, status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
  });

  const fetchMock = async function (url, options) {
    const target = String(url);
    if (target.includes('/api/v1/models')) {
      calls.models++;
      if (listFails) return resp(500, { error: 'server error' });
      return resp(200, { data: PAID.concat(FREE) });
    }
    if (target.includes('/api/v1/chat/completions')) {
      const body = JSON.parse((options && options.body) || '{}');
      calls.chat.push(body.model);
      const isFree = /:free$/.test(String(body.model));
      if (!isFree) {
        if (paidStatus === 200) return resp(200, { choices: [{ message: { content: 'Balasan berbayar 🌸 (' + body.model + ')' } }] });
        return resp(paidStatus, { error: { message: 'Insufficient credits. This account never purchased credits.' } });
      }
      if (freeFails) return resp(429, { error: { message: 'Rate limit exceeded' } });
      return resp(200, { choices: [{ message: { content: 'Balasan gratis 🌸 (' + body.model + ')' } }] });
    }
    return resp(404, {});
  };

  const sandbox = {
    console, fetch: fetchMock, setTimeout, clearTimeout, AbortController, URL, encodeURIComponent,
    DB: { settings: Object.assign({ ai_openrouter_api_key: 'sk-or-dummy' }, o.settings || {}) },
    save: () => {}, process: { env: {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(block('async function fetchWithTimeout'), sandbox);
  vm.runInContext('function sanitizeDbError(e){ return String((e && e.message) || e); }', sandbox);
  vm.runInContext(block('function sanitizeAIError'), sandbox);
  vm.runInContext(block('function sanitizeAIReply'), sandbox);
  vm.runInContext(serverSrc.slice(serverSrc.indexOf('const GEMINI_LIST_TTL_MS'), serverSrc.indexOf('async function callOpenRouter')), sandbox);
  vm.runInContext(block('async function callOpenRouter'), sandbox);
  return { sandbox, calls };
}

test('Klasifikasi model gratis: `:free` dan harga nol', () => {
  const { sandbox } = makeSandbox();
  const free = (m) => vm.runInContext('isOpenRouterFree(' + JSON.stringify(m) + ')', sandbox);
  assert.equal(free('meta-llama/llama-3.3-70b-instruct:free'), true, 'sufiks :free tidak dikenali');
  assert.equal(free({ id: 'x/y', pricing: { prompt: '0', completion: '0' } }), true, 'harga nol tidak dikenali');
  assert.equal(free({ id: 'x/y', pricing: { prompt: '0.0', completion: '0' } }), true);
  assert.equal(free({ id: 'google/gemini-2.5-flash', pricing: { prompt: '0.0000003', completion: '0.0000025' } }), false, 'model berbayar dianggap gratis');
  assert.equal(free({ id: 'x/y' }), false, 'model tanpa info harga dianggap gratis');
});

test('Peringkat model gratis: non-teks dibuang, keluarga bagus & konteks besar diutamakan', () => {
  const { sandbox } = makeSandbox();
  const score = (id, ctx) => vm.runInContext('scoreOpenRouterFree(' + JSON.stringify({ id, context: ctx }) + ')', sandbox);
  assert.equal(score('text-embedding-3-small', 8000), 0, 'model embedding diberi skor');
  assert.equal(score('openai/moderation-latest:free', 8000), 0, 'model moderasi diberi skor');
  assert.ok(score('google/gemini-2.0-flash-exp:free', 1000000) > score('some/unknown-chat:free', 8000),
    'keluarga bagus + konteks besar tidak diutamakan');
});

test('Akun tanpa kredit (402): otomatis pindah ke model gratis dan tetap menjawab', async () => {
  const { sandbox, calls } = makeSandbox({ paidStatus: 402 });
  const r = await vm.runInContext('callOpenRouter("sys", [{role:"user",content:"halo"}])', sandbox);
  assert.ok(/:free$/.test(r.model), 'model yang dipakai bukan model gratis: ' + r.model);
  assert.equal(r.free, true, 'penanda free_model tidak diset');
  assert.match(r.reply, /Balasan gratis/);
  // Model berbayar dicoba lebih dulu (kualitas terbaik bila ada kredit),
  // lalu berpindah ke gratis setelah 402.
  assert.ok(calls.chat.some((m) => !/:free$/.test(m)), 'model berbayar tidak pernah dicoba');
  assert.ok(calls.chat.some((m) => /:free$/.test(m)), 'model gratis tidak pernah dicoba');
  // Mode hemat diingat untuk permintaan berikutnya.
  assert.equal(sandbox.DB.settings.ai_openrouter_free_only, true, 'mode model gratis tidak disimpan');
  assert.equal(sandbox.DB.settings.ai_openrouter_model, r.model, 'model yang berhasil tidak disimpan');
});

test('Mode "hanya model gratis": model berbayar tidak dipanggil sama sekali', async () => {
  const { sandbox, calls } = makeSandbox({ settings: { ai_openrouter_free_only: true } });
  const r = await vm.runInContext('callOpenRouter("sys", [{role:"user",content:"halo"}])', sandbox);
  assert.ok(/:free$/.test(r.model));
  assert.ok(calls.chat.every((m) => /:free$/.test(m)), 'masih memanggil model berbayar di mode gratis: ' + calls.chat.join(', '));
});

test('Kunci ditolak (401): berhenti cepat, tidak mencoba semua model', async () => {
  // Mode normal (bukan hemat) supaya model berbayar dicoba lebih dulu dan
  // justru di situ kunci ditolak.
  const { sandbox, calls } = makeSandbox({ paidStatus: 401 });
  await assert.rejects(
    () => vm.runInContext('callOpenRouter("sys", [{role:"user",content:"halo"}])', sandbox),
    (e) => /Kunci OpenRouter ditolak/.test(e.message),
    'pesan galat kunci tidak jelas'
  );
  assert.equal(calls.chat.length, 1, 'mencoba berkali-kali walau kunci sudah ditolak: ' + calls.chat.join(', '));
  assert.equal(sandbox.DB.settings.ai_openrouter_model, undefined, 'model tersimpan padahal kunci ditolak');
});

test('Kunci yang sudah ditolak tidak dipakai untuk hedging', async () => {
  const { sandbox } = makeSandbox({ paidStatus: 401 });
  await assert.rejects(() => vm.runInContext('callOpenRouter("sys", [{role:"user",content:"x"}])', sandbox));
  assert.equal(vm.runInContext('openRouterKeyUsable()', sandbox), false, 'kunci tetap dianggap layak setelah 401');
});

test('Daftar model tidak bisa diambil: tetap jalan memakai cadangan statis', async () => {
  const { sandbox, calls } = makeSandbox({ listFails: true, settings: { ai_openrouter_free_only: true } });
  const r = await vm.runInContext('callOpenRouter("sys", [{role:"user",content:"halo"}])', sandbox);
  assert.ok(/:free$/.test(r.model), 'fallback statis tidak dipakai: ' + r.model);
  assert.ok(calls.models >= 1, 'endpoint daftar model tidak pernah dipanggil');
  const cached = vm.runInContext('(orModelsCache.models || []).length', sandbox);
  assert.equal(cached, 0, 'cache daftar model terisi walau pengambilan gagal');
});

test('Semua model gratis kena batas laju: dilaporkan gagal dengan jelas', async () => {
  const { sandbox } = makeSandbox({ freeFails: true, settings: { ai_openrouter_free_only: true } });
  await assert.rejects(
    () => vm.runInContext('callOpenRouter("sys", [{role:"user",content:"halo"}])', sandbox),
    (e) => /Semua model OpenRouter gagal/.test(e.message) && /429/.test(e.message),
    'kegagalan batas laju tidak dilaporkan'
  );
});

test('Pemulihan otomatis: setelah 24 jam, model berbayar dicoba lagi', async () => {
  // Skenario: kredit OpenRouter baru ditambahkan. Mode hemat yang dinyalakan
  // otomatis harus kedaluwarsa sehingga sistem kembali ke model terbaik.
  const lama = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const { sandbox, calls } = makeSandbox({ paidStatus: 200, settings: { ai_openrouter_free_only: true, ai_openrouter_free_only_at: lama } });
  const r = await vm.runInContext('callOpenRouter("sys", [{role:"user",content:"halo"}])', sandbox);
  assert.ok(!/:free$/.test(r.model), 'model gratis masih dipakai setelah mode hemat kedaluwarsa');
  assert.ok(calls.chat.some((m) => !/:free$/.test(m)), 'model berbayar tidak dicoba ulang setelah 24 jam');
  // Mode hemat dimatikan lagi karena model berbayar berhasil.
  assert.equal(sandbox.DB.settings.ai_openrouter_free_only, false, 'mode hemat tidak dimatikan setelah kredit tersedia');
});

test('Mode hemat yang MASIH baru tidak mencoba model berbayar', async () => {
  const baru = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { sandbox, calls } = makeSandbox({ settings: { ai_openrouter_free_only: true, ai_openrouter_free_only_at: baru } });
  await vm.runInContext('callOpenRouter("sys", [{role:"user",content:"halo"}])', sandbox);
  assert.ok(calls.chat.every((m) => /:free$/.test(m)), 'model berbayar dicoba padahal mode hemat masih berlaku');
});

test('Server & panel: mode gratis terekspos dan dijelaskan ke admin', () => {
  assert.match(serverSrc, /openrouter_free_only/, 'flag mode gratis tidak ada di server');
  assert.match(serverSrc, /Insufficient credits/, 'pesan 402 tidak dikenali');
  assert.match(serverSrc, /openrouter_free_models_cached/, 'jumlah model gratis tidak dilaporkan');
  assert.match(serverSrc, /akun OpenRouter belum membeli kredit|belum membeli kredit/, 'saran untuk 402 tidak ada');
  const adminJs = fs.readFileSync(path.join(ROOT, 'public/js/admin.js'), 'utf8');
  assert.match(adminJs, /aiOpenRouterFreeOnly/, 'opsi "hanya model gratis" hilang dari panel');
  assert.match(adminJs, /openrouter\.ai\/credits/, 'tautan menambah kredit hilang dari panel');
});

test('docs/ sinkron dengan public/ untuk panel admin', () => {
  assert.equal(
    fs.readFileSync(path.join(ROOT, 'public/js/admin.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'docs/js/admin.js'), 'utf8'),
    'docs/js/admin.js berbeda — jalankan: node build-gh-pages.js'
  );
});
