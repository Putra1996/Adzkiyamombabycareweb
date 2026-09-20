// ===== i18n.js — Multi-bahasa ID/EN =====
// Lightweight i18n for the public site (homepage, kalender, reservasi,
// kwitansi-share). Usage:
//
//   <script src="/js/i18n.js" defer></script>
//   <script>...</script>         // can call window.t('home.services_title')
//
// Language is auto-detected in this order (first match wins):
//   1. URL  ?lang=en|id          (ad-hoc override, lets you share a link)
//   2. localStorage adz_lang     (user's saved preference)
//   3. navigator.language        (browser preferred UI language)
//   4. geo timezone guess        (WIB → id, others → en, fallback id)
//   5. 'id'                      (final fallback — homepage audience is Indonesian)
//
// Why default-id: Adzkiya's homepage target audience is Indonesian
// mothers in Cilacap. If we defaulted to 'en' based on browser language,
// any visitor using a default English browser would land on a half-
// translated page (lots of brand-specific terms are untranslated). So
// we bias toward Indonesian: even an English-speaking user gets id
// first, and the 🌐 toggle is one click away to switch.
//
// To force the toggle to remember English, the user clicks 🌐 EN
// once and we persist `adz_lang=en` to localStorage.
//
// On load, the module:
//   • Sets <html lang=".."> so screen readers + Google see the right language
//   • Walks the document and replaces any element marked with
//       data-i18n="home.hero_cta"
//     whose textContent becomes I18N[lang][key]. Falls back to id
//     when a key is missing in the chosen language.
//   • Walks elements with data-i18n-attr="key" for ATTRIBUTE translations
//     (e.g. <input data-i18n-attr-placeholder="form.email_placeholder">)
//   • Walks elements with data-i18n-html="key" for innerHTML (rare, for
//     strings with <strong>/<br>).
//
// window.t(key, fallback) also works programmatically (returns the string).
// window.setLang('en'|'id') updates the language, persists, and re-applies.

