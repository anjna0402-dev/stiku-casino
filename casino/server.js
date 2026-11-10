// Stiku Casino server — zero dependencies. Run:  node server.js   (then open http://localhost:3000)
// The server rolls every game with its own secret seed and pays out itself; the browser only displays results.
// Env: PORT, MOD_HASH, MAX_BET (default 1000), MIN_WITHDRAW (default 2), MIN_DEPOSIT (default 0.3),
//      NOWPAYMENTS_API_KEY + NOWPAYMENTS_IPN_SECRET + PUBLIC_URL (optional automatic crypto deposits)
const { handleApi } = require('./db');
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, DATA = path.join(__dirname, 'data.json');
const MOD_HASH = process.env.MOD_HASH || crypto.createHash('sha256').update('stiku-mod:Choudhary@11').digest('hex');
const MAX_BET = +process.env.MAX_BET || 1000, MIN_BET = 0.01, MIN_WITHDRAW = +process.env.MIN_WITHDRAW || 2, MIN_DEPOSIT = +process.env.MIN_DEPOSIT || 0.3;
const NP_KEY = process.env.NOWPAYMENTS_API_KEY || '', NP_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || '', PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

let db = { users: {}, tokens: {}, codes: [], uses: {}, deposits: [], withdrawals: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch (e) {}
Object.values(db.users || {}).forEach(u => {
  if (!u || typeof u !== 'object') return;
  const n = Number(u.balance);
  u.balance = Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
});
let dirty = false; const save = () => { dirty = true; };
setInterval(() => { if (!dirty) return; dirty = false; try { fs.writeFileSync(DATA + '.tmp', JSON.stringify(db)); fs.renameSync(DATA + '.tmp', DATA); } catch (e) { console.error('save failed', e.message); } }, 1200);
process.on('SIGINT', () => { try { fs.writeFileSync(DATA, JSON.stringify(db)); } catch (e) {} process.exit(); });

const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const rhex = n => crypto.randomBytes(n).toString('hex');
const blank = () => ({ wagered: 0, bets: 0, wins: 0, payout: 0, biggest: { amt: 0, mult: 0, game: '' }, games: {}, daily: {}, curve: [0], hidden: false });
const day = (o = 0) => new Date(Date.now() - o * 864e5).toISOString().slice(0, 10);
const r2 = x => Math.round(x * 1e6) / 1e6, cents = x => Math.round(x * 100) / 100;
const safeNum = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
const normalizeBalance = u => {
  if (!u || typeof u !== 'object') return 0;
  const next = safeNum(u.balance, 0);
  u.balance = Math.round(next * 100) / 100;
  return u.balance;
};
const lastSeen = {}, fails = {}, tipTimes = {};

// ---------------- accounts / stats ----------------
function hashPw(pw, salt) { return crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32).toString('hex'); }
function ensureFair(u) { if (!u.fair || !u.fair.server) { u.fair = { server: rhex(32), client: rhex(8), nonce: 0 }; u.fair.hash = sha(u.fair.server); } }
function fairPub(u) { ensureFair(u); return { hash: u.fair.hash, client: u.fair.client, nonce: u.fair.nonce }; }
function publicMe(u) {
  const balance = normalizeBalance(u);
  return { name: u.name, balance: r2(balance), created: u.created, stats: u.stats, tips: u.tips.slice(-30), promos: u.promos.slice(-30), fair: fairPub(u), session: u.session ? { game: u.session.game, bet: r2(u.session.bet) } : null };
}
function players() {
  return Object.keys(db.users).map(k => { const u = db.users[k], s = u.stats, daily = {}; for (let i = 0; i < 7; i++) if (s.daily[day(i)]) daily[day(i)] = s.daily[day(i)];
    const balance = normalizeBalance(u);
    return { name: u.name, created: u.created, online: Date.now() - (lastSeen[k] || 0) < 8000, stats: { wagered: s.wagered, bets: s.bets, wins: s.wins, payout: s.payout, hidden: s.hidden, daily }, balance: r2(balance) };
  });
}
function doBet(u, game, amt) {
  normalizeBalance(u);
  const st = u.stats; u.balance -= amt; st.wagered += amt; st.bets++; st.daily[day()] = (st.daily[day()] || 0) + amt;
  const g = st.games[game] = st.games[game] || { wagered: 0, bets: 0, wins: 0, payout: 0 }; g.wagered += amt; g.bets++;
  st.curve.push(st.payout - st.wagered); if (st.curve.length > 61) st.curve.shift();
}
function doPay(u, game, amt, wager) {
  normalizeBalance(u);
  const st = u.stats; u.balance += amt; st.payout += amt; const g = st.games[game] = st.games[game] || { wagered: 0, bets: 0, wins: 0, payout: 0 }; g.payout += amt;
  if (amt > wager) { st.wins++; g.wins++; }
  const m = wager > 0 ? amt / wager : 0; if (amt > st.biggest.amt) st.biggest = { amt, mult: m, game };
  st.curve[st.curve.length - 1] = st.payout - st.wagered;
}

// ---------------- provably fair randomness ----------------
const blk = (ctx, i) => crypto.createHmac('sha256', ctx.server).update(`${ctx.client}:${ctx.nonce}:${i}`).digest();
const fAt = (b, o) => b.readUInt32BE(o) / 4294967296;
function beginRound(u) { ensureFair(u); const ctx = { server: u.fair.server, client: u.fair.client, nonce: u.fair.nonce }; u.fair.nonce++; u.fair.server = rhex(32); u.fair.hash = sha(u.fair.server); return ctx; }
const revealOf = ctx => ({ server: ctx.server, hash: sha(ctx.server), client: ctx.client, nonce: ctx.nonce });

