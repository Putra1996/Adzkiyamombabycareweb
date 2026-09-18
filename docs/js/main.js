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

// Load services and render
async function loadServices() {
  const grid = document.getElementById('serviceGrid');
  const tabs = document.getElementById('catTabs');
  if (!grid) return;
  try {
    const res = await fetch('/api/services');
    const cats = await res.json();
    // tabs
    const allBtn = document.createElement('button');
    allBtn.className = 'cat-tab active';
    allBtn.textContent = 'Semua';
    allBtn.dataset.cat = 'all';
    tabs.appendChild(allBtn);
    cats.forEach(c => {
      const b = document.createElement('button');
      b.className = 'cat-tab';
      b.textContent = c.cat;
      b.dataset.cat = c.cat;
      tabs.appendChild(b);
    });
    const renderGrid = (filter) => {
      grid.innerHTML = '';
      cats.forEach(c => {
        if (filter !== 'all' && c.cat !== filter) return;
        c.items.forEach(it => {
          const card = document.createElement('div');
          card.className = 'service-card';
          card.innerHTML = `
            <div class="scat">${c.cat}</div>
            <h4>${it.name}</h4>
            <div class="price">${fmtRp(it.price)} <small>/ sesi</small></div>
            <button class="order-btn" onclick="goReserve('${it.name.replace(/'/g, "\\'")}', ${it.price})">Pesan Sekarang →</button>
          `;
          grid.appendChild(card);
        });
      });
    };
    renderGrid('all');
    tabs.querySelectorAll('.cat-tab').forEach(t => {
      t.onclick = () => {
        tabs.querySelectorAll('.cat-tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        renderGrid(t.dataset.cat);
      };
    });
  } catch (e) { console.error(e); }
}

function goReserve(name, price) {
  const url = new URL('/reservasi.html', location.origin);
  url.searchParams.set('service', name);
  url.searchParams.set('price', price);
  location.href = url.toString();
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadServices();
});
