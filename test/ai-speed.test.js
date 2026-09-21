// Tes regresi KECEPATAN & KETAHANAN jalur AI.
//
// Latar belakang: pengunjung mengeluh balasan AI lama. Penyebab yang
// ditemukan & diperbaiki:
//   1. Riwayat percakapan dikirim 10 pesan × 1000 karakter (≈18.000 karakter
//      saat riwayat penuh) -> prompt processing lambat.
//   2. Prompt sistem dibangun ulang setiap permintaan.
//   3. Output dibatasi 500 token padahal jawaban CS cukup pendek
//      (token keluaran = penyumbang waktu tunggu terbesar).
//   4. ListModels dipanggil sebelum percobaan pertama (1 round trip ekstra).
//   5. Provider dipakai berurutan: Gemini lambat -> pengunjung menunggu
//      sampai habis baru pindah ke OpenRouter.
//   6. Timeout 30 detik per model.
//
// Tes ini juga mengunci perbaikan BUG KRUSIAL di pembatalan: memakai
// `req.on('close')` akan membatalkan setiap panggilan AI seketika (event itu
// menyala +0 ms, saat respons belum dikirim) sehingga bot tidak pernah
// menjawab. Yang benar: `res.on('close')` dengan penjaga `res.writableEnded`.
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

