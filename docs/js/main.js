// Public site shared JS — Static version for GitHub Pages
const fmtRp = (n) => 'Rp ' + (n || 0).toLocaleString('id-ID');

// Embedded services data (from server.js SERVICES)
const SERVICES_DATA = [
  { cat: 'Basic Treatment Ibu', items: [
    { name: 'Massage Ibu Hamil', price: 80000 },
    { name: 'Massage Ibu Nifas', price: 80000 },
    { name: 'Massage Laktasi', price: 80000 },
    { name: 'Massage Induksi', price: 80000 },
  ]},
  { cat: 'Paket Spa Ibu Hamil', items: [
    { name: 'Serenity Bump Package', price: 115000 },
    { name: 'Blooming Mama Package', price: 125000 },
    { name: 'Adzkiya Glow Package', price: 135000 },
  ]},
  { cat: 'Basic Spa Untuk Ibu', items: [
    { name: 'Harmony Spa', price: 105000 },
    { name: 'Blooming Spa', price: 115000 },
  ]},
  { cat: 'Perawatan Ibu & Newborn', items: [
    { name: 'Mom & Newborn Care 5 Days', price: 550000 },
    { name: 'Mom & Newborn Care 7 Days', price: 750000 },
    { name: 'Mom & Newborn Care 14 Days', price: 1400000 },
    { name: 'Perawatan Luka Perineum', price: 100000 },
    { name: 'Perawatan Luka Post SC', price: 120000 },
  ]},
  { cat: 'Massage Laktasi (Paket)', items: [
    { name: "Mom's Relief Package (3x)", price: 230000 },
    { name: 'Gentle Flow Package (5x)', price: 350000 },
    { name: 'Lacta Bloom Package (7x)', price: 450000 },
  ]},
  { cat: 'Baby Treatment (0–12 Bulan)', items: [
    { name: 'Sleepwell Massage', price: 50000 },
    { name: 'Pijat Bapil', price: 60000 },
    { name: 'Pijat Diare', price: 60000 },
    { name: 'Pijat Sembelit / Konstipasi', price: 60000 },
    { name: 'Pijat Tuina', price: 60000 },
    { name: 'Stimulasi Berjalan', price: 60000 },
    { name: 'Therapy Bapil', price: 80000 },
    { name: 'Baby Gym', price: 70000 },
    { name: 'Baby Haircut / Cukur Gundul', price: 25000 },
  ]},
  { cat: 'Newborn Care', items: [
    { name: 'Newborn Care 3 Days', price: 255000 },
    { name: 'Newborn Care 5 Days', price: 425000 },
    { name: 'Newborn Care 7 Days', price: 595000 },
  ]},
  { cat: 'Toddler Treatment (1–3 Tahun)', items: [
    { name: 'Toddler - Sleepwell Massage', price: 65000 },
    { name: 'Toddler - Pijat Bapil', price: 70000 },
    { name: 'Toddler - Pijat Diare', price: 70000 },
    { name: 'Toddler - Pijat Sembelit', price: 70000 },
    { name: 'Toddler - Pijat Tuina', price: 70000 },
    { name: 'Toddler - Therapy Bapil', price: 85000 },
  ]},
  { cat: 'Kids Treatment (4–5 Tahun)', items: [
    { name: 'Kids - Sleepwell Massage', price: 65000 },
    { name: 'Kids - Pijat Bapil', price: 70000 },
    { name: 'Kids - Pijat Diare', price: 70000 },
    { name: 'Kids - Pijat Sembelit', price: 70000 },
    { name: 'Kids - Therapy Bapil', price: 85000 },
  ]},
];

// Embedded settings data (from data.json)
const SETTINGS_DATA = {
  "business_name": "Adzkiya Mom Baby Care",
  "tagline": "Layanan Kesehatan Ibu & Anak Terpercaya",
  "address": "Dusun Klumprit Kulon No. 217, RT 1 RW 1 Klumprit, Nusawungu, Cilacap 53283",
  "phone": "085887018194",
  "area": "Nusawungu, Cilacap",
  "type": "Home Service",
  "practitioner": "Tasya Hanifah Pramesti, A.Md. Keb., CBME",
  "instagram": "",
  "has_logo": true,
  "has_hero": false,
  "has_qris": false,
  "qris_link": "",
  "bank_accounts": [
    {
      "bank": "BSI",
      "number": "7000000000",
      "name": "Tasya Hanifah Pramesti"
    }
  ],
  "primary_color": "#ee5a8a",
  "accent_color": "#ffb979",
  "gmaps_url": "https://maps.app.goo.gl/V5RcUDQbep3T5ryp7",
  "gmaps_embed": "",
  "hours": [
    {
      "day": "Senin",
      "open": "08:00",
      "close": "20:00",
      "closed": false
    },
    {
      "day": "Selasa",
      "open": "08:00",
      "close": "20:00",
      "closed": false
    },
    {
      "day": "Rabu",
      "open": "08:00",
      "close": "20:00",
      "closed": false
    },
    {
      "day": "Kamis",
      "open": "08:00",
      "close": "20:00",
      "closed": false
    },
    {
      "day": "Jumat",
      "open": "08:00",
      "close": "20:00",
      "closed": false
    },
    {
      "day": "Sabtu",
      "open": "08:00",
      "close": "20:00",
      "closed": false
    },
    {
      "day": "Minggu",
      "open": "09:00",
      "close": "17:00",
      "closed": false
    }
  ],
  "testimonials": [
    {
      "name": "Bunda Rina",
      "rating": 5,
      "text": "Pelayanan sangat ramah, bidan Tasya profesional sekali. Pijat ibu hamil di rumah bikin rileks total. Recommended banget!",
      "source": "Google Maps"
    },
    {
      "name": "Bunda Dewi",
      "rating": 5,
      "text": "Pijat laktasi sangat membantu, ASI jadi lancar lagi. Datang tepat waktu dan sangat sabar. Terima kasih Adzkiya!",
      "source": "Google Maps"
    },
    {
      "name": "Bunda Sari",
      "rating": 5,
      "text": "Baby massage anak saya jadi tidur lebih nyenyak. Bidannya sabar dan telaten. Pasti repeat order lagi!",
      "source": "Google Maps"
    },
    {
      "name": "Bunda Putri",
      "rating": 5,
      "text": "Newborn care nya sangat membantu di masa nifas. Bidan datang ke rumah, jadi tidak perlu repot keluar. Worth it!",
      "source": "Google Maps"
    },
    {
      "name": "Bunda Lina",
      "rating": 5,
      "text": "Mom spa nya bikin badan segar setelah melahirkan. Tempat tidak perlu jauh-jauh, semua di rumah. Recommended!",
      "source": "Google Maps"
    }
  ],
  "socials": []
};

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

// Load services and render (static version)
function loadServices() {
  const grid = document.getElementById('serviceGrid');
  const tabs = document.getElementById('catTabs');
  if (!grid) return;
  const cats = SERVICES_DATA;
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
}

function goReserve(name, price) {
  // For GitHub Pages, use relative URL
  const url = 'reservasi.html';
  const params = new URLSearchParams();
  params.set('service', name);
  params.set('price', price);
  location.href = url + '?' + params.toString();
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadServices();
});
