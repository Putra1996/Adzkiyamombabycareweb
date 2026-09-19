// Express API deployed at Railway. Frontend lives on GitHub Pages.
// Same-origin requests would skip CORS, but GH Pages + Railway is
// cross-origin so we set ADZKIYA_API_BASE explicitly.
//
// To override (e.g. localhost dev), set window.ADZKIYA_API_BASE BEFORE
// loading this script. To run against a different environment (staging,
// another Railway service, etc.), edit this file and commit.
window.ADZKIYA_API_BASE = window.ADZKIYA_API_BASE || 'https://adzkiyamombabycareweb-production.up.railway.app';
