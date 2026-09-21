// Tes regresi pemilihan model AI.
//
// BUG yang dikunci di sini: nama model di-hardcode (`gemini-1.5-flash`,
// `google/gemini-flash-1.5`). Google menghentikan gemini-1.5-flash, jadi
// setiap permintaan dijawab 404 dan bot SELALU membalas
// "Maaf, saya sedang gangguan 😅. Silakan chat langsung via WhatsApp ya: …".
//
// Perbaikan yang diuji:
//   • kandidat model berupa daftar (bukan satu nama),
//   • deteksi model yang benar-benar tersedia lewat ListModels,
//   • model yang dihentikan (404 / "no longer available") dilewati otomatis,
//   • model yang berhasil diingat supaya permintaan berikutnya langsung tepat,
//   • OpenRouter juga mencoba kandidat berikutnya.
//
// Kode yang diuji diambil APA ADANYA dari server.js lalu dijalankan di
// sandbox dengan fetch tiruan, sehingga tes ini menguji implementasi asli.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function block(startMarker) {
  const i = serverSrc.indexOf(startMarker);
  assert.ok(i > 0, `blok "${startMarker}" tidak ditemukan di server.js`);
  const end = serverSrc.indexOf('\n}\n', i);
  assert.ok(end > i, `penutup blok "${startMarker}" tidak ditemukan`);
  return serverSrc.slice(i, end + 3);
}

