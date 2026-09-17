// Public site shared JS
const fmtRp = (n) => 'Rp ' + (n || 0).toLocaleString('id-ID');

// Theme toggle
function initTheme() {
  const saved = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.textContent = saved === 'dark' ? '☀️' : '🌙';
    btn.onclick = () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      btn.textContent = next === 'dark' ? '☀️' : '🌙';
    };
  }
}

// Language toggle — bind to #langToggle if present, otherwise no-op.
function initLang() {
  const btn = document.getElementById('langToggle');
  if (!btn || !window.i18n) return;
  window.i18n.bindToggle(btn);
}

// Load services and render. Each card uses window.t(...) for the order
// button so the label switches when the user toggles ID/EN.
let SERVICES_CATS = null;
async function loadServices() {
  const grid = document.getElementById('serviceGrid');
  const tabs = document.getElementById('catTabs');
  if (!grid) return;
  try {
    const res = await fetch('/api/services');
    SERVICES_CATS = await res.json();
    renderServices('all');
    tabs.querySelectorAll('.cat-tab').forEach(t => {
      t.onclick = () => {
        tabs.querySelectorAll('.cat-tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        renderServices(t.dataset.cat);
      };
    });
  } catch (e) { console.error(e); }
}

// Build the tabs + grid using fresh translations every time the
// language changes (the i18n module fires the `i18n:applied` event).
function renderServices(filter) {
  const cats = SERVICES_CATS || [];
  const grid = document.getElementById('serviceGrid');
  const tabs = document.getElementById('catTabs');
  if (!grid) return;
  // Rebuild tabs only if the active language changed (cheap to always rebuild).
  tabs.innerHTML = '';
  const allBtn = document.createElement('button');
  allBtn.className = 'cat-tab' + (filter === 'all' ? ' active' : '');
  allBtn.textContent = window.t('home.services_tab_all');
  allBtn.dataset.cat = 'all';
  tabs.appendChild(allBtn);
  cats.forEach(c => {
    const b = document.createElement('button');
    b.className = 'cat-tab' + (filter === c.cat ? ' active' : '');
    b.textContent = c.cat;
    b.dataset.cat = c.cat;
    tabs.appendChild(b);
  });
  // Rebind click handlers after rebuild
  tabs.querySelectorAll('.cat-tab').forEach(t => {
    t.onclick = () => {
      tabs.querySelectorAll('.cat-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      renderServices(t.dataset.cat);
    };
  });

  const orderLabel = window.t('home.services_pilih');
  const perSession = '/ ' + (window.getLang && window.getLang() === 'en' ? 'session' : 'sesi');
  grid.innerHTML = '';
  cats.forEach(c => {
    if (filter !== 'all' && c.cat !== filter) return;
    c.items.forEach(it => {
      const card = document.createElement('div');
      card.className = 'service-card';
      card.innerHTML = `
        <div class="scat">${c.cat}</div>
        <h4>${it.name}</h4>
        <div class="price">${fmtRp(it.price)} <small>${perSession}</small></div>
        <button class="order-btn" onclick="goReserve('${it.name.replace(/'/g, "\\'")}', ${it.price})">${orderLabel} →</button>
      `;
      grid.appendChild(card);
    });
  });
}

function goReserve(name, price) {
  const url = new URL('/reservasi.html', location.origin);
  url.searchParams.set('service', name);
  url.searchParams.set('price', price);
  // Preserve the user's language preference across navigation.
  if (window.getLang) url.searchParams.set('lang', window.getLang());
  location.href = url.toString();
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initLang();
  loadServices();
});
// Re-render service cards with new language when i18n fires.
document.addEventListener('i18n:applied', () => {
  const active = document.querySelector('.cat-tab.active');
  renderServices(active ? active.dataset.cat : 'all');
});
