// Pengganti makefun-site 1.0.0 yang lebih cepat, ronde 3 — ditulis dari nol.
// Semantik byte-identik dengan referensi (README + kode vendor kit ini).
// Lompatan struktural ronde 3 dibanding ronde 2 (interpreter + pemangkas
// alokasi): template TIDAK dirender berulang-ulang bila hasilnya sudah
// pasti sama. Setiap include dianalisis statis atas AST-nya (variabel bebas
// transitif): bila include hanya membaca nilai level-case (site/tags/recent)
// ia dirender SEKALI per case dan dipakai ulang; bila ia hanya bergantung
// pada satu variabel loop (mis. kartu post `p`) ia dirender sekali per nilai
// variabel itu (satu kartu post dirender sekali, bukan di tiap index/tag
// page). Pemeriksaan saat render memastikan nama yang dibaca tidak
// ter-shadow oleh loop di tempat include itu dipakai; bila ragu, render
// normal. Penjaga kedalaman include (maks 8) tetap dihormati. Selain itu
// pemindai inline Markdown memakai satu regex perhatian saja (pemicu konstruk
// + karakter yang harus di-escape), jadi tiap run teks biasa tidak lagi
// dipindai dua kali. Tanpa cache antar case: semua memo dibuat baru di
// dalam run() dan dibuang setelah satu case selesai.

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- teks

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` dengan & < > " ' di-escape; tanpa karakter itu dikembalikan apa adanya. */
function escapeHtml(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}

/** Jalur cepat slug ASCII: huruf ASCII saja yang berubah (NFKD identitas). */
const ASCII_ONLY = /^[\x00-\x7F]*$/;
const NON_ALNUM = /[^a-z0-9]+/g;
const LEAD_TRAIL_DASH = /^-+|-+$/g;

/** Slug dari `text` (aturan README "Text"), dengan cache per-build `cx.slugCache`. */
function slugify(cx, text) {
  const hit = cx.slugCache.get(text);
  if (hit !== undefined) return hit;
  let slug;
  if (ASCII_ONLY.test(text)) {
    // Sama persis dengan loop di bawah untuk input ASCII: NFKD tidak mengubah
    // ASCII, huruf besar jadi kecil, selain a-z0-9 jadi pemisah satu '-'.
    let out = text.toLowerCase().replace(NON_ALNUM, '-').replace(LEAD_TRAIL_DASH, '');
    out = out.slice(0, 64).replace(/-+$/, '');
    slug = out === '' ? 'untitled' : out;
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, 64).replace(/-+$/, '');
    slug = out === '' ? 'untitled' : out;
  }
  cx.slugCache.set(text, slug);
  return slug;
}

/** `slug` dibuat unik terhadap `taken` (dan ditambahkan ke dalamnya). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** Tanggal YYYY-MM-DD dalam kata-kata, dari string saja. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/**
 * Kata-kata sebuah body: run karakter bukan whitespace. Dihitung manual
 * tanpa alokasi array (match(/\S+/g) terukur 1,7x lebih lambat).
 * Himpunan whitespace sama persis dengan \s JavaScript.
 */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws =
      c === 32 ||
      (c >= 9 && c <= 13) ||
      (c >= 160 &&
        (c === 160 ||
          c === 0x1680 ||
          (c >= 0x2000 && c <= 0x200a) ||
          c === 0x2028 ||
          c === 0x2029 ||
          c === 0x202f ||
          c === 0x205f ||
          c === 0x3000 ||
          c === 0xfeff));
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` dari direktori `dir` sebuah sumber, atau null bila naik di atas root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Sama dengan resolvePath, tapi `dirParts` sudah di-split sekali per halaman. */
function resolveFromParts(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Spasi/tab di kedua ujung `line` dibuang (tanpa regex). */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Apakah `line` kosong (hanya spasi/tab). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * Front matter + body sebuah sumber: { data, body }, atau { error }.
 * Baris front matter dikumpulkan dulu sebagai string polos (tanpa objek
 * pembungkus), baru divalidasi setelah yakin bloknya tertutup — urutan
 * error sama persis dengan referensi (blok tak tertutup dilaporkan dulu).
 */
function parseFrontMatter(text) {
  const n = text.length;
  let pos = 0;
  const nextLine = () => {
    if (pos > n) return null;
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    pos = e === -1 ? n + 1 : e + 1;
    return line;
  };
  const first = nextLine();
  if (first === null || first !== '---') return { error: 'no front matter' };
  const fmLines = [];
  let closed = false;
  let bodyStart = -1;
  while (true) {
    const line = nextLine();
    if (line === null) break;
    if (line === '---') {
      closed = true;
      bodyStart = pos;
      break;
    }
    fmLines.push(line);
  }
  if (!closed) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    const no = i + 2;
    if (isBlankLine(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${no} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: bodyStart <= n ? text.slice(bodyStart) : '' };
}

// ---------------------------------------------------------------- Markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const WS_TARGET = /\s/;
/**
 * Satu regex perhatian untuk pemindai inline: pemicu konstruk
 * (`\`, backtick, `*`, `[`) DAN karakter yang harus di-escape HTML
 * (`& < > " '`). Pemindai hanya berhenti di karakter-karakter ini, jadi
 * sebuah run teks biasa di antara dua perhentian dijamin bebas karakter
 * escape dan bisa didorong apa adanya — tanpa pemindaian escape terpisah
 * per run seperti sebelumnya.
 */
const ATTN = /[\\`*\[&<>"']/g;

/** Karakter yang di-escape oleh backslash. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/**
 * Jumlah backslash berurutan tepat sebelum posisi `j`, dihitung mundur
 * sampai `from`. Ganjil = karakter di `j` di-escape; genap = tidak.
 * Sama dengan pemindaian karakter-demi-karakter referensi: backslash
 * meng-escape karakter berikut hanya bila ia sendiri tidak di-escape.
 */
function bsCount(s, j, from) {
  let n = 0;
  while (j - 1 - n >= from && s[j - 1 - n] === '\\') n++;
  return n;
}

/**
 * Indeks pertama `what` di `s` dari `from` sampai `hi` (cocok harus berakhir
 * di dalam `hi`), di luar escape backslash, atau -1. Pencarian memakai
 * indexOf native — terukur ~13x lebih cepat dari loop per karakter.
 */
function findUnescaped(s, what, from, hi) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j + what.length <= hi) {
    if (bsCount(s, j, from) % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** Indeks `*` tunggal pertama dari `from` sampai `hi` (bukan bagian `**`), di luar escape, atau -1. */
function findSingleStar(s, from, hi) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < hi) {
    if (bsCount(s, j, from) % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (j + 1 < hi && s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * Rentang `s[lo..hi)` dirender inline, potongan-potongan ditambahkan ke
 * array `out`. Pemindai satu-pass: regex native mencari karakter perhatian
 * berikutnya; run teks biasa di antaranya didorong apa adanya (dijamin
 * bebas karakter escape); pemicu yang ternyata literal tetap tinggal di
 * dalam run (runStart tidak ikut maju). Rekursi untuk em/strong/link
 * memakai rentang, bukan slice — tanpa alokasi string per konstruk.
 * (ATTN dipakai ulang antar pemanggilan rekursif, tapi lastIndex selalu
 * disetel sebelum tiap exec, jadi aman.)
 */
function inlineRange(out, s, lo, hi, env) {
  let runStart = lo;
  let pos = lo;
  while (true) {
    ATTN.lastIndex = pos;
    const m = ATTN.exec(s);
    if (m === null || m.index >= hi) {
      if (hi > runStart) out.push(s.slice(runStart, hi));
      return;
    }
    const j = m.index;
    const c = s[j];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      if (j > runStart) out.push(s.slice(runStart, j));
      out.push(ESCAPES[c]);
      pos = j + 1;
      runStart = pos;
      continue;
    }
    if (c === '\\') {
      if (j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
        if (j > runStart) out.push(s.slice(runStart, j));
        out.push(ESCAPES[s[j + 1]] ?? s[j + 1]);
        pos = j + 2;
        runStart = pos;
      } else pos = j + 1;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < hi && k > j + 1) {
        if (j > runStart) out.push(s.slice(runStart, j));
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        pos = k + 1;
        runStart = pos;
      } else pos = j + 1;
      continue;
    }
    if (c === '*') {
      if (j + 1 < hi && s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, hi);
        if (k > j + 2) {
          if (j > runStart) out.push(s.slice(runStart, j));
          out.push('<strong>');
          inlineRange(out, s, j + 2, k, env);
          out.push('</strong>');
          pos = k + 2;
          runStart = pos;
        } else pos = j + 2;
      } else {
        const k = findSingleStar(s, j + 1, hi);
        if (k > j + 1) {
          if (j > runStart) out.push(s.slice(runStart, j));
          out.push('<em>');
          inlineRange(out, s, j + 1, k, env);
          out.push('</em>');
          pos = k + 1;
          runStart = pos;
        } else pos = j + 1;
      }
      continue;
    }
    const k = findUnescaped(s, ']', j + 1, hi);
    const m2 = k !== -1 && k + 1 < hi && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m2 !== -1 && m2 < hi ? s.slice(k + 2, m2) : '';
    if (m2 !== -1 && m2 < hi && target !== '' && !WS_TARGET.test(target)) {
      if (j > runStart) out.push(s.slice(runStart, j));
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineRange(out, s, j + 1, k, env);
      out.push('</a>');
      pos = m2 + 1;
      runStart = pos;
    } else pos = j + 1;
  }
}

/** `s` dirender inline menjadi satu string. */
function inline(s, env) {
  const out = [];
  inlineRange(out, s, 0, s.length, env);
  return out.join('');
}

/** Klasifikasi cepat sebuah baris untuk lexer (regex hanya bila perlu). */
function fenceOpenOf(line) {
  if (line.charCodeAt(0) !== 96 || !line.startsWith('```')) return null;
  return FENCE_OPEN.exec(line);
}
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  return HR.test(line);
}
/**
 * Apakah `line` mengakhiri paragraf. Sama persis dengan gabungan empat cek
 * referensi, tapi dispatch dari karakter pertama: baris teks biasa (huruf)
 * langsung false tanpa empat panggilan fungsi.
 */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlankLine(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 96) return fenceOpenOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/**
 * `src` dirender: HTML-nya, daftar isi (heading level 2-3) dan excerpt
 * (HTML paragraf pertama, atau ""). Lexer + render satu-pass ke satu array
 * `out` (tanpa array blok + map + join per blok); excerpt diambil dari
 * potongan array paragraf pertama.
 */
function renderMarkdown(cx, src, env) {
  const n = src.length;
  let pos = 0;
  const nextLine = () => {
    if (pos > n) return null;
    const e = src.indexOf('\n', pos);
    const line = e === -1 ? src.slice(pos) : src.slice(pos, e);
    pos = e === -1 ? n + 1 : e + 1;
    return line;
  };
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let cur = nextLine();
  while (cur !== null) {
    const line = cur;
    if (isBlankLine(line)) {
      cur = nextLine();
      continue;
    }
    const fence = fenceOpenOf(line);
    if (fence !== null) {
      const body = [];
      cur = nextLine();
      while (cur !== null && !FENCE_CLOSE.test(cur)) {
        body.push(cur);
        cur = nextLine();
      }
      if (cur !== null) cur = nextLine();
      const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
      const code = body.length === 0 ? '' : escapeHtml(`${body.join('\n')}\n`);
      out.push(`<pre><code${cls}>${code}</code></pre>\n`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(cx, heading.text), ids);
      const html = inline(heading.text, env);
      out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      cur = nextLine();
      continue;
    }
    if (isHr(line)) {
      out.push('<hr>\n');
      cur = nextLine();
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (cur !== null && cur.charCodeAt(0) === 62) {
        body.push(cur.replace(/^> ?/, ''));
        cur = nextLine();
      }
      const lines = body.map(trimLine).filter((l) => l !== '');
      if (lines.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const text = lines.join('\n');
        out.push('<blockquote>\n<p>');
        inlineRange(out, text, 0, text.length, env);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const c0 = line.charCodeAt(0);
    let bullet = null;
    let ordered = null;
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) bullet = BULLET.exec(line);
    if (bullet === null && c0 >= 48 && c0 <= 57) ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (cur !== null) {
        const m = marker.exec(cur);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          cur = nextLine();
        } else if (CONTINUED.test(cur)) {
          items[items.length - 1].push(trimLine(cur));
          cur = nextLine();
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const start = isOrdered ? Number(ordered[1]) : 1;
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      out.push(`${open}\n`);
      for (const item of items) {
        const text = item.join('\n');
        out.push('<li>');
        inlineRange(out, text, 0, text.length, env);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    cur = nextLine();
    while (cur !== null && !endsParagraph(cur)) {
      body.push(trimLine(cur));
      cur = nextLine();
    }
    const html = body.join('\n');
    out.push('<p>');
    const mark = out.length;
    inlineRange(out, html, 0, html.length, env);
    if (excerpt === null) excerpt = out.slice(mark).join('');
    out.push('</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Template

const INCLUDE_DEPTH = 8;
const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** Nama root yang nilainya sama untuk semua halaman dalam satu case. */
const CASE_ROOTS = new Set(['site', 'tags', 'recent']);
/** Nama root yang nilainya berbeda per halaman/render (tidak boleh di-memo). */
const PAGE_ROOTS = new Set(['page', 'posts', 'tag', 'pager']);

/** Template yang tidak parse: nama + alasannya. */
class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Token-token `src`: text, {{ }}, {{{ }}} dan {% %}; baris tag mandiri ikut termakan. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` di-parse menjadi pohon node (TemplateError bila tidak parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** Nilai pada `path` dalam rantai scope: nama pertama dari scope terdekat yang mengikatnya. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** Sebuah nilai sebagai teks: string apa adanya, number, true/false, array join ", ", lainnya "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Apakah sebuah nilai dihitung benar dalam if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// ------------------------------------------------------- analisis memo template

/**
 * Variabel bebas + nama include dari node-node, dengan `bound` = nama yang
 * terikat oleh for di sekitar (di dalam template ini sendiri).
 */
function collectFree(nodes, bound, out) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0])) out.vars.add(n.path[0]);
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) out.vars.add(n.path[0]);
      collectFree(n.then, bound, out);
      if (n.else !== null) collectFree(n.else, bound, out);
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) out.vars.add(n.path[0]);
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      collectFree(n.body, b2, out);
    } else if (n.kind === 'include') out.includes.push(n.name);
  }
}

/**
 * Klasifikasi tiap template yang ter-parse, untuk memo include:
 * - kind 0 (volatil): output bergantung pada halaman/render — render normal.
 * - kind 1 (case-constant): hanya membaca site/tags/recent (atau nama yang
 *   tidak terikat di mana pun) — render sekali per case, pakai ulang.
 * - kind 2 (per-nilai): selain nilai case, hanya bergantung pada SATU
 *   variabel loop (mis. kartu post `p`) — render sekali per nilai itu.
 * Analisisnya transitif (include bersarang ikut dihitung) dan titik-tetap
 * (siklus include ditangani: iterasi sampai stabil). `nest` = rantai
 * include terpanjang dari template ini (siklus -> 8, memo dimatikan).
 */
function analyzeTemplates(templates) {
  const direct = new Map();
  for (const [name, nodes] of templates) {
    const out = { vars: new Set(), includes: [] };
    collectFree(nodes, new Set(), out);
    direct.set(name, out);
  }
  const rawFree = new Map();
  for (const [name, d] of direct) rawFree.set(name, new Set(d.vars));
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 40) {
    changed = false;
    for (const [name, d] of direct) {
      const s = rawFree.get(name);
      for (const inc of d.includes) {
        const f = rawFree.get(inc);
        if (f === undefined) continue;
        for (const v of f) {
          if (!s.has(v)) {
            s.add(v);
            changed = true;
          }
        }
      }
    }
  }
  const nestMemo = new Map();
  const nest = (name, visiting) => {
    if (nestMemo.has(name)) return nestMemo.get(name);
    if (visiting.has(name)) return 8;
    const d = direct.get(name);
    if (d === undefined) return 0;
    visiting.add(name);
    let m = 0;
    for (const inc of d.includes) m = Math.max(m, 1 + nest(inc, visiting));
    visiting.delete(name);
    nestMemo.set(name, m);
    return m;
  };
  const classes = new Map();
  for (const [name] of direct) {
    const free = rawFree.get(name);
    const n = nest(name, new Set());
    let kind = 0;
    let keyVar = null;
    if (n < 8) {
      let volatile = false;
      const keys = [];
      for (const v of free) {
        if (PAGE_ROOTS.has(v)) {
          volatile = true;
          break;
        }
        if (!CASE_ROOTS.has(v)) keys.push(v);
      }
      if (!volatile) {
        if (keys.length === 0) kind = 1;
        else if (keys.length === 1 && keys[0] !== 'loop') {
          kind = 2;
          keyVar = keys[0];
        }
      }
    }
    classes.set(name, { kind, keyVar, free: [...free], nest: n });
  }
  return classes;
}

/**
 * Apakah nama `v` di `scope` terikat di scope akar (nilai level-case) atau
 * tidak terikat di mana pun (undefined — konstan). Bila terikat di scope
 * loop di tengah rantai, jawabannya false: nilainya bisa berbeda per
 * halaman/iterasi, jadi memo tidak boleh dipakai di tempat ini.
 */
function resolvesFromRoot(scope, v) {
  let s = scope;
  while (s !== null) {
    if (Object.hasOwn(s.vars, v)) return s.parent === null;
    s = s.parent;
  }
  return true;
}

/**
 * Node-node dirender dalam `scope`, potongan ditambahkan ke array `out`.
 * Loop `for` memakai satu objek scope yang dipakai ulang tiap iterasi
 * (render berjalan sinkron; scope tidak disimpan setelah iterasi selesai).
 * Include yang terklasifikasi case-constant / per-nilai dirender sekali
 * dan dipakai ulang (dengan pemeriksaan resolvesFromRoot + penjaga
 * kedalaman); bila pemeriksaan gagal, render normal seperti biasa.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const child = { vars: {}, parent: scope };
        const loop = { index: 0, first: false, last: false, length: xs.length };
        for (let k = 0; k < xs.length; k++) {
          // Item dulu, lalu loop — supaya bila nama loop-nya 'loop', objek
          // loop yang menang, sama seperti literal objek referensi.
          child.vars[n.name] = xs[k];
          child.vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        const cls = ctx.memo.get(n.name);
        if (cls === undefined || cls.kind === 0 || depth + cls.nest >= INCLUDE_DEPTH) {
          renderNodes(t, scope, ctx, depth + 1, out);
          break;
        }
        let ok = true;
        for (const v of cls.free) {
          if (v === cls.keyVar) continue;
          if (!resolvesFromRoot(scope, v)) {
            ok = false;
            break;
          }
        }
        if (!ok) {
          renderNodes(t, scope, ctx, depth + 1, out);
          break;
        }
        if (cls.kind === 1) {
          let hit = ctx.memoConst.get(n.name);
          if (hit === undefined) {
            const tmp = [];
            renderNodes(t, scope, ctx, depth + 1, tmp);
            hit = tmp.join('');
            ctx.memoConst.set(n.name, hit);
          }
          out.push(hit);
        } else {
          const keyVal = lookup(scope, [cls.keyVar]);
          let m = ctx.memoVal.get(n.name);
          if (m === undefined) {
            m = new Map();
            ctx.memoVal.set(n.name, m);
          }
          let hit = m.get(keyVal);
          if (hit === undefined) {
            const tmp = [];
            renderNodes(t, scope, ctx, depth + 1, tmp);
            hit = tmp.join('');
            m.set(keyVal, hit);
          }
          out.push(hit);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

/** Rekaman link sebuah halaman seperti template membacanya. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** Satu case dijawab: pohon output path -> teks. Semua cache dibuat baru di sini. */
function build(input) {
  const cx = { slugCache: new Map() };
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const memo = analyzeTemplates(templates);
  const base = input.site.base_url.replace(/\/+$/, '');
  // 1. Sumber, diurutkan code-unit; .md jadi sumber, lainnya statis.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    // Kebanyakan file tanpa \r: lewati replace bila tidak ada.
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }
  // 2. Front matter + cek penolakan berurutan.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  // 3. Permalink: slug unik per direktori, dalam urutan sumber.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(cx, s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  // 4. Markdown tiap body + resolusi link.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolveFromParts(dirParts, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(cx, s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
  // 5. Koleksi post: tanggal terbaru dulu, tanggal sama -> slug code-unit.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  // 6. Tag: per post tiap slug sekali; halaman menunjuk tag post yang slug-nya sama.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => {
      const slug = slugify(cx, name);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(cx, name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(cx, name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  // 7. Layout: card dibangun sekali per sumber, dipakai ulang oleh page.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  for (const s of kept) s.card = s.post ? cards.get(s) : cardOf(s);
  // Objek halaman ditulis eksplisit (tanpa spread) dengan field yang sama
  // persis seperti referensi; toc dipakai langsung (nilainya identik —
  // template hanya membaca level/id/html, tidak bisa membedakan identitas).
  const pageOf = (s) => {
    const c = s.card;
    return {
      title: c.title,
      url: c.url,
      date: c.date,
      date_long: c.date_long,
      summary: c.summary,
      excerpt: c.excerpt,
      reading_minutes: c.reading_minutes,
      tags: c.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // Memo include hidup hanya selama satu case ini (dibuat baru per build).
  const ctx = { templates, memo, memoConst: new Map(), memoVal: new Map() };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    const scope = { vars: { site, tags: allTags, recent, ...vars }, parent: null };
    renderNodes(nodes, scope, ctx, 0, out);
    return out.join('');
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  // 8. Laporan: semua baris diurutkan code-unit, lalu baris jumlah.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** Jawaban makefun-site 1.0.0 untuk satu case, lebih cepat. */
export function run(input) {
  return build(input);
}