// ---------------- game math (identical to what the page shows) ----------------
const RTP = { dice: .96, flip: .96, limbo: .7999, plinko: .7999, crash: .75, wheel: .75, keno: .75, towers: .75, special: .75, rps: .75, roulette: .75, hilo: .75, diamonds: .75, mines: .96 };
const PB = [1, 10, 45, 120, 210, 252, 210, 120, 45, 10, 1], RAW = [26, 9, 4, 1.4, .7, .4, .7, 1.4, 4, 9, 26];
const PS = .7999 / RAW.reduce((a, r, i) => a + r * PB[i] / 1024, 0), PM = RAW.map(r => r * PS);
const WHEEL = [0, 1, 0, 2, 0, .5, 0, 4, 0, 1, 0, 2, 0, .5, 0, 1, 0, 2, 0, 1];
const nCk = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; };
const KT = {}; for (let n = 1; n <= 5; n++) { const P = h => nCk(10, h) * nCk(30, n - h) / nCk(40, n), t = Math.max(1, Math.ceil(n / 2)), raw = []; for (let h = 0; h <= n; h++) raw.push(h >= t ? M[...]
const RED = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const RCOUNT = { red: 18, black: 18, even: 18, odd: 18, low: 18, high: 18, d1: 12, d2: 12, d3: 12, n: 1 };
const DCAT = { '5': ['Five of a kind', 50], '41': ['Four of a kind', 10], '32': ['Full house', 6], '311': ['Three of a kind', 3], '221': ['Two pair', 2], '2111': ['One pair', 0], '11111': ['No mat[...]
const dSig = a => { const c = {}; a.forEach(x => c[x] = (c[x] || 0) + 1); return Object.values(c).sort((x, y) => y - x).join(''); };
const DP = {}; for (let n = 0; n < 16807; n++) { let m = n; const a = []; for (let i = 0; i < 5; i++) { a.push(m % 7); m = Math.floor(m / 7); } const sg = dSig(a); DP[sg] = (DP[sg] || 0) + 1 / 168[...]
const DSC = .75 / Object.keys(DCAT).reduce((a, k) => a + DP[k] * DCAT[k][1], 0), DM = k => DCAT[k][1] * DSC;
const SPX = { W: [22, 20, 17, 13, 9, 5, 4, 3], LINES: [[1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2], [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 0, 0, 1], [1, 2[...]
  PAY: [[3.32, 9.96, 33.2], [3.32, 13.28, 39.84], [6.64, 19.92, 66.4], [9.96, 33.2, 132.8], [19.92, 66.4, 332], [33.2, 166, 1328]], SCAT: [6.64, 33.2, 166], FS: [8, 10, 12] };
function spPick(rand, reel) { const w = SPX.W.map((x, i) => (i === 6 && (reel === 0 || reel === 4)) ? 0 : x); let r = rand() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < 8; i++) { r -= w[i][...]
const spGrid = rand => [0, 1, 2, 3, 4].map(c => [0, 1, 2].map(() => spPick(rand, c)));
function spEval(g) {
  let mult = 0; const wins = [];
  SPX.LINES.forEach(ln => { const first = g[0][ln[0]]; if (first >= 6) return; let n = 1; while (n < 5) { const x = g[n][ln[n]]; if (x === first || x === 6) n++; else break; } if (n >= 3) { mult +[...]
  let sc = 0; const scCells = []; g.forEach((col, c) => col.forEach((x, r) => { if (x === 7) { sc++; scCells.push(c + '-' + r); } }));
  return { mult, wins, sc, scCells };
}
function spRound(rand) {
  const g = spGrid(rand), e = spEval(g), spins = [{ g, e, fs: 0 }]; let total = e.mult;
  if (e.sc >= 3) { const k = Math.min(5, e.sc) - 3, n = SPX.FS[k]; total += SPX.SCAT[k]; for (let i = 1; i <= n; i++) { const g2 = spGrid(rand), e2 = spEval(g2); e2.sc = 0; total += e2.mult * 2; s[...]
  return { total, spins };
}
const BJW = 1.476, BJB = BJW + 0.5, cv = r => Math.min(r, 10);
const hv = rs => { const h = rs.reduce((a, r) => a + cv(r), 0), a = rs.includes(1); return { h, a, b: (a && h + 10 <= 21) ? h + 10 : h }; };
const survive = (m, k) => { let p = 1; for (let i = 0; i < k; i++) p *= (25 - m - i) / (25 - i); return p; };
const minesMult = (m, k) => k === 0 ? 1 : (1 / survive(m, k)) * 0.96;
const twMult = k => .75 * Math.pow(1.5, k);

// single-shot games: return { mult (total return per unit bet), result }
function playOnce(game, p, ctx) {
  const b0 = blk(ctx, 0), f = fAt(b0, 0);
  switch (game) {
    case 'dice': { const t = Math.floor(+p.target), under = p.mode === 'under'; if (!(t >= 2 && t <= 98) || !['under', 'over'].includes(p.mode)) throw 'Bad dice settings.'; const chance = under ? [...
    case 'flip': { if (!['heads', 'tails'].includes(p.pick)) throw 'Pick heads or tails.'; const res = f < .5 ? 'heads' : 'tails'; return { mult: res === p.pick ? 1.92 : 0, result: { res } }; }
    case 'limbo': { const t = +p.target; if (!(t >= 1.01 && t <= 1000)) throw 'Target must be 1.01 - 1000.'; const x = .7999 / (1 - f); return { mult: x >= t ? t : 0, result: { x: Math.min(x, 1e6)[...]
    case 'plinko': { const path = [...b0.slice(0, 10)], slot = path.filter(v => v >= 128).length; return { mult: PM[slot], result: { slot, path } }; }
    case 'wheel': { const idx = Math.floor(f * 20); return { mult: WHEEL[idx], result: { idx } }; }
    case 'keno': {
      const picks = Array.isArray(p.picks) ? p.picks.map(Number) : []; if (picks.length < 1 || picks.length > 5 || new Set(picks).size !== picks.length || picks.some(n => !(n >= 1 && n <= 40 && Nu[...]
      const b = Buffer.concat([b0, blk(ctx, 1)]), t = [...Array(40).keys()];
      for (let i = 0; i < 10; i++) { const ff = fAt(b, i * 4), j = i + Math.floor(ff * (40 - i)); [t[i], t[j]] = [t[j], t[i]]; }
      const drawn = t.slice(0, 10).map(x => x + 1), hits = picks.filter(n => drawn.includes(n)).length; return { mult: KT[picks.length][hits] || 0, result: { drawn, hits } };
    }
    case 'special': { const fl = []; for (let i = 0; i < 26; i++) { const b = blk(ctx, i); for (let o = 0; o < 32; o += 4) fl.push(fAt(b, o)); } let ix = 0; const res = spRound(() => fl[ix++]); r[...]
    case 'rps': { const me = ['rock', 'paper', 'scissors'].indexOf(p.pick); if (me < 0) throw 'Pick rock, paper or scissors.'; const house = Math.floor(f * 3), win = (me - house + 3) % 3 === 1; r[...]
    case 'roulette': {
      const n = Math.floor(f * 37), t = p.rb; if (!RCOUNT[t]) throw 'Bad roulette bet.'; const rn = Math.floor(+p.rn);
      const win = t === 'red' ? RED.includes(n) : t === 'black' ? n > 0 && !RED.includes(n) : t === 'even' ? n > 0 && n % 2 === 0 : t === 'odd' ? n % 2 === 1 : t === 'low' ? n >= 1 && n <= 18 : t[...]
      if (t === 'n' && !(rn >= 0 && rn <= 36)) throw 'Number must be 0-36.'; return { mult: win ? .75 * 37 / RCOUNT[t] : 0, result: { n } };
    }
    case 'diamonds': { const a = []; for (let i = 0; i < 5; i++) a.push(Math.floor(fAt(b0, i * 4) * 7)); const sg = dSig(a); return { mult: DM(sg), result: { a, sg, label: DCAT[sg][0] } }; }
  }
  throw 'Unknown game.';
}

// ---------------- interactive games (state lives on the server) ----------------
function startSession(u, game, bet, p, ctx) {
  const S = { game, bet, ctx, wager: bet, t0: Date.now() };
  if (game === 'towers') { const b = blk(ctx, 0); S.bombs = []; for (let i = 0; i < 8; i++) S.bombs.push(Math.floor(fAt(b, i * 4) * 3)); S.row = 0; return { S, pub: { row: 0 } }; }
  if (game === 'hilo') { const b = Buffer.concat([blk(ctx, 0), blk(ctx, 1)]); S.cards = []; for (let i = 0; i < 16; i++) S.cards.push(Math.floor(fAt(b, i * 4) * 13) + 1); S.i = 0; S.raw = 1; retu[...]
  if (game === 'crash') { const x = Math.max(1, .75 / (1 - fAt(blk(ctx, 0), 0))); S.x = x; const a = parseFloat(p.auto); S.auto = a >= 1.01 ? a : 0; return { S, pub: { running: true } }; }
  if (game === 'mines') {
    const m = Math.floor(+p.mines); if (!(m >= 1 && m <= 24)) throw 'Mines must be 1-24.'; const b = Buffer.concat([blk(ctx, 0), blk(ctx, 1), blk(ctx, 2)]), f = []; for (let i = 0; i < 24; i++) f[...]
    const t = [...Array(25).keys()]; for (let i = 24; i > 0; i--) { const j = Math.floor(f[24 - i] * (i + 1)); [t[i], t[j]] = [t[j], t[i]]; }
    S.m = m; S.mines = t.slice(0, m); S.picked = []; return { S, pub: { m, picked: [] } };
  }
  if (game === 'blackjack') {
    const b = Buffer.concat([blk(ctx, 0), blk(ctx, 1), blk(ctx, 2)]); S.cards = []; for (let i = 0; i < 24; i++) S.cards.push(Math.floor(fAt(b, i * 4) * 13) + 1); S.ci = 0;
    const d = () => S.cards[S.ci++]; S.P = [d()]; S.Dl = [d()]; S.P.push(d()); S.Dl.push(d()); S.dbl = false;
    return { S, pub: bjPub(S, false) };
  }
  throw 'Unknown game.';
}
const bjPub = (S, reveal) => ({ P: S.P, up: S.Dl[0], Dl: reveal ? S.Dl : undefined });
const INTERACTIVE = ['towers', 'hilo', 'crash', 'mines', 'blackjack'];

// finish: pays the user, rotates nothing (seed already rotated at start), returns the response payload
function finish(u, S, mult, extra) {
  const pay = S.bet * mult, wager = S.wager; u.session = null;
  if (pay > 0) doPay(u, S.game, pay, wager);
  save(); return Object.assign({ done: true, pay: r2(pay), mult, balance: r2(normalizeBalance(u)), reveal: revealOf(S.ctx), fair: fairPub(u) }, extra || {});
}
function crashM(S) { return Math.exp(0.2 * (Date.now() - S.t0) / 1000); }
function act(u, a) {
  const S = u.session; if (!S) throw 'No active round.'; const g = S.game;
  if (g === 'towers') {
    if (a.action === 'cash') { if (S.row < 1) throw 'Pick a tile first.'; return finish(u, S, twMult(S.row), { bombs: S.bombs }); }
    const c = Math.floor(+a.pick); if (!(c >= 0 && c <= 2)) throw 'Bad tile.';
    if (S.bombs[S.row] === c) return finish(u, S, 0, { bombs: S.bombs, hit: c, row: S.row });
    S.row++; if (S.row === 8) return finish(u, S, twMult(8), { bombs: S.bombs, row: 8 }); save(); return { done: false, row: S.row, mult: twMult(S.row), balance: r2(normalizeBalance(u)) };
  }
  if (g === 'hilo') {
    if (a.action === 'cash') { if (S.i < 1) throw 'Make a guess first.'; return finish(u, S, .75 * S.raw, { cards: S.cards.slice(0, S.i + 1) }); }
    const r = S.cards[S.i], n = S.cards[S.i + 1], hi = a.guess === 'h', p = hi ? (13 - r) / 13 : (r - 1) / 13; if (!(p > 0) || !['h', 'l'].includes(a.guess)) throw 'That guess is impossible.';
    if (!(hi ? n > r : n < r)) return finish(u, S, 0, { card: n, cards: S.cards.slice(0, S.i + 2) });
    S.raw /= p; S.i++; if (S.i >= 15) return finish(u, S, .75 * S.raw, { card: n, cards: S.cards.slice(0, S.i + 1) }); save(); return { done: false, card: n, i: S.i, mult: .75 * S.raw, balance: r2(normalizeBalance(u)) };
  }
  if (g === 'crash') {
    const m = crashM(S);
    if (m >= S.x) return finish(u, S, 0, { crashed: true, x: S.x });
    if (S.auto && S.auto < S.x && m >= S.auto) return finish(u, S, S.auto, { x: S.x, cashed: S.auto });
    if (a.action === 'cash') { const c = Math.max(1, Math.floor(m * 100) / 100); return finish(u, S, c, { x: S.x, cashed: c }); }
    return { done: false, m, balance: r2(normalizeBalance(u)) };
  }
  if (g === 'mines') {
    if (a.action === 'cash') { if (!S.picked.length) throw 'Pick a tile first.'; return finish(u, S, minesMult(S.m, S.picked.length), { mines: S.mines, picked: S.picked }); }
    const t = Math.floor(+a.tile); if (!(t >= 0 && t <= 24) || S.picked.includes(t)) throw 'Bad tile.';
    if (S.mines.includes(t)) return finish(u, S, 0, { mines: S.mines, picked: S.picked, hit: t });
    S.picked.push(t); if (S.picked.length === 25 - S.m) return finish(u, S, minesMult(S.m, S.picked.length), { mines: S.mines, picked: S.picked });
    save(); return { done: false, picked: S.picked, mult: minesMult(S.m, S.picked.length), balance: r2(normalizeBalance(u)) };
  }
  if (g === 'blackjack') {
    const d = () => S.cards[S.ci++], f = S.dbl ? 2 : 1;
    const dealer = () => { while (hv(S.Dl).b < 17) S.Dl.push(d()); const ph = hv(S.P).b, dh = hv(S.Dl).b; if (dh > 21 || ph > dh) return finish(u, S, BJW * f, { P: S.P, Dl: S.Dl, text: 'You win' [...]
    if (a.action === 'stand') return dealer();
    if (a.action === 'hit') { S.P.push(d()); const x = hv(S.P).b; if (x > 21) return finish(u, S, 0, { P: S.P, Dl: S.Dl, text: 'Bust' }); if (x === 21) return dealer(); save(); return { done: fal[...]
    if (a.action === 'double') {
      if (S.P.length !== 2 || S.dbl) throw "You can only double on your first two cards."; if (S.bet > u.balance + 1e-9) throw 'Insufficient balance to double.';
      doBet(u, 'blackjack', S.bet); S.wager += S.bet; S.dbl = true; S.P.push(d()); if (hv(S.P).b > 21) return finish(u, S, 0, { P: S.P, Dl: S.Dl, text: 'Bust' }); return dealer();
    }
    throw 'Bad action.';
  }
  throw 'Bad action.';
}
// open round that the user walked away from: cash out if possible, otherwise it is a loss
function abandon(u) {
  const S = u.session; if (!S) return;
  try {
    if (S.game === 'towers' && S.row > 0) return act(u, { action: 'cash' }); if (S.game === 'hilo' && S.i > 0) return act(u, { action: 'cash' });
    if (S.game === 'mines' && S.picked.length) return act(u, { action: 'cash' }); if (S.game === 'crash') return act(u, { action: 'cash' }); if (S.game === 'blackjack') return act(u, { action: 'sta[...]
  } catch (e) {}
  finish(u, S, 0, {});
}
// blackjack naturals are settled right at the deal
function bjNatural(u, S) { const pn = hv(S.P).b === 21, dn = hv(S.Dl).b === 21; if (!pn && !dn) return null; return finish(u, S, dn ? (pn ? 1 : 0) : BJB, { P: S.P, Dl: S.Dl, text: dn ? (pn ? 'Push' : 'Dealer wins') : 'You win' }); }

// ---------------- http plumbing ----------------
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 20000) { no(new Error('big')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { ok({}); } }); });
const authUser = req => { const t = (req.headers.authorization || '').replace('Bearer ', ''), k = db.tokens[t]; return k && db.users[k] ? { k, u: db.users[k], t } : null; };
const isMod = req => req.headers['x-mod'] === MOD_HASH;
const num = (v, min, max) => { v = Number(v); return Number.isFinite(v) && v >= min && v <= max ? v : null; };
const sortStr = o => Array.isArray(o) ? o.map(sortStr) : (o && typeof o === 'object') ? Object.keys(o).sort().reduce((a, k) => (a[k] = sortStr(o[k]), a), {}) : o;
const needUser = (req, res) => { const a = authUser(req); if (!a) send(res, 401, { error: 'Not logged in.' }); return a; };
const balloons = {};

const routes = {
  'POST /api/register': async (req, res, b) => {
    const name = String(b.name || '').trim(), pw = String(b.pw || ''), k = name.toLowerCase();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return send(res, 400, { error: 'Username: 3-16 letters, numbers or _.' });
    if (pw.length < 6 || pw.length > 100) return send(res, 400, { error: 'Password must be at least 6 characters.' });
    if (db.users[k]) return send(res, 400, { error: 'That username is taken.' });
    const salt = rhex(16); db.users[k] = { name, salt, hash: hashPw(pw, salt), balance: 0, created: Date.now(), stats: blank(), tips: [], deposits: [], promos: [], notes: [], session: null };
    ensureFair(db.users[k]); const t = rhex(24); db.tokens[t] = k; lastSeen[k] = Date.now(); save(); send(res, 200, { token: t, me: publicMe(db.users[k]) });
  },
  'POST /api/login': async (req, res, b) => {
    const k = String(b.name || '').trim().toLowerCase(), ip = req.socket.remoteAddress, f = fails[ip] || { n: 0, t: Date.now() };
    if (Date.now() - f.t > 300000) { f.n = 0; f.t = Date.now(); } if (f.n >= 10) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const u = db.users[k];
    if (!u || !crypto.timingSafeEqual(Buffer.from(hashPw(String(b.pw || ''), u.salt), 'hex'), Buffer.from(u.hash, 'hex'))) { f.n++; fails[ip] = f; return send(res, 401, { error: 'Wrong username or password.' }); }
    normalizeBalance(u); const t = rhex(24); db.tokens[t] = k; lastSeen[k] = Date.now(); save(); send(res, 200, { token: t, me: publicMe(u) });
  },
  'POST /api/logout': async (req, res) => { const a = authUser(req); if (a) { delete db.tokens[a.t]; delete lastSeen[a.k]; save(); } send(res, 200, { ok: true }); },
  'GET /api/state': async (req, res) => {
    const a = needUser(req, res); if (!a) return; const u = a.u; lastSeen[a.k] = Date.now(); const notes = u.notes.splice(0); if (notes.length) save();
    let balloon = null; const B = balloons[a.k];
    if (B && !B.sent) { B.sent = Date.now(); } if (B && B.sent) { if (Date.now() - B.sent > 15000) delete balloons[a.k]; else balloon = { id: B.id, amt: B.amt }; }
    if (!balloons[a.k] && Date.now() - (u.lastBalloon || 0) > 110000 && Math.random() < 0.03) { u.lastBalloon = Date.now(); balloons[a.k] = { id: rhex(6), amt: [0.01, 0.02, 0.03][Math.floor(Math.random() * 3)] }; }
    normalizeBalance(u); send(res, 200, { me: publicMe(u), players: players(), notes, balloon, cfg: { minWithdraw: MIN_WITHDRAW, minDeposit: MIN_DEPOSIT, autoDeposit: !!(NP_KEY && NP_SECRET && PUBLIC_URL), maxBet: MAX_BET, minBet: MIN_BET } });
  },
  'POST /api/balloon/claim': async (req, res, b) => {
    const a = needUser(req, res); if (!a) return; const B = balloons[a.k];
    if (!B || B.id !== b.id || !B.sent || Date.now() - B.sent > 15000) return send(res, 400, { error: 'Too late.' });
    delete balloons[a.k]; a.u.balance += B.amt; normalizeBalance(a.u); save(); send(res, 200, { balance: r2(a.u.balance), amt: B.amt });
  },
  'POST /api/hide': async (req, res, b) => { const a = needUser(req, res); if (!a) return; a.u.stats.hidden = !!b.hidden; save(); send(res, 200, { ok: true }); },
  'POST /api/fair/client': async (req, res, b) => {
    const a = needUser(req, res); if (!a) return; if (a.u.session) return send(res, 400, { error: 'Finish your current round first.' });
    const c = String(b.client || '').slice(0, 32).replace(/[^\w\-.]/g, ''); if (!c) return send(res, 400, { error: 'Bad client seed.' }); ensureFair(a.u); a.u.fair.client = c; save(); send(res, 200, { ok: true, fair: fairPub(a.u) });
  },
  // ---- games ----
  'POST /api/game/play': async (req, res, b) => {
    const a = needUser(req, res); if (!a) return; const u = a.u, game = String(b.game || '');
    try {
      if (INTERACTIVE.includes(game) || !RTP[game]) throw 'Unknown game.'; if (u.session) abandon(u);
      const amt = num(cents(Number(b.bet)), MIN_BET, MAX_BET); if (amt === null) throw `Bet must be between $${MIN_BET} and $${MAX_BET}.`; if (amt > normalizeBalance(u) + 1e-9) throw 'Insufficient balance.';
      const ctx0 = { server: u.fair.server, client: u.fair.client, nonce: u.fair.nonce }; const out = playOnce(game, b.params || {}, ctx0);   // validate before charging
      const ctx = beginRound(u); doBet(u, game, amt); const pay = amt * out.mult; if (pay > 0) doPay(u, game, pay, amt); save();
      send(res, 200, { pay: r2(pay), mult: out.mult, result: out.result, balance: r2(normalizeBalance(u)), reveal: revealOf(ctx), fair: fairPub(u) });
    } catch (e) { if (typeof e === 'string') return send(res, 400, { error: e }); throw e; }
  },
  'POST /api/game/start': async (req, res, b) => {
    const a = needUser(req, res); if (!a) return; const u = a.u, game = String(b.game || '');
    try {
      if (!INTERACTIVE.includes(game)) throw 'Unknown game.'; if (u.session) abandon(u);
      const amt = num(cents(Number(b.bet)), MIN_BET, MAX_BET); if (amt === null) throw `Bet must be between $${MIN_BET} and $${MAX_BET}.`; if (amt > normalizeBalance(u) + 1e-9) throw 'Insufficient balance.';
      const ctx0 = { server: u.fair.server, client: u.fair.client, nonce: u.fair.nonce }; startSession(u, game, amt, b.params || {}, ctx0);   // validate params
      const ctx = beginRound(u), { S, pub } = startSession(u, game, amt, b.params || {}, ctx); doBet(u, game, amt); u.session = S; save();
      if (game === 'blackjack') { const n = bjNatural(u, S); if (n) return send(res, 200, n); }
      send(res, 200, { done: false, state: pub, balance: r2(normalizeBalance(u)), fair: fairPub(u) });
    } catch (e) { if (typeof e === 'string') return send(res, 400, { error: e }); throw e; }
  },
  'POST /api/game/act': async (req, res, b) => {
    const a = needUser(req, res); if (!a) return;
    try { send(res, 200, act(a.u, b)); } catch (e) { if (typeof e === 'string') return send(res, 400, { error: e }); throw e; }
  },
  // ---- social / wallet ----
  'POST /api/tip': async (req, res, b) => {
    const a = needUser(req, res); if (!a) return;
    const to = String(b.to || '').trim().toLowerCase(), amt = num(cents(Number(b.amt)), 0.1, 100000), note = String(b.note || '').slice(0, 40).replace(/[<>&"]/g, '');
    if (!to) return send(res, 400, { error: 'Enter a username.' }); if (!db.users[to]) return send(res, 400, { error: 'No player with that username.' });
    if (to === a.k) return send(res, 400, { error: "You can't tip yourself." }); if (amt === null) return send(res, 400, { error: 'Tip must be between $0.10 and $100,000.' });
    if (amt > normalizeBalance(a.u) + 1e-9) return send(res, 400, { error: 'Insufficient balance.' });
    const tt = (tipTimes[a.k] = (tipTimes[a.k] || []).filter(x => Date.now() - x < 60000)); if (tt.length >= 10) return send(res, 429, { error: 'Slow down — max 10 tips per minute.' }); tt.push(Date.now());
    const r = db.users[to], now = Date.now(); a.u.balance -= amt; r.balance += amt; normalizeBalance(a.u); normalizeBalance(r);
    a.u.tips.push({ dir: 'out', who: r.name, amt, t: now }); r.tips.push({ dir: 'in', who: a.u.name, amt, t: now }); r.notes.push(`💸 ${a.u.name} tipped you $${amt.toFixed(2)}${note ? ' — ' + note : ''}`);
    save(); send(res, 200, { balance: r2(a.u.balance), me: publicMe(a.u), message: `Sent $${amt.toFixed(2)} to ${r.name}!` });
  },
  'POST /api/promo': async (req, res, b) => {
    const a = needUser(req, res); if (!a) return; const code = String(b.code || '').toUpperCase().replace(/\s+/g, ''), c = db.codes.find(x => x.code === code);
    if (!c) return send(res, 400, { error: 'Invalid promo code.' }); if (a.u.promos.some(p => p.h === code)) return send(res, 400, { error: 'You already redeemed this code.' });
    if ((db.uses[code] || 0) >= c.maxUses) return send(res, 400, { error: 'This code has reached its usage limit.' });
    db.uses[code] = (db.uses[code] || 0) + 1; a.u.balance += c.amount; a.u.promos.push({ h: code, amt: c.amount, t: Date.now() }); normalizeBalance(a.u); save(); send(res, 200, { amount: c.amount, balance: r2(a.u.balance), me: publicMe(a.u) });
  },
  'POST /api/deposit/request': async (req, res, b) => {   // manual deposit: the player says they paid; a moderator confirms and credits it
    const a = needUser(req, res); if (!a) return; const amt = num(cents(Number(b.amount)), MIN_DEPOSIT, 100000), note = String(b.note || '').slice(0, 120).replace(/[<>&"]/g, '');
    if (amt === null) return send(res, 400, { error: `Minimum deposit is $${MIN_DEPOSIT}.` }); if (db.deposits.filter(d => d.user === a.k && d.status === 'pending').length >= 3) return send(res, 400, { error: 'You already have 3 pending deposits.' });
    db.deposits.push({ id: rhex(5), user: a.k, name: a.u.name, amount: amt, method: 'manual', note, status: 'pending', created: Date.now() }); save(); send(res, 200, { message: 'Deposit request sent for review.' });
  },
  'POST /api/deposit/create': async (req, res, b) => {   // automatic deposit via NOWPayments (crypto) — credited by the webhook below
    const a = needUser(req, res); if (!a) return; if (!(NP_KEY && NP_SECRET && PUBLIC_URL)) return send(res, 400, { error: 'Automatic deposits are not set up on this server. Use a deposit request instead.' });
    const amt = num(cents(Number(b.amount)), MIN_DEPOSIT, 100000); if (amt === null) return send(res, 400, { error: `Minimum deposit is $${MIN_DEPOSIT}.` });
    const dep = { id: rhex(8), user: a.k, name: a.u.name, amount: amt, method: 'auto', note: '', status: 'pending', created: Date.now() };
    try {
      const r = await fetch('https://api.nowpayments.io/v1/invoice', { method: 'POST', headers: { 'x-api-key': NP_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ price_amount: amt, price_currency: 'USD', pay_currency: 'btc', ipn_callback_url: PUBLIC_URL + '/api/deposit/webhook', order_id: dep.id, order_description: 'Stiku Casino deposit' }) });
      const j = await r.json(); if (!r.ok || !j.invoice_url) return send(res, 502, { error: 'Payment provider error: ' + (j.message || r.status) });
      db.deposits.push(dep); save(); send(res, 200, { url: j.invoice_url, id: dep.id });
    } catch (e) { send(res, 502, { error: 'Could not reach the payment provider.' }); }
  },
  'POST /api/deposit/webhook': async (req, res, b) => {  // called by NOWPayments; the signature proves it is genuine
    if (!NP_SECRET) return send(res, 400, { error: 'off' });
    const sig = String(req.headers['x-nowpayments-sig'] || ''), mine = crypto.createHmac('sha512', NP_SECRET).update(JSON.stringify(sortStr(b))).digest('hex');
    if (sig.length !== mine.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mine))) return send(res, 401, { error: 'bad signature' });
    const d = db.deposits.find(x => x.id === String(b.order_id) && x.method === 'auto');
    if (d && d.status === 'pending' && b.payment_status === 'finished') { const u = db.users[d.user]; if (u) { u.balance += d.amount; normalizeBalance(u); u.notes.push(`💰 Deposit of $${d.amount.toFixed(2)} confirmed`); d.status = 'paid'; save(); } }
    else if (d && d.status === 'pending' && ['failed', 'expired', 'refunded'].includes(b.payment_status)) { d.status = 'rejected'; save(); }
    send(res, 200, { ok: true });
  },
  'POST /api/withdraw': async (req, res, b) => {
    const a = needUser(req, res); if (!a) return; if (a.u.session) return send(res, 400, { error: 'Finish your current round first.' });
    const amt = num(cents(Number(b.amount)), MIN_WITHDRAW, 1e6), dest = String(b.dest || '').trim().slice(0, 150).replace(/[<>&"]/g, '');
    if (amt === null) return send(res, 400, { error: `Minimum withdrawal is $${MIN_WITHDRAW}.` }); if (dest.length < 3) return send(res, 400, { error: 'Enter where to send the money (crypto address or bank details).' });
    if (amt > normalizeBalance(a.u) + 1e-9) return send(res, 400, { error: 'Insufficient balance.' });
    if (db.withdrawals.filter(w => w.user === a.k && w.status === 'pending').length >= 3) return send(res, 400, { error: 'You already have 3 pending withdrawals.' });
    a.u.balance -= amt; db.withdrawals.push({ id: rhex(5), user: a.k, name: a.u.name, amount: amt, dest, status: 'pending', created: Date.now() }); normalizeBalance(a.u); save();
    send(res, 200, { message: `Withdrawal of $${amt.toFixed(2)} requested. A moderator will pay it manually.`, balance: r2(a.u.balance), me: publicMe(a.u) });
  },
  // ---- moderator (header x-mod = hash of the moderator key) ----
  'GET /api/mod/state': async (req, res) => {
    if (!isMod(req)) return send(res, 403, { error: 'Wrong moderator key.' }); const users = {}, online = {};
    Object.keys(db.users).forEach(k => { const { salt, hash, notes, fair, session, ...rest } = db.users[k]; users[k] = rest; online[k] = Date.now() - (lastSeen[k] || 0) < 8000; });
    send(res, 200, { users, online, codes: db.codes.map(c => ({ ...c, used: db.uses[c.code] || 0 })), deposits: db.deposits.slice(-100).reverse(), withdrawals: db.withdrawals.slice(-100).reverse() });
  },
  'POST /api/mod/deposit': async (req, res, b) => {
    if (!isMod(req)) return send(res, 403, { error: 'Wrong moderator key.' }); const k = String(b.name || '').trim().toLowerCase(), amt = num(cents(Number(b.amt)), 0.01, 100000), u = db.users[k];
    if (!u) return send(res, 400, { error: 'No account with that username.' }); if (amt === null) return send(res, 400, { error: 'Enter an amount between $0.01 and $100,000.' });
    u.balance += amt; normalizeBalance(u); u.deposits.push({ amt, t: Date.now() }); u.notes.push(`💰 $${amt.toFixed(2)} deposited to your account`); save(); send(res, 200, { message: `Credited $${amt.toFixed(2)} to ${u.name}.` });
  },
  'POST /api/mod/deposit-approve': async (req, res, b) => {
    if (!isMod(req)) return send(res, 403, { error: 'Wrong moderator key.' }); const d = db.deposits.find(x => x.id === b.id); if (!d || d.status !== 'pending') return send(res, 400, { error: 'Invalid or already processed deposit.' });
    const u = db.users[d.user]; if (!u) return send(res, 400, { error: 'Account missing.' }); u.balance += d.amount; normalizeBalance(u); u.deposits.push({ amt: d.amount, t: Date.now() }); u.notes.push(`💰 Deposit of $${d.amount.toFixed(2)} approved`); d.status = 'paid'; save(); send(res, 200, { message: `Credited $${d.amount.toFixed(2)} to ${d.name}.` });
  },
  'POST /api/mod/deposit-reject': async (req, res, b) => { if (!isMod(req)) return send(res, 403, { error: 'Wrong moderator key.' }); const d = db.deposits.find(x => x.id === b.id); if (!d || d.status !== 'pending') return send(res, 400, { error: 'Invalid or already processed deposit.' }); d.status = 'rejected'; save(); send(res, 200, { message: 'Deposit rejected.' }); },
  'POST /api/mod/withdraw-paid': async (req, res, b) => {
    if (!isMod(req)) return send(res, 403, { error: 'Wrong moderator key.' }); const w = db.withdrawals.find(x => x.id === b.id); if (!w || w.status !== 'pending') return send(res, 400, { error: 'Invalid or already processed withdrawal.' });
    w.status = 'paid'; w.paidAt = Date.now(); w.txid = String(b.txid || '').slice(0, 100).replace(/[<>&"]/g, ''); const u = db.users[w.user]; if (u) u.notes.push(`✅ Your withdrawal of $${w.amount.toFixed(2)} was paid`); save(); send(res, 200, { message: `Marked withdrawal ${w.id} as paid.` });
  },
  'POST /api/mod/withdraw-reject': async (req, res, b) => {
    if (!isMod(req)) return send(res, 403, { error: 'Wrong moderator key.' }); const w = db.withdrawals.find(x => x.id === b.id); if (!w || w.status !== 'pending') return send(res, 400, { error: 'Invalid or already processed withdrawal.' });
    w.status = 'rejected'; const u = db.users[w.user]; if (u) { u.balance += w.amount; normalizeBalance(u); u.notes.push(`↩️ Your withdrawal of $${w.amount.toFixed(2)} was rejected and refunded`); } save(); send(res, 200, { message: `Rejected withdrawal ${w.id}.` });
  },
  'POST /api/mod/promo': async (req, res, b) => {
    if (!isMod(req)) return send(res, 403, { error: 'Wrong moderator key.' }); const code = String(b.code || '').trim().toUpperCase(), amt = num(cents(Number(b.amount)), 0.01, 100000), max = Math.max(1, Number(b.maxUses) || 1);
    if (!code) return send(res, 400, { error: 'Enter a promo code.' }); if (!/^[A-Z0-9_-]{3,20}$/.test(code)) return send(res, 400, { error: 'Code: 3-20 letters, numbers, - or _.' }); if (amt === null) return send(res, 400, { error: 'Enter a valid amount.' });
    if (db.codes.some(c => c.code === code)) return send(res, 400, { error: 'That code already exists.' }); db.codes.push({ code, amount: amt, maxUses: max, created: Date.now() }); save(); send(res, 200, { message: `Promo ${code} created.` });
  },
  'POST /api/mod/promo-delete': async (req, res, b) => { if (!isMod(req)) return send(res, 403, { error: 'Wrong moderator key.' }); db.codes = db.codes.filter(c => c.code !== b.code); save(); send(res, 200, { ok: true }); },
  'POST /api/mod/reset-stats': async (req, res) => { if (!isMod(req)) return send(res, 403, { error: 'Wrong moderator key.' }); Object.values(db.users).forEach(u => { u.stats = blank(); }); save(); send(res, 200, { ok: true }); }
};

http.createServer(async (req, res) => {
  if (handleApi(req, res)) return;
  try {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/casino.html')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(path.join(__dirname, 'casino.html'), 'utf8')); }
    if (url === '/api/ping') return send(res, 200, { ok: true, v: 2 });
    const h = routes[req.method + ' ' + url]; if (!h) return send(res, 404, { error: 'Not found' });
    await h(req, res, req.method === 'POST' ? await readBody(req) : {});
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: 'Server error' }); }
}).listen(PORT, () => console.log('Stiku Casino running on http://localhost:' + PORT));
