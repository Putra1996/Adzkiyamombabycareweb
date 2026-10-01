// Preload KHUSUS AUDIT: matikan express-rate-limit supaya fuzzer
// (tools/audit-robustness.js) menguji handler sungguhan, bukan 429.
// Pemakaian: node --require ./tools/audit-no-ratelimit.js server.js
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'express-rate-limit') {
    const passthrough = () => (req, res, next) => next();
    passthrough.rateLimit = passthrough;
    passthrough.default = passthrough;
    return passthrough;
  }
  return origLoad.apply(this, arguments);
};