// ---------- sandbox berisi potongan server.js + tiruan provider ----------
function makeSandbox(opts) {
  const o = opts || {};
  const calls = { list: 0, gemini: [], openrouter: [] };
  const geminiDelay = o.geminiDelay === undefined ? 100 : o.geminiDelay;
  const orDelay = o.orDelay === undefined ? 100 : o.orDelay;
  const orFails = !!o.openrouterFails;
  const geminiFails = !!o.geminiFails;
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) { clearTimeout(t); return reject(new Error('aborted')); }
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    }
  });
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) });

  const fetchMock = async function (url, options) {
    const target = String(url);
    if (target.includes('generativelanguage.googleapis.com')) {
      const isGenerate = /:generateContent/.test(target);
      if (!isGenerate) {
        calls.list++;
        return ok({ models: ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest'].map((n) => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) });
      }
      const model = decodeURIComponent((target.match(/\/models\/([^:]+):generateContent/) || [, '?'])[1]);
      calls.gemini.push(model);
      await wait(geminiDelay, options && options.signal);
      if (geminiFails) {
        const err = { error: { code: 404, message: 'This model models/' + model + ' is no longer available for new users.' } };
        return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => err, text: async () => JSON.stringify(err) };
      }
      return ok({ candidates: [{ content: { parts: [{ text: 'Jawaban Gemini 🌸' }] } }] });
    }
    if (target.includes('openrouter.ai/api/v1/models')) {
      // Daftar model gratis (dipanggil sekali lalu di-cache).
      return ok({ data: [{ id: 'google/gemini-2.0-flash-exp:free', context_length: 1000000, pricing: { prompt: '0', completion: '0' } }] });
    }
    if (target.includes('openrouter.ai')) {
      calls.openrouter.push(JSON.parse((options && options.body) || '{}'));
      await wait(orDelay, options && options.signal);
      if (orFails) {
        const err = { error: { message: 'No auth credentials found' } };
        return { ok: false, status: 401, headers: { get: () => 'application/json' }, json: async () => err, text: async () => JSON.stringify(err) };
      }
      return ok({ choices: [{ message: { content: 'Jawaban OpenRouter 🌸' } }] });
    }
    return ok({});
  };

  const sandbox = {
    console, fetch: fetchMock, setTimeout, clearTimeout, AbortController, URL, encodeURIComponent,
    DB: { settings: Object.assign({ ai_gemini_api_key: 'AIza-dummy', ai_openrouter_api_key: 'sk-or-dummy' }, o.settings || {}) },
    save: () => {}, process: { env: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(block('async function fetchWithTimeout'), sandbox);
  vm.runInContext('function sanitizeDbError(e){ return String((e && e.message) || e); }', sandbox);
  vm.runInContext(block('function sanitizeAIError'), sandbox);
  vm.runInContext(block('function sanitizeAIReply'), sandbox);
  vm.runInContext(serverSrc.slice(serverSrc.indexOf('const GEMINI_MODEL_CANDIDATES'), serverSrc.indexOf('// Tanya ke Google model apa saja')), sandbox);
  vm.runInContext(block('async function listGeminiModels'), sandbox);
  vm.runInContext(block('async function refreshGeminiModelList'), sandbox);
  vm.runInContext(block('async function resolveGeminiModel'), sandbox);
  vm.runInContext(block('function geminiCandidates'), sandbox);
  vm.runInContext(block('function isModelUnavailable'), sandbox);
  vm.runInContext(serverSrc.slice(serverSrc.indexOf('const AI_GEMINI_TIMEOUT_MS'), serverSrc.indexOf('async function callGemini')), sandbox);
  vm.runInContext(block('async function callGemini'), sandbox);
  vm.runInContext(serverSrc.slice(serverSrc.indexOf('const OPENROUTER_MODEL_CANDIDATES'), serverSrc.indexOf('async function callOpenRouter')), sandbox);
  vm.runInContext(block('async function callOpenRouter'), sandbox);
  vm.runInContext(block('async function callAIChat') + '\n' + block('async function callAIChatInner'), sandbox);
  return { sandbox, calls };
}

test('Riwayat dipangkas: maksimal 6 pesan & 400 karakter per pesan', () => {
  const { sandbox } = makeSandbox();
  // konstanta batas riwayat + fungsinya
  vm.runInContext(serverSrc.slice(serverSrc.indexOf('const AI_HISTORY_MAX'), serverSrc.indexOf('function trimAIHistory')), sandbox);
  vm.runInContext(block('function trimAIHistory'), sandbox);
  const long = [];
  // Penanda indeks ditaruh di AWAL supaya tetap terbaca setelah dipotong 400 char.
  for (let i = 0; i < 20; i++) long.push({ role: i % 2 ? 'assistant' : 'user', content: 'MSG' + i + ' ' + 'x'.repeat(900) });
  const trimmed = vm.runInContext('trimAIHistory(' + JSON.stringify(long) + ')', sandbox);
  assert.equal(trimmed.length, 6, 'riwayat tidak dipangkas ke 6 pesan');
  for (const m of trimmed) assert.ok(m.content.length <= 400, 'pesan riwayat lebih dari 400 karakter');
  // Yang tersisa harus 6 pesan TERAKHIR (MSG14..MSG19), bukan yang paling awal.
  const indexes = Array.from(trimmed, (m) => Number(String(m.content).match(/^MSG(\d+)/)[1]));
  assert.deepEqual(indexes, [14, 15, 16, 17, 18, 19], 'bukan 6 pesan terakhir yang dipertahankan: ' + indexes.join(','));
  // Masukan aneh tidak boleh membuat error (array dari vm: konversi dulu)
  assert.equal(vm.runInContext('trimAIHistory(null).length', sandbox), 0);
  assert.equal(vm.runInContext('trimAIHistory([{},{role:"user"}]).length', sandbox), 0);
});

test('Prompt sistem di-cache: dibangun sekali, dipakai ulang', () => {
  const sandbox = { console, DB: { settings: { business_name: 'Adzkiya', address: 'Cilacap', phone: '085887018194', hours: [], ai_assistant_base_prompt: '' } } };
  vm.createContext(sandbox);
  vm.runInContext(serverSrc.slice(serverSrc.indexOf('const SERVICES = ['), serverSrc.indexOf('const SERVICE_PRICE_BY_NAME')), sandbox);
  vm.runInContext(serverSrc.slice(serverSrc.indexOf('const AI_DEFAULT_PERSONA = '), serverSrc.indexOf('`;', serverSrc.indexOf('const AI_DEFAULT_PERSONA')) + 2), sandbox);
  vm.runInContext('function waNumberFor(p,f){ return String(p||f).replace(/\\D/g,""); }', sandbox);
  vm.runInContext('function shortPrice(v){ const n=Number(v)||0; return n>=1000 ? Math.round(n/1000)+"rb" : String(n); }', sandbox);
  vm.runInContext('let _aiPromptCache = { sig: null, text: "" };', sandbox);
  vm.runInContext(block('function aiPromptSignature'), sandbox);
  vm.runInContext(block('function buildAISystemPrompt'), sandbox);
  vm.runInContext('globalThis.__built = 0; const _orig = buildAISystemPrompt; globalThis.countBuild = () => __built;', sandbox);

  const p1 = vm.runInContext('buildAISystemPrompt()', sandbox);
  const cached = vm.runInContext('_aiPromptCache.sig', sandbox);
  const p2 = vm.runInContext('buildAISystemPrompt()', sandbox);
  assert.equal(p1, p2, 'prompt berubah antar panggilan');
  assert.ok(cached, 'cache prompt tidak terisi');
  // Katalog tetap lengkap (semua kategori layanan ada)
  const cats = vm.runInContext('SERVICES.map(c => c.cat)', sandbox);
  for (const cat of cats) assert.ok(p1.includes(cat), 'kategori hilang dari prompt: ' + cat);
  // Perubahan pengaturan membatalkan cache
  vm.runInContext('DB.settings.business_name = "Nama Baru"', sandbox);
  const p3 = vm.runInContext('buildAISystemPrompt()', sandbox);
  assert.ok(p3.includes('Nama Baru'), 'perubahan pengaturan tidak tercermin (cache basi)');
  assert.notEqual(vm.runInContext('_aiPromptCache.sig', sandbox), cached, 'signature tidak berubah setelah data berubah');
});

test('Batas keluaran & timeout: token keluaran dibatasi, timeout lebih pendek', () => {
  const timeout = serverSrc.match(/const AI_GEMINI_TIMEOUT_MS = (\d+)/);
  const tokens = serverSrc.match(/const AI_MAX_OUTPUT_TOKENS = (\d+)/);
  assert.ok(timeout && Number(timeout[1]) <= 15000, 'timeout per model masih > 15 detik');
  assert.ok(tokens && Number(tokens[1]) <= 320, 'batas token keluaran masih > 320 (jawaban lambat)');
  // Kedua provider memakai konstanta yang sama (tidak ada 500/30s tertinggal)
  assert.ok(!/maxOutputTokens:\s*500/.test(serverSrc), 'Gemini masih memakai 500 token');
  assert.ok(!/max_tokens:\s*500/.test(serverSrc), 'OpenRouter masih memakai 500 token');
  assert.ok(!/}, 30000\)/.test(serverSrc), 'masih ada pemanggilan provider dengan timeout 30 detik');
  // OpenRouter diminta memilih penyedia tercepat
  assert.match(serverSrc, /provider:\s*\{\s*sort:\s*'throughput'\s*\}/, 'OpenRouter tidak memakai sort throughput');
});