// Sandbox berisi potongan server.js + tiruan Google/OpenRouter API.
function makeSandbox(options) {
  const opts = options || {};
  const retiredModels = opts.retiredModels || ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];
  const availableModels = opts.availableModels || ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest', 'gemini-3.6-flash', 'gemini-2.5-flash', 'text-embedding-004'];
  const openrouterWorking = opts.openrouterWorking || 'google/gemini-2.5-flash-lite';
  const calls = { list: 0, gemini: [], openrouter: [] };

  const fakeResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
  });

  // Catatan: HARUS function biasa, karena arrow function tidak punya `arguments`
  // (menyebabkan body request tidak terbaca dan tiruan selalu 404).
  const fetchMock = async function (url, options) {
    const target = String(url);
    if (target.includes('generativelanguage.googleapis.com')) {
      if (target.includes('/models?') || target.endsWith('/models')) {
        calls.list++;
        return fakeResponse(200, {
          models: availableModels.map((name) => ({
            name: 'models/' + name,
            supportedGenerationMethods: name.includes('embedding') ? ['embedContent'] : ['generateContent']
          }))
        });
      }
      const m = target.match(/\/models\/([^:]+):generateContent/);
      const model = m ? decodeURIComponent(m[1]) : 'unknown';
      calls.gemini.push(model);
      // API asli membalas 404 untuk model yang tidak dikenal/dihentikan.
      if (retiredModels.includes(model) || !availableModels.includes(model)) {
        return fakeResponse(404, { error: { code: 404, message: 'This model models/' + model + ' is no longer available. Please update your code.', status: 'NOT_FOUND' } });
      }
      return fakeResponse(200, { candidates: [{ content: { parts: [{ text: 'Halo Bunda 🌸 (uji ' + model + ')' }] } }] });
    }
    if (target.includes('openrouter.ai')) {
      const body = JSON.parse((options && options.body) ? options.body : '{}');
      calls.openrouter.push(body.model);
      if (body.model !== openrouterWorking) {
        return fakeResponse(404, { error: { message: 'No endpoints found for the requested model' } });
      }
      return fakeResponse(200, { choices: [{ message: { content: 'Halo Bunda 🌸 (uji openrouter ' + body.model + ')' } }] });
    }
    return fakeResponse(404, {});
  };

  const sandbox = {
    console,
    fetch: fetchMock,
    setTimeout, clearTimeout, AbortController, URL, encodeURIComponent,
    DB: { settings: Object.assign({ ai_gemini_api_key: 'AIza-dummy', ai_openrouter_api_key: 'sk-or-dummy' }, opts.settings || {}) },
    save: () => {},
    process: { env: {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(block('async function fetchWithTimeout'), sandbox);
  vm.runInContext('function sanitizeDbError(e){ return String((e && e.message) || e); }', sandbox);
  vm.runInContext(block('function sanitizeAIReply'), sandbox);
  vm.runInContext(serverSrc.slice(serverSrc.indexOf('const GEMINI_MODEL_CANDIDATES'), serverSrc.indexOf('// Tanya ke Google model apa saja')), sandbox);
  vm.runInContext(block('async function listGeminiModels'), sandbox);
  vm.runInContext(block('async function resolveGeminiModel'), sandbox);
  vm.runInContext(block('function geminiCandidates'), sandbox);
  vm.runInContext(block('function isModelUnavailable'), sandbox);
  vm.runInContext(block('async function callGemini'), sandbox);
  vm.runInContext(serverSrc.slice(serverSrc.indexOf('const OPENROUTER_MODEL_CANDIDATES'), serverSrc.indexOf('async function callOpenRouter')), sandbox);
  vm.runInContext(block('async function callOpenRouter'), sandbox);
  return { sandbox, calls };
}

test('Kandidat model: tidak lagi bergantung pada satu nama model yang bisa dihentikan', () => {
  // Daftar kandidat harus ada, dan berisi lebih dari satu nama.
  assert.match(serverSrc, /const GEMINI_MODEL_CANDIDATES = \[/, 'daftar kandidat Gemini hilang');
  assert.match(serverSrc, /const OPENROUTER_MODEL_CANDIDATES = \[/, 'daftar kandidat OpenRouter hilang');
  // Nama model tidak boleh lagi dipakai sebagai satu-satunya pilihan pada URL.
  assert.ok(
    !/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-[0-9.]+-flash:generateContent/.test(serverSrc),
    'URL Gemini masih menempelkan nama model hardcode'
  );
  assert.ok(!/model: 'google\/gemini-flash-1\.5',/.test(serverSrc), 'OpenRouter masih memakai satu nama model hardcode');
});

test('ListModels: hanya model yang mendukung generateContent & bukan model gambar/embedding', async () => {
  const { sandbox, calls } = makeSandbox();
  const models = await vm.runInContext('listGeminiModels("AIza-dummy")', sandbox);
  assert.equal(calls.list, 1, 'ListModels tidak dipanggil');
  assert.ok(models.includes('gemini-3.6-flash'), 'model aktif tidak ikut terdeteksi');
  assert.ok(!models.includes('text-embedding-004'), 'model embedding ikut dianggap model chat');
});

test('Pemilihan model: versi terbaru menang, model embedding tidak pernah dipilih', () => {
  const { sandbox } = makeSandbox();
  const pick = (list) => vm.runInContext('pickGeminiModel(' + JSON.stringify(list) + ')', sandbox);
  assert.equal(pick(['gemini-1.5-flash', 'gemini-3.6-flash']), 'gemini-3.6-flash', 'model lawas masih menang');
  assert.equal(pick(['gemini-1.5-flash', 'gemini-2.5-flash']), 'gemini-2.5-flash');
  assert.equal(pick(['gemini-2.5-flash', 'gemini-2.5-flash-lite']), 'gemini-2.5-flash', 'varian lite seharusnya di bawah versi penuh');
  assert.equal(pick(['text-embedding-004']), null, 'model non-teks dipilih sebagai model chat');
});

test('Urutan percobaan: model hasil deteksi didahulukan sebelum daftar statis', async () => {
  const { sandbox } = makeSandbox();
  const resolved = await vm.runInContext('resolveGeminiModel("AIza-dummy", true)', sandbox);
  const order = vm.runInContext('geminiCandidates(' + JSON.stringify(resolved) + ').slice(0, 6)', sandbox);
  const idx36 = order.indexOf('gemini-3.6-flash');
  const idx15 = order.indexOf('gemini-1.5-flash');
  assert.ok(idx36 >= 0, 'model aktif hasil deteksi tidak ada di urutan percobaan');
  assert.ok(idx15 === -1 || idx36 < idx15, 'model lawas dicoba sebelum model yang masih tersedia');
  assert.ok(order.indexOf('gemini-3.6-flash') < order.indexOf('gemini-flash-lite-latest') ||
    order.indexOf('gemini-flash-lite-latest') === -1, 'daftar statis mendahului hasil deteksi');
});

test('callGemini: melewati model yang dihentikan (404) dan memakai yang tersedia', async () => {
  const { sandbox, calls } = makeSandbox();
  const r = await vm.runInContext('callGemini("sys", [{role:"user",content:"ping"}])', sandbox);
  assert.equal(r.model, 'gemini-3.6-flash', 'model akhir yang dipakai salah');
  assert.match(r.reply, /Halo Bunda/, 'balasan tidak diteruskan');
  assert.ok(!/sedang gangguan/.test(r.reply), 'bot masih membalas pesan gangguan');
  assert.ok(calls.gemini.includes('gemini-flash-latest'), 'model pertama (alias) tidak dicoba');
  assert.ok(calls.gemini.length <= 3, 'terlalu banyak percobaan model: ' + JSON.stringify(calls.gemini));
  // model yang berhasil disimpan supaya permintaan berikutnya langsung tepat
  assert.equal(sandbox.DB.settings.ai_gemini_model, 'gemini-3.6-flash', 'model yang berhasil tidak disimpan');
});

test('callGemini: kunci salah/limit tetap dilaporkan sebagai galat jelas', async () => {
  const { sandbox } = makeSandbox({ retiredModels: ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest', 'gemini-3.6-flash', 'gemini-2.5-flash'], availableModels: ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest', 'gemini-3.6-flash', 'gemini-2.5-flash'] });
  await assert.rejects(
    () => vm.runInContext('callGemini("sys", [{role:"user",content:"ping"}])', sandbox),
    (e) => /Semua model Gemini gagal/.test(e.message) && /no longer available/.test(e.message),
    'galat provider tidak dilaporkan apa adanya'
  );
});

test('callOpenRouter: mencoba kandidat berikutnya bila provider menolak model', async () => {
  const { sandbox, calls } = makeSandbox({ openrouterWorking: 'google/gemini-2.5-flash-lite' });
  const r = await vm.runInContext('callOpenRouter("sys", [{role:"user",content:"ping"}])', sandbox);
  assert.equal(r.model, 'google/gemini-2.5-flash-lite');
  assert.match(r.reply, /openrouter/, 'balasan OpenRouter tidak diteruskan');
  assert.ok(calls.openrouter.length >= 2, 'tidak ada percobaan kandidat kedua: ' + JSON.stringify(calls.openrouter));
});

test('Server: pesan galat AI menyertakan detail teknis untuk diagnosa admin', () => {
  assert.match(serverSrc, /detail,/, 'respons galat tidak menyertakan detail teknis');
  assert.match(serverSrc, /app\.post\('\/api\/admin\/ai\/test'/, 'endpoint uji AI (panel admin) hilang');
  const adminJs = fs.readFileSync(path.join(ROOT, 'public/js/admin.js'), 'utf8');
  assert.match(adminJs, /aiAssistantAiTestBtn/, 'tombol "Tes AI" hilang dari panel');
});
