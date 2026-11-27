/**
 * Draws the profile border artwork into public/borders/. Each border has an animated file ({art}.svg) for
 * previews and profiles and a still file ({art}-static.svg) for long lists. The frame is 200×200 with the
 * avatar circle (radius 62) in the middle, so the image is drawn at 1.6× the avatar size.
 * Run: node scripts/build-borders.js
 */
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'public', 'borders');
const C = 100;
let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const polar = (r, deg) => { const a = (deg - 90) * Math.PI / 180; return [C + r * Math.cos(a), C + r * Math.sin(a)]; };
const f = (n) => Math.round(n * 100) / 100;
const pt = (r, deg) => polar(r, deg).map(f).join(',');
const ring = (r, width, stroke, extra = '') => `<circle cx="100" cy="100" r="${r}" fill="none" stroke="${stroke}" stroke-width="${width}" ${extra}/>`;
const gem = (cx, cy, size, fill, rot = 0, cls = '') => `<g transform="translate(${f(cx)} ${f(cy)}) rotate(${rot})"${cls ? ` class="${cls}"` : ''}><polygon points="0,${-size} ${size * 0.8},${-size * 0.3} ${size * 0.8},${size * 0.3} 0,${size} ${-size * 0.8},${size * 0.3} ${-size * 0.8},${-size * 0.3}" fill="${fill}" stroke="#ffffff55" stroke-width="0.8"/><polygon points="0,${-size} ${size * 0.8},${-size * 0.3} 0,0 ${-size * 0.8},${-size * 0.3}" fill="#ffffff40"/></g>`;
const sparkle = (cx, cy, s, color, delay) => `<path class="tw" style="animation-delay:${delay}s;transform-origin:${f(cx)}px ${f(cy)}px" d="M${f(cx)} ${f(cy - s)}Q${f(cx)} ${f(cy)} ${f(cx + s)} ${f(cy)}Q${f(cx)} ${f(cy)} ${f(cx)} ${f(cy + s)}Q${f(cx)} ${f(cy)} ${f(cx - s)} ${f(cy)}Q${f(cx)} ${f(cy)} ${f(cx)} ${f(cy - s)}Z" fill="${color}"/>`;
const sparkles = (count, rMin, rMax, color, size = 4) => Array.from({ length: count }, (_, i) => { const [x, y] = polar(rMin + rand() * (rMax - rMin), rand() * 360); return sparkle(x, y, size * (0.6 + rand() * 0.6), color, f(i * 0.37 % 2.4)); }).join('');
const glow = (id, blur) => `<filter id="${id}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${blur}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
const lin = (id, stops, x2 = 0, y2 = 1) => `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>`;
const sweep = (r, width, color, len = 60) => `<circle class="spin" cx="100" cy="100" r="${r}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${f(2 * Math.PI * r * len / 360)} ${f(2 * Math.PI * r)}"/>`;

const ANIM = `
.spin{transform-origin:100px 100px;animation:spin 6s linear infinite}
.spin-slow{transform-origin:100px 100px;animation:spin 18s linear infinite}
.spin-back{transform-origin:100px 100px;animation:spin 24s linear infinite reverse}
.tw{animation:tw 2.4s ease-in-out infinite}
.pulse{animation:pulse 2.2s ease-in-out infinite}
.flick{transform-origin:100px 170px;animation:flick 1.4s ease-in-out infinite alternate}
.drip{animation:drip 3s ease-in infinite}
.bob{animation:bob 3s ease-in-out infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes tw{0%,100%{opacity:.15;transform:scale(.5)}50%{opacity:1;transform:scale(1)}}
@keyframes pulse{0%,100%{opacity:.55}50%{opacity:1}}
@keyframes flick{from{transform:scaleY(.94) skewX(-1.5deg)}to{transform:scaleY(1.05) skewX(1.5deg)}}
@keyframes drip{0%{transform:translateY(0);opacity:0}15%{opacity:1}80%{opacity:1}100%{transform:translateY(16px);opacity:0}}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}`;
const STILL = '.tw{opacity:.8}';

const designs = {
  emerald() {
    const gems = Array.from({ length: 8 }, (_, i) => { const [x, y] = polar(70, i * 45 + 22.5); return gem(x, y, 5, 'url(#eg)', i * 45 + 22.5); }).join('');
    return `<defs>${lin('er', [[0, '#7dffa8'], [0.5, '#1fae55'], [1, '#0b5c2c']])}${lin('eg', [[0, '#b6ffd0'], [1, '#17a24c']])}${glow('g', 2.5)}</defs>
      ${ring(70, 9, '#06351a')}${ring(70, 6, 'url(#er)', 'filter="url(#g)"')}${ring(65.5, 1, '#c8ffe0aa')}${gems}
      <g transform="translate(0 -2)">${gem(100, 26, 13, 'url(#eg)')}</g>${sparkles(7, 58, 92, '#d8ffe6')}`;
  },
  diamond() {
    return `<defs>${lin('dr', [[0, '#e8ffff'], [0.45, '#4fe3f0'], [1, '#147f9b']])}${lin('dg', [[0, '#ffffff'], [0.4, '#8ff4ff'], [1, '#1aa7c4']])}${glow('g', 3)}</defs>
      ${ring(71, 8, '#0c3b47')}${ring(71, 5, 'url(#dr)', 'filter="url(#g)"')}${ring(66, 1.4, '#c9fbff')}${sweep(71, 5, '#ffffff', 40)}
      <g filter="url(#g)"><polygon points="100,156 122,172 100,196 78,172" fill="url(#dg)" stroke="#e8ffff" stroke-width="1.2"/><polygon points="100,156 122,172 100,176 78,172" fill="#ffffff66"/></g>
      ${[[-1, 0], [1, 0]].map(([s]) => `<polygon points="${100 + s * 30},164 ${100 + s * 44},170 ${100 + s * 30},177" fill="url(#dg)" opacity=".85"/>`).join('')}${sparkles(8, 60, 94, '#ffffff')}`;
  },
  netherite() {
    const bolts = [0, 90, 180, 270].map((deg) => { const [x, y] = polar(71, deg); return `<rect x="${f(x - 6)}" y="${f(y - 6)}" width="12" height="12" rx="2" transform="rotate(45 ${f(x)} ${f(y)})" fill="url(#nb)" stroke="#1a1416" stroke-width="1.2"/><circle cx="${f(x)}" cy="${f(y)}" r="2" fill="#f4b04a" class="pulse"/>`; }).join('');
    const scratches = Array.from({ length: 14 }, (_, i) => `<path d="M${pt(66, i * 26)}L${pt(76, i * 26 + 6)}" stroke="#7d7174" stroke-width="1" opacity=".6"/>`).join('');
    return `<defs>${lin('nr', [[0, '#6e6467'], [0.5, '#3d3437'], [1, '#231d1f']])}${lin('nb', [[0, '#8a7f82'], [1, '#3b3336']])}${glow('g', 2)}</defs>
      ${ring(71, 13, '#151112')}${ring(71, 10, 'url(#nr)')}${scratches}${ring(64.5, 1.2, '#f4b04a66', 'class="pulse"')}${ring(77.5, 1.2, '#00000088')}${bolts}`;
  },
  obsidian() {
    const shards = Array.from({ length: 22 }, (_, i) => { const a = i * (360 / 22); const r1 = 64 + rand() * 3; const r2 = 76 + rand() * 6; return `<polygon points="${pt(r1, a - 7)} ${pt(r2, a)} ${pt(r1, a + 8)}" fill="${i % 3 ? '#1b0f2b' : '#2c1846'}" stroke="#4b2a77" stroke-width=".8"/>`; }).join('');
    const tears = [200, 160, 230, 130].map((deg, i) => { const [x, y] = polar(74, deg); return `<circle class="drip" style="animation-delay:${i * 0.7}s" cx="${f(x)}" cy="${f(y)}" r="2.4" fill="#a45cff"/>`; }).join('');
    return `<defs>${glow('g', 2.5)}</defs>${ring(70, 12, '#0b0612')}${shards}${ring(66, 1.5, '#7f3fd6', 'class="pulse" filter="url(#g)"')}<g filter="url(#g)">${tears}</g>`;
  },
  'ender-void'() {
    const dots = Array.from({ length: 40 }, () => { const [x, y] = polar(62 + rand() * 30, rand() * 360); const s = 1.5 + rand() * 3; return `<rect x="${f(x)}" y="${f(y)}" width="${f(s)}" height="${f(s)}" fill="${rand() > 0.5 ? '#c86bff' : '#e8b8ff'}" opacity="${f(0.4 + rand() * 0.6)}"/>`; }).join('');
    return `<defs><radialGradient id="vr"><stop offset=".6" stop-color="#1a0630" stop-opacity="0"/><stop offset=".72" stop-color="#5b1a9c" stop-opacity=".9"/><stop offset=".82" stop-color="#1a0630" stop-opacity=".8"/><stop offset="1" stop-color="#1a0630" stop-opacity="0"/></radialGradient>${glow('g', 2.5)}</defs>
      <circle cx="100" cy="100" r="95" fill="url(#vr)"/><g class="spin-slow" filter="url(#g)">${dots}</g>${ring(68, 2, '#c86bff', 'filter="url(#g)"')}<g class="spin-back">${ring(78, 1.2, '#e8b8ff66', 'stroke-dasharray="3 9"')}</g>`;
  },
  enchanted() {
    const glyphs = 'ᔑʖᓵ↸ᒷ⎓⊣⍑╎⋮ꖌꖎᒲリ𝙹!¡ᑑ∷ᓭℸ⚍⍊∴'.match(/./gu);
    const text = Array.from({ length: 18 }, (_, i) => { const [x, y] = polar(84, i * 20); return `<text x="${f(x)}" y="${f(y)}" font-size="10" font-family="serif" fill="#e2c6ff" text-anchor="middle" dominant-baseline="middle" transform="rotate(${i * 20} ${f(x)} ${f(y)})">${glyphs[i % glyphs.length]}</text>`; }).join('');
    return `<defs>${lin('xr', [[0, '#f0d9ff'], [0.5, '#a259ff'], [1, '#5a1fa8']], 1, 1)}${glow('g', 3)}</defs>
      ${ring(70, 8, '#24103f')}${ring(70, 5, 'url(#xr)', 'filter="url(#g)"')}${sweep(70, 6, '#f6e8ff', 70)}<g class="spin-back" opacity=".9" filter="url(#g)">${text}</g>${sparkles(9, 58, 96, '#f3dcff')}`;
  },
  'end-crystal'() {
    return `<defs>${lin('cr', [[0, '#ffd1f5'], [0.5, '#e36bd0'], [1, '#7a2a8f']])}${glow('g', 3)}</defs>
      ${ring(70, 8, '#2b0f2f')}${ring(70, 5, 'url(#cr)', 'filter="url(#g)"')}<path d="M100 4V-40" stroke="#ffb3ef" stroke-width="3"/>
      <g class="bob" filter="url(#g)"><g class="spin" style="transform-origin:100px 26px"><rect x="86" y="12" width="28" height="28" fill="none" stroke="#ffe6fa" stroke-width="2.5" transform="rotate(45 100 26)"/></g>
      <rect x="91" y="17" width="18" height="18" fill="#ff8fe3" fill-opacity=".35" stroke="#ff8fe3" stroke-width="2"/><rect x="96" y="22" width="8" height="8" fill="#ffffff"/></g>${sparkles(6, 60, 92, '#ffd6f6')}`;
  },
  'respawn-anchor'() {
    const charges = [0, 90, 180, 270].map((deg, i) => `<path class="pulse" style="animation-delay:${i * 0.55}s" d="M${pt(71, deg - 28)}A71 71 0 0 1 ${pt(71, deg + 28)}" fill="none" stroke="#ffb22e" stroke-width="7" stroke-linecap="butt" filter="url(#g)"/>`).join('');
    return `<defs>${glow('g', 3)}</defs>${ring(71, 14, '#14101c')}${ring(71, 10, '#2a2238')}${charges}${ring(63.5, 1.6, '#7b3cff', 'class="pulse" filter="url(#g)"')}${ring(78.5, 1.6, '#3a3048')}
      ${[45, 135, 225, 315].map((deg) => { const [x, y] = polar(71, deg); return `<rect x="${f(x - 5)}" y="${f(y - 5)}" width="10" height="10" fill="#5a1fd1" stroke="#b07bff" stroke-width="1"/>`; }).join('')}`;
  },
  totem() {
    const wing = (s) => `<path d="M${100 + s * 24} 170 C${100 + s * 52} 150 ${100 + s * 80} 160 ${100 + s * 92} 132 C${100 + s * 74} 150 ${100 + s * 60} 156 ${100 + s * 50} 160 C${100 + s * 64} 162 ${100 + s * 70} 170 ${100 + s * 74} 178 C${100 + s * 56} 172 ${100 + s * 40} 176 ${100 + s * 24} 178Z" fill="url(#tg)" stroke="#8a5a00" stroke-width="1"/>`;
    return `<defs>${lin('tg', [[0, '#fff3b0'], [0.5, '#f2c230'], [1, '#a46d00']])}${glow('g', 2.5)}</defs>
      ${ring(70, 9, '#4a3000')}${ring(70, 6, 'url(#tg)', 'filter="url(#g)"')}${sweep(70, 6, '#fffbe0', 35)}${wing(-1)}${wing(1)}
      <g transform="translate(100 172)"><rect x="-13" y="-18" width="26" height="22" rx="3" fill="url(#tg)" stroke="#6b4500" stroke-width="1.5"/><rect x="-9" y="-12" width="6" height="6" fill="#1f9e47"/><rect x="3" y="-12" width="6" height="6" fill="#1f9e47"/><rect x="-6" y="-3" width="12" height="3" fill="#6b4500"/><rect x="-9" y="4" width="18" height="16" fill="url(#tg)" stroke="#6b4500" stroke-width="1.5"/></g>${sparkles(6, 60, 92, '#fff6c8')}`;
  },
  'nether-flame'() {
    const flame = (deg, h, i) => { const [x1, y1] = polar(70, deg - 10); const [x2, y2] = polar(70, deg + 10); const [tx, ty] = polar(70 + h, deg + 4); const [cx, cy] = polar(70 + h * 0.55, deg - 8); return `<path d="M${f(x1)} ${f(y1)}Q${f(cx)} ${f(cy)} ${f(tx)} ${f(ty)}Q${pt(70 + h * 0.4, deg + 12)} ${f(x2)} ${f(y2)}Z" fill="url(#fl)" opacity="${i % 2 ? 0.85 : 1}"/>`; };
    const flames = Array.from({ length: 18 }, (_, i) => flame(i * 20, 14 + (i % 3) * 7 + (i % 5 === 0 ? 8 : 0), i)).join('');
    return `<defs><linearGradient id="fl" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff3b1f"/><stop offset=".6" stop-color="#ff8a1f"/><stop offset="1" stop-color="#ffe27a"/></linearGradient>${glow('g', 3)}</defs>
      <g class="flick" filter="url(#g)">${flames}</g>${ring(69, 8, '#5a0f05')}${ring(69, 5, '#ff5a1f', 'filter="url(#g)"')}${ring(64.5, 1.4, '#ffd27a')}`;
  },
  bedrock() {
    const blocks = Array.from({ length: 36 }, (_, i) => { const [x, y] = polar(71, i * 10); const shade = ['#2b2b2b', '#4a4a4a', '#6b6b6b', '#3a3a3a', '#5a5a5a'][Math.floor(rand() * 5)]; return `<rect x="${f(x - 6)}" y="${f(y - 6)}" width="12" height="12" fill="${shade}" transform="rotate(${i * 10} ${f(x)} ${f(y)})"/>`; }).join('');
    const specks = Array.from({ length: 30 }, () => { const [x, y] = polar(66 + rand() * 10, rand() * 360); return `<rect x="${f(x)}" y="${f(y)}" width="2" height="2" fill="${rand() > 0.5 ? '#8c8c8c' : '#1a1a1a'}"/>`; }).join('');
    return `${ring(71, 15, '#1c1c1c')}${blocks}${specks}${ring(63.5, 1.5, '#0d0d0d')}${ring(78.5, 1.5, '#0d0d0d')}`;
  },
  amethyst() {
    const cluster = (deg, scale) => { const [x, y] = polar(74, deg); return `<g transform="translate(${f(x)} ${f(y)}) rotate(${deg}) scale(${scale})">${[[-9, 18, -14], [0, 26, 0], [9, 20, 16], [-4, 14, -32], [6, 12, 30]].map(([dx, h, rot]) => `<polygon points="${dx - 4},4 ${dx},${-h} ${dx + 4},4" fill="url(#am)" stroke="#f0d4ff" stroke-width=".7" transform="rotate(${rot} ${dx} 4)"/>`).join('')}</g>`; };
    return `<defs>${lin('am', [[0, '#f4dcff'], [0.5, '#b072f0'], [1, '#5d2a9e']])}${lin('ar', [[0, '#d8a9ff'], [1, '#6a35b0']])}${glow('g', 2.5)}</defs>
      ${ring(70, 8, '#2a1446')}${ring(70, 5, 'url(#ar)', 'filter="url(#g)"')}<g filter="url(#g)">${cluster(215, 1.15)}${cluster(35, 0.95)}${cluster(140, 0.7)}</g>${sparkles(8, 58, 95, '#f4e2ff')}`;
  },
  redstone() {
    const dust = Array.from({ length: 24 }, (_, i) => `<path d="M${pt(70, i * 15 - 4)}A70 70 0 0 1 ${pt(70, i * 15 + 4)}" stroke="#ff2a1a" stroke-width="5" fill="none" stroke-linecap="round"/>`).join('');
    return `<defs>${glow('g', 3)}</defs>${ring(70, 10, '#2d0603')}<g class="pulse" filter="url(#g)">${dust}</g>${ring(70, 1.5, '#ffb3a6aa')}
      <g transform="translate(100 18)" filter="url(#g)"><rect x="-3" y="2" width="6" height="22" fill="#6b4a2a"/><rect x="-5" y="-6" width="10" height="10" fill="#ff2a1a" class="pulse"/><rect x="-2.5" y="-3.5" width="5" height="5" fill="#ffd0c8"/></g>${sparkles(5, 60, 92, '#ff8a7a', 3)}`;
  },
  frostbite() {
    const spikes = Array.from({ length: 20 }, (_, i) => { const deg = i * 18; const h = 8 + (i % 3) * 6; return `<polygon points="${pt(73, deg - 5)} ${pt(73 + h, deg)} ${pt(73, deg + 5)}" fill="url(#ic)" stroke="#e9fbff" stroke-width=".6"/>`; }).join('');
    return `<defs>${lin('ic', [[0, '#ffffff'], [0.5, '#a8e8ff'], [1, '#3a9fd6']])}${glow('g', 2.5)}</defs>
      <g filter="url(#g)">${spikes}</g>${ring(70, 8, '#0d3a57')}${ring(70, 5, 'url(#ic)', 'filter="url(#g)"')}${sweep(70, 5, '#ffffff', 30)}${sparkles(10, 60, 96, '#ffffff', 3.5)}`;
  },
  'golden-champion'() {
    const laurel = (s) => Array.from({ length: 7 }, (_, i) => { const deg = 180 + s * (32 + i * 17); const [x, y] = polar(80, deg); return `<ellipse cx="${f(x)}" cy="${f(y)}" rx="4.2" ry="9" fill="url(#gc)" stroke="#7a5200" stroke-width=".8" transform="rotate(${deg + s * 35} ${f(x)} ${f(y)})"/>`; }).join('');
    const rays = Array.from({ length: 12 }, (_, i) => `<path d="M100 172L${f(100 + 13 * Math.cos(i * Math.PI / 6))} ${f(172 + 13 * Math.sin(i * Math.PI / 6))}" stroke="#fff1b3" stroke-width="2"/>`).join('');
    return `<defs>${lin('gc', [[0, '#fff6c9'], [0.45, '#f5c542'], [1, '#9a6a00']])}${glow('g', 3)}</defs>
      ${ring(70, 11, '#4d3300')}${ring(70, 7, 'url(#gc)', 'filter="url(#g)"')}${ring(64, 1.3, '#fff6c9')}${ring(76, 1.3, '#b98a1a')}${sweep(70, 7, '#fffbe6', 45)}
      ${laurel(-1)}${laurel(1)}<g filter="url(#g)" class="pulse"><circle cx="100" cy="172" r="12" fill="url(#gc)" stroke="#7a5200" stroke-width="1.5"/>${rays}<circle cx="100" cy="172" r="6" fill="#fffbe6"/></g>
      <polygon points="100,14 106,26 100,22 94,26" fill="url(#gc)" filter="url(#g)"/>${sparkles(7, 60, 96, '#fff3c0')}`;
  },
  donut() {
    const sprinkleColors = ['#ff5fa2', '#5fd2ff', '#ffe35f', '#8cff6b', '#ffffff', '#b98cff'];
    const sprinkles = Array.from({ length: 30 }, (_, i) => { const [x, y] = polar(66 + rand() * 10, rand() * 360); return `<rect x="${f(x - 3)}" y="${f(y - 1)}" width="6" height="2.2" rx="1.1" fill="${sprinkleColors[i % sprinkleColors.length]}" transform="rotate(${f(rand() * 180)} ${f(x)} ${f(y)})"/>`; }).join('');
    const drips = Array.from({ length: 10 }, (_, i) => { const deg = i * 36 + 12; return `<path d="M${pt(78, deg - 6)}Q${pt(86 + (i % 3) * 3, deg)} ${pt(78, deg + 6)}" fill="#ff7ab6"/>`; }).join('');
    return `<defs>${lin('dd', [[0, '#e8a25a'], [1, '#9a5a22']])}${lin('df', [[0, '#ffb3d6'], [1, '#ff5fa2']])}${glow('g', 2)}</defs>
      ${ring(72, 18, 'url(#dd)')}${ring(71, 13, 'url(#df)')}${drips}<g class="spin-slow">${sprinkles}</g>${ring(62.5, 1.6, '#ffbf0f', 'filter="url(#g)"')}${ring(81, 1.6, '#ffbf0f', 'class="pulse" filter="url(#g)"')}`;
  },
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, draw] of Object.entries(designs)) {
  seed = 7 + name.length * 131;
  const body = draw().replace(/\n\s*/g, '');
  for (const [file, style] of [[`${name}.svg`, ANIM], [`${name}-static.svg`, STILL]]) {
    fs.writeFileSync(path.join(OUT, file), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><style>${style.replace(/\n/g, '')}</style>${body}</svg>\n`);
  }
}
console.log(`Wrote ${Object.keys(designs).length * 2} files to ${OUT}`);