test('Jalur cepat model: model tersimpan dipakai tanpa memanggil ListModels', async () => {
  const { sandbox, calls } = makeSandbox({ settings: { ai_gemini_model: 'gemini-2.5-flash' } });
  const model = await vm.runInContext('resolveGeminiModel("AIza-dummy")', sandbox);
  assert.equal(model, 'gemini-2.5-flash', 'model tersimpan tidak dipakai');
  assert.equal(calls.list, 0, 'ListModels dipanggil padahal model sudah diketahui (menambah latensi)');
});

test('Hedging: Gemini lambat -> OpenRouter menjawab lebih dulu (bukan menunggu 30 detik)', async () => {
  const { sandbox, calls } = makeSandbox({ geminiDelay: 4000, orDelay: 80, settings: { ai_hedge_delay_ms: 250, ai_gemini_model: 'gemini-2.5-flash' } });
  const t0 = Date.now();
  const r = await vm.runInContext('callAIChat("sys", [{role:"user",content:"hai"}])', sandbox);
  const ms = Date.now() - t0;
  assert.equal(r.provider, 'openrouter', 'provider pemenang salah');
  assert.match(r.reply, /OpenRouter/, 'balasan bukan dari OpenRouter');
  assert.ok(ms < 1500, 'masih menunggu terlalu lama: ' + ms + 'ms');
  assert.equal(r.hedged, true, 'penanda hedged tidak diset');
  assert.equal(calls.openrouter.length, 1, 'OpenRouter tidak dipanggil tepat sekali');
});

test('BUG PRODUKSI: pelari kedua gagal cepat TIDAK boleh membatalkan pelari pertama', async () => {
  // Skenario nyata yang dilaporkan pengguna: kunci OpenRouter bermasalah
  // (401) sementara Gemini lambat menjawab. Sebelum perbaikan, kegagalan
  // OpenRouter langsung menolak seluruh permintaan sehingga pengunjung
  // melihat "Maaf, saya sedang gangguan" padahal Gemini masih berjalan.
  const { sandbox } = makeSandbox({
    geminiDelay: 900,
    orDelay: 30,
    openrouterFails: true,
    settings: { ai_gemini_model: 'gemini-2.5-flash', ai_hedge_delay_ms: 150 }
  });
  const t0 = Date.now();
  const r = await vm.runInContext('callAIChat("sys", [{role:"user",content:"halo"}])', sandbox);
  const ms = Date.now() - t0;
  assert.equal(r.provider, 'gemini', 'permintaan tidak diselesaikan oleh Gemini');
  assert.match(r.reply, /Gemini/, 'balasan bukan dari Gemini');
  assert.ok(ms >= 800, 'terlalu cepat — kemungkinan ditolak sebelum Gemini selesai');
});

test('Hedging: kalau KEDUA provider gagal, barulah dilaporkan gagal', async () => {
  const { sandbox } = makeSandbox({
    geminiDelay: 30, orDelay: 30, geminiFails: true, openrouterFails: true,
    settings: { ai_gemini_model: 'gemini-2.5-flash', ai_hedge_delay_ms: 120 }
  });
  await assert.rejects(
    () => vm.runInContext('callAIChat("sys", [{role:"user",content:"halo"}])', sandbox),
    (e) => /Tidak ada AI provider yang berhasil/.test(e.message),
    'kedua provider gagal seharusnya dilaporkan sebagai kegagalan'
  );
});

