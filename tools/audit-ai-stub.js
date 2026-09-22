// Tiruan provider AI untuk audit offline (Gemini selalu berhasil).
const realFetch = global.fetch;
const resp = (st, body) => ({ ok: st < 300, status: st, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) });
global.fetch = async function (url, options) {
  const t = String(url);
  if (t.includes('generativelanguage.googleapis.com')) {
    if (!/:generateContent/.test(t)) return resp(200, { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] });
    // Uji fitur booking: bila pesan pengguna memuat BOOKBLOCK <json>, AI
    // "menyusun" blok booking dari data itu (seperti AI sungguhan).
    let userText = '';
    try {
      const body = JSON.parse((options && options.body) || '{}');
      const lastUser = (body.contents || []).slice().reverse().find((c) => c.role === 'user');
      userText = lastUser ? (lastUser.parts || []).map((pt) => pt.text).join(' ') : '';
    } catch (e) { /* abaikan */ }
    const m = userText.match(/BOOKBLOCK\s+(\{[\s\S]*\})/);
    if (m) {
      let data = null;
      try { data = JSON.parse(m[1]); } catch (e) { data = null; }
      if (data) {
        const reply = 'Baik Bunda 🌸\n\n[[BOOKING]]' + JSON.stringify(data) + '[[/BOOKING]]';
        return resp(200, { candidates: [{ content: { parts: [{ text: reply }] } }] });
      }
    }
    return resp(200, { candidates: [{ content: { parts: [{ text: 'Halo Bunda 🌸 Ada yang bisa saya bantu?' }] } }] });
  }
  if (t.includes('openrouter.ai')) {
    if (t.includes('/models')) return resp(200, { data: [] });
    return resp(402, { error: { message: 'Insufficient credits' } });
  }
  return realFetch(url, options);
};