(function () {
  'use strict';

  // ---- Translation tables ---------------------------------------------------
  // Group namespaces by area so editors don't lose track. Add new keys to the
  // end of the relevant group to keep diffs reviewable. Anything missing in
  // the EN table falls back to the ID value at lookup time (so partial
  // translations never crash the UI).
  const I18N = {
    id: {
      // Top-bar
      nav: {
        beranda: 'Beranda',
        layanan: 'Layanan',
        tentang: 'Tentang',
        testimoni: 'Testimoni',
        kalender: 'Kalender',
        kontak: 'Kontak',
        reservasi: 'Reservasi',
        admin: 'Admin Login',
        language_toggle: 'Ganti bahasa',
      },
      // Homepage — hero
      home: {
        eyebrow: '✨ Home Service Nusawungu — Cilacap',
        hero_h1_pre: 'Sentuhan Lembut untuk',
        hero_h1_post: 'Bunda & Si Kecil',
        hero_h1_full: 'Sentuhan Lembut untuk <span>Bunda &amp; Si Kecil</span>',
        hero_lead: 'Spa, massage, dan perawatan profesional khusus ibu hamil, nifas, bayi, balita & kids. Dipandu bidan tersertifikasi langsung ke rumah Anda.',
        hero_cta: '📅 Reservasi Sekarang',
        hero_wa: '💬 Chat WhatsApp',
        hero_stat1_label: 'Jenis Layanan',
        hero_stat2_label: 'Home Service',
        hero_stat3_label: 'Bidan Bersertifikat',
        fc1_title: 'Mom Spa',
        fc1_sub: 'Mulai 80rb',
        fc2_title: 'Baby Treatment',
        fc2_sub: 'Mulai 25rb',
        // Why-us
        whyus_eyebrow: 'Mengapa Memilih Kami',
        whyus_h2: 'Perawatan yang Bisa Dipercaya',
        whyus_p: 'Dirancang dengan kelembutan, dijalankan dengan keahlian. Setiap sesi disesuaikan dengan kebutuhan ibu dan buah hati.',
        feat_home_h: 'Home Service',
        feat_home_p: 'Bidan datang langsung ke rumah, Bunda cukup rebahan dan menikmati perawatan.',
        feat_cert_h: 'Bidan Bersertifikat',
        feat_cert_p: 'Ditangani A.Md. Keb., CBME (Certified Baby Massage Educator) yang berpengalaman.',
        feat_alami_h: 'Bahan Alami',
        feat_alami_p: 'Menggunakan minyak & produk aman bagi ibu hamil, ibu menyusui, dan bayi.',
        feat_flex_h: 'Fleksibel',
        feat_flex_p: 'Jadwal bisa disesuaikan dengan kenyamanan Bunda, termasuk akhir pekan.',
        // Services section
        services_eyebrow: 'Daftar Layanan',
        services_h2: 'Pilih Perawatan Favoritmu',
        services_p: 'Mulai dari pijat ibu hamil sampai newborn care, semuanya tersedia di sini.',
        services_tab_all: 'Semua',
        services_pilih: 'Pilih',
        cat: {
          basic_ibu: 'Basic Treatment Ibu',
          paket_spa_hamil: 'Paket Spa Ibu Hamil',
          basic_spa_ibu: 'Basic Spa Untuk Ibu',
          perawatan_ibu_newborn: 'Perawatan Ibu & Newborn',
          massage_laktasi_paket: 'Massage Laktasi (Paket)',
          baby_treatment: 'Baby Treatment (0–12 Bulan)',
          newborn_care: 'Newborn Care',
          toddler_treatment: 'Toddler Treatment (1–3 Tahun)',
          kids_treatment: 'Kids Treatment (4–5 Tahun)',
        },
        // About
        about_eyebrow: 'Tentang Adzkiya',
        about_h2: 'Mom & Baby Care Profesional di Nusawungu',
        about_p1: 'Adzkiya Mom Baby Care hadir untuk menemani perjalanan Bunda — sejak kehamilan, masa nifas, menyusui, hingga tumbuh kembang si kecil. Kami percaya setiap ibu berhak mendapat perawatan yang lembut, aman, dan profesional di lingkungan rumahnya sendiri.',
        about_p2: 'Dengan layanan home service, kami siap melayani area Nusawungu, Cilacap dan sekitarnya.',
        bidan_role: 'A.Md. Keb., CBME — Bidan Praktisi',
        // Testimoni
        testi_eyebrow: 'Apa Kata Bunda',
        testi_h2: 'Testimoni Pelanggan',
        testi_p: 'Cerita nyata dari ibu-ibu yang sudah mempercayakan perawatan kepada kami.',
        testi_loading: 'Memuat testimoni...',
        testi_empty: 'Belum ada testimoni.',
        testi_btn: '⭐ Lihat Semua Ulasan di Google Maps',
        // Contact
        contact_eyebrow: 'Hubungi Kami',
        contact_h2: 'Siap Melayani Bunda',
        contact_p: 'Hubungi kami untuk konsultasi gratis atau langsung lakukan reservasi.',
        contact_addr: 'Alamat',
        contact_wa: 'WhatsApp',
        contact_area: 'Wilayah Layanan',
        contact_type: 'Jenis Layanan',
        contact_type_val: 'Home Service (Bidan ke rumah)',
        contact_hours: 'Jam Operasional',
        contact_hours_loading: 'Memuat...',
        contact_today: ' (Hari ini)',
        contact_closed: 'Tutup',
        contact_social: 'Media Sosial',
        contact_gmaps: 'Lokasi di Google Maps',
        contact_gmaps_btn: '🗺️ Buka di Google Maps →',
        // Footer
        footer_brand_suffix: '· Layanan Kesehatan Ibu & Anak Terpercaya',
      },
      ai: {
        greeting: 'Halo! 🌸 Saya Adzkiya Assistant. Ada yang bisa saya bantu untuk booking layanan kami?',
        quick_replies: '💆 Lihat layanan|💰 Cek harga|📅 Booking sekarang|📍 Lokasi',
        status: 'online · balas dalam detik',
        placeholder: 'Ketik pesan… (Enter kirim)',
        footer_note: 'Powered by AI · untuk booking final via WhatsApp admin',
        offline_msg: 'Tidak bisa terhubung. Silakan coba lagi atau chat WhatsApp:',
        wa_fallback_msg: 'Maaf, saya sedang gangguan 😅. Silakan chat langsung via WhatsApp ya:',
        offline_quick: 'Konfirmasi via WhatsApp|Lihat layanan lagi',
        cheapest_quick: 'Layanan termurah|Paket bundle',
      },
      // Kalender publik
      kalender: {
        h_title: '📅 Kalender Reservasi',
        h_sub: 'Cek jadwal yang sudah dikonfirmasi sebelum melakukan reservasi.',
        today: 'Hari ini',
        sesi: ' sesi',
        sesi_1: ' sesi',
        penuh: ' (Penuh)',
        libur: 'Hari Libur',
        detail_title: '📅 ',
        detail_kosong_p: 'Tidak ada treatment terjadwal di tanggal ini — semua jam masih tersedia. Silakan reservasi kapan saja.',
        detail_penuh_p: '🛑 Hari ini sudah penuh',
        detail_penuh_p2: ' sesi. Silakan pilih tanggal lain yang jadwalnya lebih longgar.',
        detail_sisa_p1: '✅ Tersisa ',
        detail_sisa_p2: ' slot lagi untuk hari ini — masih bisa reservasi.',
        detail_cta: '📅 Buat Reservasi',
        detail_cta_today: '📅 Buat Reservasi di Tanggal Ini',
        detail_privasi_p: '🔒 Privasi: Nama pasien & WhatsApp tidak ditampilkan. Hanya jadwal layanan untuk transparansi ketersediaan.',
        detail_riwayat: 'Jadwal historis di tanggal ini:',
        detail_libur_p1: '🚫 Hari Libur — kami tidak menerima reservasi di tanggal ini.',
        detail_libur_other: '📅 Lihat Tanggal Lain',
      },
      // Reservasi form
      form: {
        title: 'Reservasi Layanan',
        subtitle: 'Pilih layanan & jadwal, tim kami akan konfirmasi via WhatsApp dalam 1×24 jam.',
        patient_name_label: 'Nama Bunda',
        patient_name_ph: 'Nama lengkap Bunda',
        whatsapp_label: 'Nomor WhatsApp',
        whatsapp_ph: '08xxxxxxxxxx',
        address_label: 'Alamat Lengkap (untuk kunjungan home service)',
        address_ph: 'Jalan, RT/RW, Dusun, Desa/Kelurahan, Kecamatan, Kabupaten',
        items_label: 'Layanan',
        items_pilih_layanan: '— pilih layanan —',
        items_add: '+ Tambah Layanan',
        items_remove: 'Hapus layanan',
        qty: 'Jumlah',
        slots_label: 'Jadwal',
        slots_sub: '— tambah berapapun tanggal & jam yang dibutuhkan',
        slots_add: '+ Tambah Waktu',
        slots_remove: 'Hapus jadwal',
        summary_subtotal: 'Subtotal',
        summary_transport: 'Transportasi',
        summary_diskon: 'Diskon',
        summary_total: 'TOTAL',
        summary_total_with_value: 'TOTAL: ',
        payment_method: 'Metode Pembayaran',
        payment_cod: 'COD (Bayar di tempat)',
        payment_cod_desc: 'Bayar tunai saat bidan tiba di rumah.',
        payment_transfer: 'Transfer Bank',
        payment_transfer_desc: 'Transfer ke rekening yang tersedia di bawah.',
        payment_qris: 'QRIS',
        payment_qris_desc: 'Bayar pakai e-wallet / mobile banking via QR Code.',
        payment_required: 'Pilih metode pembayaran',
        notes_label: 'Catatan (opsional)',
        notes_ph: 'Pesan khusus untuk bidan, mis: alamat patokan, kondisi tertentu, dll.',
        submit: '📨 Kirim Reservasi',
        sending: 'Mengirim...',
        error_items: 'Pilih minimal 1 layanan',
        error_slots: 'Tambah minimal 1 jadwal',
        error_blackout: '🚫 Tanggal {date} adalah hari libur. Silakan pilih tanggal lain untuk sesi ini.',
        success_top: '✅ Reservasi #{id} berhasil dikirim (total: {total})! Admin akan menghubungi Anda via WhatsApp.',
        success_wa: '📲 Klik di sini untuk lanjut chat WhatsApp ke admin →',
        alert_offline: 'Koneksi server sedang lambat. Data harga cadangan ditampilkan; coba kirim kembali beberapa saat lagi.',
      },
      // Kwitansi share (public read-only)
      share: {
        page_title: 'Kwitansi — Adzkiya Mom Baby Care',
        h2: 'Kwitansi Anda',
        h2_loading: '📄 Memuat kwitansi...',
        subtitle_loading: 'Mohon tunggu sebentar.',
        icon_loading: '⏳',
        text_loading: 'Memvalidasi link...',
        icon_error: '⚠️',
        error_invalid: 'Link tidak valid atau sudah kadaluarsa',
        error_invalid_detail: 'Link mungkin sudah kadaluarsa (>30 hari) atau tidak valid. Hubungi admin untuk minta link baru.',
        error_empty: 'Link kwitansi tidak lengkap.',
        error_empty_detail: 'Pastikan Anda membuka link lengkap yang diberikan admin.',
        error_legacy: 'Format link ini lama. Hubungi admin untuk minta link baru (format terbaru).',
        btn_print: '🖨️ Cetak / Save PDF',
        btn_wa: '💬 Share WhatsApp',
        btn_copy: '🔗 Copy Link',
        copy_ok: '✅ Link kwitansi disalin ke clipboard!',
        privacy: '🔒 Privasi: Link ini menggunakan token unik yang hanya diketahui oleh Anda & admin Adzkiya. Jangan sebarkan ke orang lain.',
        print_hint: '⏳ Tunggu data dimuat untuk tombol Cetak & WA...',
      },
      // Common
      common: {
        home: '← Beranda',
        copyright: '© 2026 {brand}',
      },
    },

    en: {
      nav: {
        beranda: 'Home',
        layanan: 'Services',
        tentang: 'About',
        testimoni: 'Reviews',
        kalender: 'Calendar',
        kontak: 'Contact',
        reservasi: 'Book Now',
        admin: 'Admin Login',
        language_toggle: 'Switch language',
      },
      home: {
        eyebrow: '✨ Home Service in Nusawungu — Cilacap',
        hero_h1_pre: 'Gentle care for',
        hero_h1_post: 'Moms & Little Ones',
        hero_h1_full: 'Gentle care for <span>Moms &amp; Little Ones</span>',
        hero_lead: 'Professional spa, massage & treatments for expecting mothers, new moms, babies, toddlers & kids. Delivered by a certified midwife right to your home.',
        hero_cta: '📅 Book Now',
        hero_wa: '💬 Chat on WhatsApp',
        hero_stat1_label: 'Services',
        hero_stat2_label: 'Home Service',
        hero_stat3_label: 'Certified Midwife',
        fc1_title: 'Mom Spa',
        fc1_sub: 'From 80k',
        fc2_title: 'Baby Treatment',
        fc2_sub: 'From 25k',
        whyus_eyebrow: 'Why Choose Us',
        whyus_h2: 'Care You Can Trust',
        whyus_p: 'Designed with gentleness, delivered with expertise. Every session is tailored to your needs as a mom and your little one.',
        feat_home_h: 'Home Service',
        feat_home_p: 'Our midwife comes to you — just relax and enjoy the treatment in your own home.',
        feat_cert_h: 'Certified Midwife',
        feat_cert_p: 'Treated by A.Md. Keb., CBME (Certified Baby Massage Educator) with years of hands-on experience.',
        feat_alami_h: 'Natural Products',
        feat_alami_p: 'Only oils & products that are safe for pregnant women, nursing moms, and babies.',
        feat_flex_h: 'Flexible Hours',
        feat_flex_p: 'Schedule around what works for you, including weekends.',
        services_eyebrow: 'Services',
        services_h2: 'Pick Your Favorite Treatment',
        services_p: 'From pregnancy massage to newborn care, everything is available right here.',
        services_tab_all: 'All',
        services_pilih: 'Select',
        cat: {
          basic_ibu: 'Basic Mom Treatments',
          paket_spa_hamil: 'Pregnancy Spa Packages',
          basic_spa_ibu: 'Mom Spa Basics',
          perawatan_ibu_newborn: 'Mom & Newborn Care',
          massage_laktasi_paket: 'Lactation Massage (Packages)',
          baby_treatment: 'Baby Treatments (0–12 Months)',
          newborn_care: 'Newborn Care',
          toddler_treatment: 'Toddler Treatments (1–3 Years)',
          kids_treatment: 'Kids Treatments (4–5 Years)',
        },

        about_eyebrow: 'About Adzkiya',
        about_h2: 'Professional Mom & Baby Care in Nusawungu',
        about_p1: 'Adzkiya Mom Baby Care is here to support you through every stage — pregnancy, postpartum, breastfeeding, and your little one\'s growth. We believe every mom deserves gentle, safe, and professional care in the comfort of her own home.',
        about_p2: 'We provide home-service treatments across Nusawungu, Cilacap and surrounding areas.',
        bidan_role: 'A.Md. Keb., CBME — Practising Midwife',
        testi_eyebrow: 'What Moms Say',
        testi_h2: 'Customer Reviews',
        testi_p: 'Real stories from the moms who trusted us with their care.',
        testi_loading: 'Loading reviews…',
        testi_empty: 'No reviews yet.',
        testi_btn: '⭐ Read All Reviews on Google Maps',
        contact_eyebrow: 'Get in Touch',
        contact_h2: 'Ready to Care for You',
        contact_p: 'Reach out for a free consultation or go straight to booking.',
        contact_addr: 'Address',
        contact_wa: 'WhatsApp',
        contact_area: 'Service Area',
        contact_type: 'Service Type',
        contact_type_val: 'Home Service (midwife visits you)',
        contact_hours: 'Opening Hours',
        contact_hours_loading: 'Loading…',
        contact_today: ' (Today)',
        contact_closed: 'Closed',
        contact_social: 'Social Media',
        contact_gmaps: 'Find Us on Google Maps',
        contact_gmaps_btn: '🗺️ Open in Google Maps →',
        footer_brand_suffix: '· Trusted Mom & Baby Care',
      },
      ai: {
        greeting: 'Hi! 🌸 I\'m Adzkiya Assistant. How can I help you book our services?',
        quick_replies: '💆 View services|💰 Check prices|📅 Book now|📍 Location',
        status: 'online · reply in seconds',
        placeholder: 'Type a message… (Enter)',
        footer_note: 'Powered by AI · finalise bookings via WhatsApp with admin',
        offline_msg: 'Cannot connect. Please try again or chat on WhatsApp:',
        wa_fallback_msg: 'Sorry, I\'m having issues 😅. Please chat directly via WhatsApp:',
        offline_quick: 'Confirm via WhatsApp|View services again',
        cheapest_quick: 'Cheapest services|Bundle packages',
      },
      kalender: {
        h_title: '📅 Booking Calendar',
        h_sub: 'Check confirmed schedules before placing a reservation.',
        today: 'Today',
        sesi: ' sessions',
        sesi_1: ' session',
        penuh: ' (Full)',
        libur: 'Holiday',
        detail_title: '📅 ',
        detail_kosong_p: 'No treatments scheduled on this day — every hour is still available. Book whenever you like.',
        detail_penuh_p: '🛑 Today is fully booked (',
        detail_penuh_p2: ' sessions). Please pick another day with more availability.',
        detail_sisa_p1: '✅ ',
        detail_sisa_p2: ' slots left today — still bookable.',
        detail_cta: '📅 Make a Reservation',
        detail_cta_today: '📅 Book This Day',
        detail_privasi_p: '🔒 Privacy: patient names & WhatsApp numbers are not shown. Schedule is published for transparency only.',
        detail_riwayat: 'Past bookings on this date:',
        detail_libur_p1: '🚫 Holiday — we are not accepting reservations on this day.',
        detail_libur_other: '📅 See other dates',
      },
      form: {
        title: 'Book a Treatment',
        subtitle: 'Pick your service & schedule — we\'ll confirm via WhatsApp within 24 hours.',
        patient_name_label: 'Your Name',
        patient_name_ph: 'Your full name',
        whatsapp_label: 'WhatsApp Number',
        whatsapp_ph: '08xxxxxxxxxx',
        address_label: 'Full Address (for home service)',
        address_ph: 'Street, RT/RW, Hamlet, Village/Subdistrict, District, City',
        items_label: 'Services',
        items_pilih_layanan: '— choose a service —',
        items_add: '+ Add Service',
        items_remove: 'Remove service',
        qty: 'Qty',
        slots_label: 'Schedule',
        slots_sub: '— add as many dates & times as you need',
        slots_add: '+ Add Time',
        slots_remove: 'Remove schedule',
        summary_subtotal: 'Subtotal',
        summary_transport: 'Transport',
        summary_diskon: 'Discount',
        summary_total: 'TOTAL',
        summary_total_with_value: 'TOTAL: ',
        payment_method: 'Payment Method',
        payment_cod: 'COD (Pay on arrival)',
        payment_cod_desc: 'Pay cash when the midwife arrives.',
        payment_transfer: 'Bank Transfer',
        payment_transfer_desc: 'Transfer to one of the bank accounts below.',
        payment_qris: 'QRIS',
        payment_qris_desc: 'Pay with e-wallet / mobile banking via QR Code.',
        payment_required: 'Please choose a payment method',
        notes_label: 'Notes (optional)',
        notes_ph: 'Special instructions: landmark, condition, preferences…',
        submit: '📨 Submit Reservation',
        sending: 'Sending…',
        error_items: 'Please choose at least one service',
        error_slots: 'Please add at least one schedule',
        error_blackout: '🚫 {date} is a holiday. Please pick another date for this session.',
        success_top: '✅ Reservation #{id} submitted (total: {total})! Our admin will contact you on WhatsApp shortly.',
        success_wa: '📲 Click here to continue chatting with the admin on WhatsApp →',
        alert_offline: 'Server is slow to respond. Showing backup pricing data — try submitting again in a moment.',
      },
      share: {
        page_title: 'Receipt — Adzkiya Mom Baby Care',
        h2: 'Your Receipt',
        h2_loading: '📄 Loading receipt…',
        subtitle_loading: 'Please wait a moment.',
        icon_loading: '⏳',
        text_loading: 'Validating link…',
        icon_error: '⚠️',
        error_invalid: 'Invalid or expired link',
        error_invalid_detail: 'This link may have expired (>30 days) or is no longer valid. Contact our admin to get a fresh link.',
        error_empty: 'Incomplete receipt link.',
        error_empty_detail: 'Make sure you opened the full link shared by the admin.',
        error_legacy: 'This link uses an older format. Ask the admin for a new link.',
        btn_print: '🖨️ Print / Save PDF',
        btn_wa: '💬 Share on WhatsApp',
        btn_copy: '🔗 Copy Link',
        copy_ok: '✅ Receipt link copied to clipboard!',
        privacy: '🔒 Privacy: This link uses a unique token known only to you and the admin at Adzkiya. Please do not share it with others.',
        print_hint: '⏳ Waiting for data to load Print & Share buttons...',
      },
      common: {
        home: '← Home',
        copyright: '© 2026 {brand}',
      },
    },
  };

  // ---- State ---------------------------------------------------------------
  function detectInitialLang() {
    // 1. URL ?lang=  (highest priority — explicit user choice)
    try {
      const url = new URLSearchParams(location.search);
      const fromUrl = (url.get('lang') || '').toLowerCase().split('-')[0];
      if (fromUrl === 'en' || fromUrl === 'id') return fromUrl;
    } catch {}
    // 2. localStorage  (user's previously-saved choice)
    try {
      const saved = (localStorage.getItem('adz_lang') || '').toLowerCase().split('-')[0];
      if (saved === 'en' || saved === 'id') return saved;
    } catch {}
    // 3. Browser language. We only honor English for users whose
    // browser actually says English on a US/UK locale — for 'id' or
    // bare language we keep id. This prevents Dutch/German/etc.
    // browser defaults from accidentally forcing en.
    try {
      const nav = (navigator.language || '').toLowerCase();
      // Match 'en' or 'en-XXX' (en-US, en-GB, etc).
      const m = nav.match(/^([a-z]{2})(?:-|$)/);
      if (m && m[1] === 'en') return 'en';
      // Indonesian browser locale (id or id-ID) → id.
      if (m && m[1] === 'id') return 'id';
    } catch {}
    // 4. Timezone heuristic: Indonesia uses WIB (UTC+7) / WITA
    // (UTC+8) / WIT (UTC+9) — if visitor's timezone offset matches
    // one of those, lean Indonesian. Anyone else: still default to
    // id because the homepage is overwhelmingly an Indonesian
    // audience. The 🌐 toggle is one click away.
    try {
      const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || '').toLowerCase();
      if (/asia\/(jakarta|surabaya|makassar|jayapura|pontianak)/.test(tz)) return 'id';
    } catch {}
    // 5. Hard default
    return 'id';
  }
  let currentLang = detectInitialLang();

  // ---- Lookup --------------------------------------------------------------
  function lookup(lang, key) {
    const en = I18N.en, id = I18N.id;
    if (!key) return '';
    const parts = key.split('.');
    const get = (table) => {
      let cur = table;
      for (const p of parts) {
        if (cur && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p];
        else return undefined;
      }
      return typeof cur === 'string' ? cur : undefined;
    };
    return get(I18N[lang]) ?? get(I18N.id) ?? key;
  }
  function interpolate(str, vars) {
    if (!vars) return str;
    return String(str).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  }
  window.t = function (key, varsOrFallback, fallback) {
    // Two signatures, picked automatically:
    //   t('home.title')                          → just the key
    //   t('home.title', {brand: 'Adzkiya'})      → vars
    //   t('home.title', 'plain string fallback') → no interpolation, fallback string if key missing
    let vars = null;
    let fb = undefined;
    if (typeof varsOrFallback === 'string') fb = varsOrFallback;
    else if (varsOrFallback && typeof varsOrFallback === 'object') vars = varsOrFallback;
    if (typeof fallback === 'string') fb = fallback;
    const raw = lookup(currentLang, key);
    const val = raw === key && fb != null ? fb : raw;
    return interpolate(val, vars);
  };

  // ---- DOM walk ------------------------------------------------------------
  // Three attribute families:
  //   data-i18n="key"               → set textContent
  //   data-i18n-html="key"          → set innerHTML (trusted translations only)
  //   data-i18n-attr="placeholder:form.ph_name" → set attribute from "<attr>:<key>"
  // Three-pass apply (key-based + attribute-based + html-based).
  function applyAll() {
    document.documentElement.setAttribute('lang', currentLang);
    // text
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const val = lookup(currentLang, key);
      if (typeof val === 'string') el.textContent = val;
    });
    // html
    document.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const key = el.getAttribute('data-i18n-html');
      const val = lookup(currentLang, key);
      if (typeof val === 'string') el.innerHTML = val;
    });
    // attributes (e.g. "placeholder:form.whatsapp_ph")
    document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      const spec = el.getAttribute('data-i18n-attr') || '';
      spec.split(/\s+/).filter(Boolean).forEach((pair) => {
        const idx = pair.indexOf(':');
        if (idx <= 0) return;
        const attr = pair.slice(0, idx);
        const key = pair.slice(idx + 1);
        const val = lookup(currentLang, key);
        if (typeof val === 'string') el.setAttribute(attr, val);
      });
    });
    // Title tag — for SEO + browser tab
    const t = lookup(currentLang, 'share.page_title');
    if (typeof t === 'string' && document.title && document.title.includes('Kwitansi')) {
      document.title = t;
    }
    // Notify listeners (e.g. service-grid renderer or hero tagline setter)
    document.dispatchEvent(new CustomEvent('i18n:applied', { detail: { lang: currentLang } }));
  }

  // ---- Public API ----------------------------------------------------------
  function setLang(next) {
    const n = (next || '').toLowerCase().split('-')[0];
    if (n !== 'en' && n !== 'id') return false;
    if (n === currentLang) return true;
    currentLang = n;
    try { localStorage.setItem('adz_lang', n); } catch {}
    // Reflect in URL too (without reloading) so shared links carry the lang.
    try {
      const url = new URL(location.href);
      url.searchParams.set('lang', n);
      history.replaceState({}, '', url.toString());
    } catch {}
    applyAll();
    return true;
  }
  window.setLang = setLang;
  window.getLang = function () { return currentLang; };

  // ---- Auto-init -----------------------------------------------------------
  // Apply on DOMContentLoaded. Each page must load i18n.js BEFORE its main
  // script so all the data-i18n attributes are in place when main.js runs.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyAll);
  } else {
    applyAll();
  }

  // ---- Toggle button helper ------------------------------------------------
  // Many pages have a small globe icon next to the theme toggle. We expose
  // a hook so those buttons can call `i18n.bindToggle(el)` and we handle
  // the click + the icon swap automatically.
  function bindToggle(el) {
    if (!el) return;
    function paint() {
      el.textContent = currentLang === 'id' ? '🌐 EN' : '🌐 ID';
      el.setAttribute('aria-label', lookup(currentLang, 'nav.language_toggle'));
      el.setAttribute('title', lookup(currentLang, 'nav.language_toggle'));
    }
    paint();
    el.addEventListener('click', () => {
      setLang(currentLang === 'id' ? 'en' : 'id');
      paint();
    });
  }
  window.i18n = window.i18n || {};
  window.i18n.bindToggle = bindToggle;
})();