test('Hedging tidak memanggil provider kedua bila yang pertama sudah menjawab', async () => {
  const { sandbox, calls } = makeSandbox({ geminiDelay: 60, orDelay: 60, settings: { ai_hedge_delay_ms: 800, ai_gemini_model: 'gemini-2.5-flash' } });
  const r = await vm.runInContext('callAIChat("sys", [{role:"user",content:"hai"}])', sandbox);
  assert.equal(r.provider, 'gemini');
  assert.equal(calls.openrouter.length, 0, 'OpenRouter ikut dipanggil walau Gemini sudah menjawab (kuota terbuang)');
});

test('Provider tunggal tetap bekerja (fallback berurutan)', async () => {
  const { sandbox } = makeSandbox({ settings: { ai_openrouter_api_key: '', ai_gemini_model: 'gemini-2.5-flash' } });
  const r = await vm.runInContext('callAIChat("sys", [{role:"user",content:"hai"}])', sandbox);
  assert.equal(r.provider, 'gemini');
  assert.match(r.reply, /Gemini/);
});

test('Preferensi kecepatan memilih varian lite, dan bisa dimatikan', () => {
  const fast = makeSandbox({ settings: { ai_prefer_fast_model: true } }).sandbox;
  const quality = makeSandbox({ settings: { ai_prefer_fast_model: false } }).sandbox;
  const pick = (sb) => vm.runInContext('pickGeminiModel(["gemini-2.5-flash","gemini-2.5-flash-lite"])', sb);
  assert.equal(pick(fast), 'gemini-2.5-flash-lite', 'mode cepat tidak memilih varian lite');
  assert.equal(pick(quality), 'gemini-2.5-flash', 'mode kualitas tidak memilih versi penuh');
});

test('Pembatalan aman: memakai res.on(close) + penjaga writableEnded (bug krusial)', () => {
  // Membatalkan lewat `req.on('close')` mematikan setiap panggilan AI karena
  // event itu menyala +0 ms (diukur) saat respons belum dikirim.
  assert.ok(!/req\.on\('close',\s*onClose\)/.test(serverSrc), 'masih memakai req.on("close") untuk membatalkan AI');
  assert.match(serverSrc, /res\.on\('close',\s*onClose\)/, 'pembatalan tidak memantau res.on("close")');
  assert.match(serverSrc, /if\s*\(!res\.writableEnded\)\s*\{\s*try\s*\{\s*clientSignal\.abort\(\)/, 'tidak ada penjaga res.writableEnded sebelum abort');
});

test('Galat provider tetap informatif: nama model tidak diredaksi', () => {
  const { sandbox } = makeSandbox();
  const msg = vm.runInContext('sanitizeAIError(new Error("model gemini-flash-lite-latest tidak tersedia, key=AIzaRAHASIA123456"))', sandbox);
  assert.match(msg, /gemini-flash-lite-latest/, 'nama model hilang dari pesan galat');
  assert.ok(!/AIzaRAHASIA/.test(msg), 'kunci API bocor di pesan galat');
});

test('Balasan kosong tidak pernah diteruskan ke pengunjung', () => {
  // Kasus nyata: model membalas hanya berisi tag HTML -> setelah dibersihkan
  // menjadi string kosong. Tanpa penjagaan, pengunjung melihat gelembung chat
  // kosong dan mengira bot rusak.
  assert.match(serverSrc, /const cleanReply = sanitizeAIReply/, 'hubungan balasan bersih tidak dihitung');
  assert.match(serverSrc, /if \(!cleanReply\) \{ errors\.push\(model \+ ': balasan kosong'\); continue; \}/, 'balasan kosong tidak diperlakukan sebagai kegagalan');
  assert.match(serverSrc, /async function callAIChatInner/, 'penjaga terakhir callAIChat tidak ada');
  assert.match(serverSrc, /Provider AI mengembalikan balasan kosong/, 'penjaga balasan kosong hilang');
  // Klien: jangan menampilkan balasan kosong
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.match(indexHtml, /else if \(!data\.reply \|\| !String\(data\.reply\)\.trim\(\)\)/, 'klien tidak menangani balasan kosong');
});

test('Server mengirim info latensi & provider ke klien', () => {
  assert.match(serverSrc, /latency_ms:\s*latencyMs/, 'respons tidak memuat latency_ms');
  assert.match(serverSrc, /hedged:\s*!!result\.hedged/, 'respons tidak memuat penanda hedged');
  assert.match(serverSrc, /\[ai\/chat\].*ms/, 'tidak ada log latensi per jawaban');
});
