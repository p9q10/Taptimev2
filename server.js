// TimeTap Online – Single File Server
// Paste this as server.js on Glitch.com
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

// ═══ GAME STATE ═══
const rooms = new Map();
const sock2room = new Map();
const CH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function mkCode() { let c; do { c = Array.from({ length: 6 }, () => CH[Math.floor(Math.random() * CH.length)]).join(""); } while (rooms.has(c)); return c; }
function genTgt(r, iz) {
  if (iz) { const lo = r <= 2 ? 3 : r <= 5 ? 4 : 5, hi = r <= 2 ? 6 : r <= 5 ? 8 : 12; return Math.round((lo + Math.random() * (hi - lo)) * 10) / 10; }
  const lo = r <= 2 ? 1.5 : r <= 5 ? 2 : 3, hi = r <= 2 ? 3.5 : r <= 5 ? 6 : 9;
  return Math.round((lo + Math.random() * (hi - lo)) * 10) / 10;
}
function pub(room) {
  return { code: room.code, mode: room.mode, status: room.status,
    players: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, host: p.host, elim: p.elim })),
    round: room.round, totalRounds: room.totalRounds,
    target: room.mode === "zeit" ? null : room.target,
    submitted: room.subs ? Object.keys(room.subs).length : 0,
    activeCount: room.players.filter(p => !p.elim).length };
}
function bc(code) { const r = rooms.get(code); if (r) io.to(code).emit("state", pub(r)); }

// ═══ SOCKET LOGIC ═══
io.on("connection", (socket) => {
  socket.on("create", ({ name, avatar, mode, rounds }, cb) => {
    const c = mkCode();
    const room = { code: c, mode: mode || "normal", status: "lobby",
      players: [{ id: socket.id, name, avatar, host: true, elim: false }],
      round: 0, totalRounds: rounds || 3, target: 0, subs: {}, finalTimes: {},
      roles: {}, fakeUsedRound: false, sabUsedGame: false, fakeResolved: false, sabResolved: false,
      votes: {}, roundHistory: [] };
    rooms.set(c, room); socket.join(c); sock2room.set(socket.id, c);
    cb({ ok: true, code: c }); bc(c);
  });

  socket.on("join", ({ code: c, name, avatar }, cb) => {
    const room = rooms.get(c?.toUpperCase());
    if (!room) return cb({ ok: false, err: "Room not found" });
    if (room.status !== "lobby") return cb({ ok: false, err: "Game already started" });
    if (room.players.length >= 10) return cb({ ok: false, err: "Room full" });
    room.players.push({ id: socket.id, name, avatar, host: false, elim: false });
    socket.join(room.code); sock2room.set(socket.id, room.code);
    cb({ ok: true, code: room.code }); bc(room.code);
  });

  socket.on("start", () => {
    const c = sock2room.get(socket.id); const room = rooms.get(c); if (!room) return;
    const p = room.players.find(x => x.id === socket.id); if (!p?.host) return;
    if (room.players.length < 2) return;
    room.status = "playing"; room.round = 1; room.subs = {}; room.finalTimes = {};
    room.target = genTgt(1, room.mode === "zeit"); room.roundHistory = [];
    room.players.forEach(p => p.elim = false);
    if (room.mode === "trust") {
      room.roles = {}; room.sabUsedGame = false;
      const ids = room.players.map(p => p.id).sort(() => Math.random() - .5);
      room.players.forEach(p => room.roles[p.id] = "normal");
      if (ids.length >= 2) { room.roles[ids[0]] = "fake"; room.roles[ids[1]] = "saboteur"; }
      room.players.forEach(p => io.to(p.id).emit("role", { role: room.roles[p.id] }));
    }
    bc(c);
    io.to(c).emit("roundStart", { round: room.round, target: room.mode === "zeit" ? null : room.target });
    if (room.mode === "zeit") {
      const rnd = room.round;
      setTimeout(() => { if (room.status === "playing" && room.round === rnd) io.to(c).emit("zeitStop"); }, room.target * 1000);
    }
  });

  socket.on("submit", ({ time }) => {
    const c = sock2room.get(socket.id); const room = rooms.get(c); if (!room || room.status !== "playing") return;
    const p = room.players.find(x => x.id === socket.id); if (!p || p.elim) return;
    if (room.subs[socket.id] !== undefined) return;
    room.subs[socket.id] = time; room.finalTimes[socket.id] = time;
    const active = room.players.filter(x => !x.elim);
    bc(c);
    if (Object.keys(room.subs).length >= active.length) {
      if (room.mode === "trust") {
        room.status = "hidden"; room.fakeUsedRound = false; room.fakeResolved = false;
        room.sabResolved = room.sabUsedGame; bc(c);
        const fakeId = Object.entries(room.roles).find(([, r]) => r === "fake")?.[0];
        const sabId = Object.entries(room.roles).find(([, r]) => r === "saboteur")?.[0];
        if (fakeId) io.to(fakeId).emit("fakePrompt", { time: room.subs[fakeId] });
        else room.fakeResolved = true;
        if (sabId && !room.sabUsedGame) {
          io.to(sabId).emit("sabPrompt", { targets: room.players.filter(p => p.id !== sabId && !p.elim).map(p => ({ id: p.id, name: p.name })) });
        } else room.sabResolved = true;
        setTimeout(() => { if (room.status === "hidden") resolve(c); }, 12000);
        checkHidden(c);
      } else resolve(c);
    }
  });

  socket.on("fakeAct", ({ dir }) => {
    const c = sock2room.get(socket.id); const room = rooms.get(c); if (!room) return;
    if (room.roles[socket.id] !== "fake" || room.fakeResolved) return;
    const orig = room.subs[socket.id]; if (orig === undefined) return;
    room.finalTimes[socket.id] = orig + (dir === "plus" ? 0.4 : -0.4);
    room.fakeResolved = true; checkHidden(c);
  });
  socket.on("fakeSkip", () => { const c = sock2room.get(socket.id); const room = rooms.get(c); if (!room || room.roles[socket.id] !== "fake") return; room.fakeResolved = true; checkHidden(c); });
  socket.on("sabAct", ({ targetId }) => {
    const c = sock2room.get(socket.id); const room = rooms.get(c); if (!room) return;
    if (room.roles[socket.id] !== "saboteur" || room.sabUsedGame) return;
    const t = room.finalTimes[targetId]; if (t === undefined) return;
    room.finalTimes[targetId] = t + ((t - room.target) >= 0 ? 0.3 : -0.3);
    room.sabUsedGame = true; room.sabResolved = true; checkHidden(c);
  });
  socket.on("sabSkip", () => { const c = sock2room.get(socket.id); const room = rooms.get(c); if (!room || room.roles[socket.id] !== "saboteur") return; room.sabResolved = true; checkHidden(c); });

  socket.on("vote", ({ fakeGuess, sabGuess }) => {
    const c = sock2room.get(socket.id); const room = rooms.get(c);
    if (!room || room.status !== "voting") return;
    room.votes[socket.id] = { fake: fakeGuess, sab: sabGuess };
    if (Object.keys(room.votes).length >= room.players.length) {
      const fakeId = Object.entries(room.roles).find(([, r]) => r === "fake")?.[0];
      const sabId = Object.entries(room.roles).find(([, r]) => r === "saboteur")?.[0];
      const fV = Object.values(room.votes).filter(v => v.fake === fakeId).length;
      const sV = Object.values(room.votes).filter(v => v.sab === sabId).length;
      const maj = Math.ceil(room.players.length / 2);
      room.status = "reveal";
      io.to(c).emit("tbReveal", { roles: room.roles, fakeId, sabId, fakeFound: fV >= maj, sabFound: sV >= maj, normalWin: fV >= maj && sV >= maj, votes: room.votes, fV, sV, maj, history: room.roundHistory });
    }
  });

  socket.on("nextRound", () => {
    const c = sock2room.get(socket.id); const room = rooms.get(c); if (!room) return;
    const p = room.players.find(x => x.id === socket.id); if (!p?.host) return;
    const active = room.players.filter(x => !x.elim);
    if (room.mode === "trust" && room.round >= room.totalRounds) {
      room.status = "voting"; room.votes = {};
      io.to(c).emit("voteStart", { players: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar })) }); return;
    }
    if (active.length <= 1 || (room.mode !== "trust" && room.round >= room.totalRounds)) { endGame(c); return; }
    room.round++; room.subs = {}; room.finalTimes = {};
    room.target = genTgt(room.round, room.mode === "zeit");
    room.status = "playing"; room.fakeUsedRound = false; room.fakeResolved = false;
    room.sabResolved = room.sabUsedGame; bc(c);
    io.to(c).emit("roundStart", { round: room.round, target: room.mode === "zeit" ? null : room.target });
    if (room.mode === "zeit") {
      const rnd = room.round;
      setTimeout(() => { if (room.status === "playing" && room.round === rnd) io.to(c).emit("zeitStop"); }, room.target * 1000);
    }
  });

  socket.on("disconnect", () => {
    const c = sock2room.get(socket.id); if (!c) return;
    const room = rooms.get(c); if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) rooms.delete(c);
    else { if (!room.players.some(p => p.host)) room.players[0].host = true; bc(c); }
    sock2room.delete(socket.id);
  });
});

function checkHidden(c) { const room = rooms.get(c); if (!room || room.status !== "hidden") return; if (room.fakeResolved && room.sabResolved) resolve(c); }
function resolve(c) {
  const room = rooms.get(c); if (!room) return;
  const active = room.players.filter(p => !p.elim);
  const ft = room.finalTimes || room.subs;
  const results = active.map(p => {
    const time = ft[p.id] || room.subs[p.id] || 0;
    return { id: p.id, name: p.name, avatar: p.avatar, time: Math.round(time * 1000) / 1000, ms: Math.round(Math.abs(time - room.target) * 1000), elim: false };
  }).sort((a, b) => a.ms - b.ms);
  results.forEach((r, i) => r.rank = i + 1);
  if (room.mode !== "trust" && active.length > 2) { results[results.length - 1].elim = true; const wp = room.players.find(p => p.id === results[results.length - 1].id); if (wp) wp.elim = true; }
  room.roundHistory.push({ round: room.round, target: room.target, results });
  room.status = "results";
  io.to(c).emit("roundResults", { round: room.round, target: room.target, results });
}
function endGame(c) { const room = rooms.get(c); if (!room) return; room.status = "ended"; io.to(c).emit("gameEnd", { winner: room.players.filter(p => !p.elim)[0]?.name || "?", history: room.roundHistory }); }

// ═══ SERVE CLIENT ═══
app.get("/", (req, res) => { res.send(CLIENT_HTML); });
app.get("/health", (req, res) => res.json({ ok: true, rooms: rooms.size }));

const CLIENT_HTML = `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta name="apple-mobile-web-app-capable" content="yes"><title>TimeTap</title>
<script src="https://cdn.socket.io/4.7.4/socket.io.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:'SF Pro Display','Segoe UI',system-ui,sans-serif;background:#0B0B1E;color:#F1F0FF;min-height:100dvh;overflow-x:hidden}
#app{max-width:440px;margin:0 auto;padding:14px 16px 40px}
button{font-family:inherit;cursor:pointer;border:none;outline:none}
input{font-family:inherit;outline:none}
.c{background:#141432;border-radius:16px;border:1px solid #2D2D5E}
.b{border-radius:14px;padding:16px 36px;color:#fff;font-size:15px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;transition:transform .12s;background:linear-gradient(135deg,#8B5CF6,#EC4899);border:none;box-shadow:0 0 16px #8B5CF630}
.b:active{transform:scale(.94)}.b:disabled{opacity:.3}
.bs{padding:10px 18px;font-size:13px;border-radius:10px;letter-spacing:0;text-transform:none;font-weight:600;background:#1C1C42;border:1px solid #2D2D5E;box-shadow:none}
.bz{width:175px;height:175px;border-radius:50%;border:3px solid rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;margin:0 auto;transition:transform .3s;position:relative;z-index:1}
.bz span{color:#fff;font-size:16px;font-weight:900;letter-spacing:4px}
.bz-r{background:linear-gradient(135deg,#8B5CF6,#EC4899);box-shadow:0 0 24px #8B5CF630}
.bz-t{background:linear-gradient(135deg,#F97316,#F43F5E);box-shadow:0 0 24px #F43F5E30;animation:pulse .9s ease infinite}
.bz-d{background:linear-gradient(135deg,#5D5B7A,#555)}
.gt{background:linear-gradient(135deg,#8B5CF6,#EC4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.ag{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
.ab{aspect-ratio:1;border-radius:12px;font-size:22px;display:flex;align-items:center;justify-content:center;background:#1C1C42;border:1px solid #2D2D5E}.ab.s{background:#8B5CF630;border:2px solid #8B5CF6}
.mc{width:100%;padding:18px 20px;margin-bottom:12px;display:flex;align-items:center;gap:14px;text-align:left;border-radius:18px;border:none}
.mc:active{transform:scale(.97)}
.ct{text-align:center}.sb{color:#A5A3C8;font-size:12px}.mt{color:#5D5B7A}.mn{font-family:monospace}.fx{display:flex;gap:10px;justify-content:center}.mb{margin-bottom:14px}
#sd{position:fixed;top:8px;right:8px;width:10px;height:10px;border-radius:50%;z-index:9999;background:#F43F5E;transition:background .3s}
@keyframes pop{0%{transform:scale(.3);opacity:0}60%{transform:scale(1.06)}100%{transform:scale(1);opacity:1}}
@keyframes up{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes sL{from{transform:translateX(-14px);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes pulse{0%,100%{opacity:.6}50%{opacity:1}}
@keyframes cPop{0%{transform:scale(.5);opacity:0}50%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
@keyframes breathe{0%,100%{transform:scale(1);opacity:.35}50%{transform:scale(1.12);opacity:.75}}
@keyframes ripple{0%{transform:scale(.8);opacity:.5}100%{transform:scale(2);opacity:0}}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}
@keyframes conf{0%{transform:translateY(0) rotate(0);opacity:1}100%{transform:translateY(220px) rotate(720deg);opacity:0}}
@keyframes dotP{0%,80%,100%{opacity:.3}40%{opacity:1}}
</style></head><body><div id="sd"></div><div id="app"></div>
<script>
const V={v:"#8B5CF6",pk:"#EC4899",or:"#F97316",cy:"#06B6D4",am:"#F59E0B",em:"#10B981",ro:"#F43F5E"};
const AV=["😎","😀","🤖","🐯","🐸","🔥","🚀","👻","🧠","⚡"];
let _ac;const ac=()=>{if(!_ac)_ac=new(window.AudioContext||window.webkitAudioContext)();if(_ac.state==="suspended")_ac.resume();return _ac};
const bp=(f,d,w="sine",v=.18)=>{try{const c=ac(),o=c.createOscillator(),g=c.createGain();o.connect(g);g.connect(c.destination);o.type=w;o.frequency.value=f;g.gain.setValueAtTime(v,c.currentTime);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+d);o.start();o.stop(c.currentTime+d)}catch(_){}};
const sx={tap:()=>bp(880,.06),tick:()=>bp(660,.1,"square",.12),go:()=>{bp(880,.12,"square",.2);setTimeout(()=>bp(1100,.16,"square",.16),70)},good:()=>{bp(523,.1);setTimeout(()=>bp(659,.1),80);setTimeout(()=>bp(784,.16),160)},bad:()=>bp(380,.12,"sawtooth",.08),win:()=>{[523,659,784,1047,784,1047].forEach((f,i)=>setTimeout(()=>bp(f,.14),i*100))},drama:()=>{[200,250,300,350,400,500,600,800].forEach((f,i)=>setTimeout(()=>bp(f,.1,"triangle",.08+i*.02),i*100))}};
const vb=p=>{try{navigator.vibrate?.(p)}catch(_){}};

const so=io(location.origin,{transports:["websocket","polling"],reconnection:true,reconnectionAttempts:30,reconnectionDelay:1000});
let myId=null,st={},rc="",isH=false,myN="",myA=AV[0],myRole=null,t0=0,bst="ready";
so.on("connect",()=>{myId=so.id;document.getElementById("sd").style.background=V.em});
so.on("disconnect",()=>{document.getElementById("sd").style.background=V.ro});

function h(t,a,...ch){const e=document.createElement(t);if(a)Object.entries(a).forEach(([k,v])=>{if(k==="style"&&typeof v==="object")Object.assign(e.style,v);else if(k.startsWith("on"))e.addEventListener(k.slice(2).toLowerCase(),v);else e.setAttribute(k,v)});ch.flat().forEach(c=>{if(c!=null)e.appendChild(typeof c==="string"?document.createTextNode(c):c)});return e}
const $=id=>document.getElementById(id);
const R=el=>{const a=$("app");a.innerHTML="";if(typeof el==="string")a.innerHTML=el;else a.appendChild(el)};
function gr(ms){if(ms<=30)return{t:"PERFEKT!",c:V.am};if(ms<=100)return{t:"Stark!",c:V.em};if(ms<=250)return{t:"Gut!",c:V.v};if(ms<=500)return{t:"Knapp",c:"#A5A3C8"};return{t:"Daneben",c:V.ro}}
function md(r){return r===1?"🥇":r===2?"🥈":r===3?"🥉":"#"+r}

// ═══ HOME ═══
function home(){
  R(h("div",{style:{animation:"fadeIn .5s ease"}},
    h("div",{class:"ct"},h("div",{style:{fontSize:"50px",animation:"float 3s ease infinite",marginBottom:"4px"}},"⏱️"),
      h("h1",{class:"gt",style:{fontSize:"42px",fontWeight:"900",margin:"0 0 4px",lineHeight:"1.1"}},"TimeTap"),
      h("p",{style:{color:"#A5A3C8",fontSize:"14px",marginBottom:"24px"}},"Jeder spielt auf seinem Handy!")),
    ...["normal","zeit","trust"].map((m,i)=>{
      const c={normal:{ic:"🎯",t:"Normal",d:"Zielzeit sichtbar – wer trifft?",bg:"linear-gradient(135deg,#10B981,#06B6D4)"},
        zeit:{ic:"🧠",t:"Zeitgefühl",d:"Kein Timer – schätze die Zeit",bg:"linear-gradient(135deg,#8B5CF6,#EC4899)"},
        trust:{ic:"🕵️",t:"Trust Breaker",d:"Fake & Saboteur – wer lügt?",bg:"linear-gradient(135deg,#F43F5E,#F97316)"}}[m];
      return h("button",{class:"mc",style:{background:c.bg,animation:"sL .4s ease "+(i*.07)+"s both"},onClick:()=>{sx.tap();setup(m)}},
        h("div",{style:{fontSize:"28px"}},c.ic),
        h("div",null,h("div",{style:{fontSize:"17px",fontWeight:"800",color:"#fff"}},c.t),h("div",{style:{fontSize:"12px",color:"rgba(255,255,255,.75)"}},c.d)),
        h("div",{style:{marginLeft:"auto",fontSize:"20px",color:"rgba(255,255,255,.5)"}},"›"))
    })
  ))
}

// ═══ SETUP ═══
function setup(mode){
  let av=AV[0];
  const d=h("div",{style:{animation:"up .4s ease"}});
  d.appendChild(h("button",{class:"b bs",onClick:home,style:{marginBottom:"20px"}},"← Home"));
  d.appendChild(h("div",{class:"ct mb"},h("div",{style:{fontSize:"18px",fontWeight:"800"}},"Spieler einrichten"),
    h("div",{class:"sb"},(mode==="trust"?"4–6":"2–10")+" Spieler")));
  const ni=h("input",{placeholder:"Dein Name...",maxLength:"12",style:{width:"100%",background:"transparent",border:"none",borderBottom:"2px solid #2D2D5E",padding:"10px 0",color:"#F1F0FF",fontSize:"18px",fontWeight:"800",textAlign:"center"}});
  const ag=h("div",{class:"ag",style:{marginBottom:"10px"}});
  function ra(){ag.innerHTML="";AV.forEach(a=>{ag.appendChild(h("button",{class:"ab"+(av===a?" s":""),onClick:()=>{sx.tap();av=a;ra()}},a))})}
  ra();
  d.appendChild(h("div",{class:"c",style:{padding:"18px 20px",marginBottom:"14px"}},ni,
    h("div",{style:{fontSize:"10px",color:"#5D5B7A",letterSpacing:"2px",textTransform:"uppercase",textAlign:"center",margin:"16px 0 10px"}},"AVATAR WÄHLEN"),ag));
  // Create / Join buttons
  d.appendChild(h("div",{class:"fx",style:{marginTop:"10px"}},
    h("div",{class:"ct"},
      h("button",{style:{width:"80px",height:"80px",borderRadius:"50%",background:"linear-gradient(135deg,#10B981,#06B6D4)",fontSize:"28px",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 0 14px #10B98130"},onClick:()=>{
        const n=ni.value.trim();if(!n)return;sx.tap();myN=n;myA=av;isH=true;
        so.emit("create",{name:n,avatar:av,mode,rounds:3},r=>{if(r.ok){rc=r.code;lobby(mode)}else alert(r.err)})
      }},"+"),h("div",{style:{fontSize:"12px",color:"#A5A3C8",marginTop:"6px",fontWeight:"600"}},"Erstellen")),
    h("div",{class:"ct"},
      h("button",{style:{width:"80px",height:"80px",borderRadius:"50%",background:"linear-gradient(135deg,#38BDF8,#06B6D4)",fontSize:"28px",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 0 14px #38BDF830"},onClick:()=>{
        const n=ni.value.trim();if(!n)return;sx.tap();myN=n;myA=av;isH=false;joinCode(mode)
      }},"→"),h("div",{style:{fontSize:"12px",color:"#A5A3C8",marginTop:"6px",fontWeight:"600"}},"Beitreten"))
  ));
  R(d)
}

// ═══ JOIN CODE ═══
function joinCode(mode){
  const d=h("div",{class:"ct",style:{animation:"up .4s ease",paddingTop:"30px"}});
  d.appendChild(h("div",{style:{fontSize:"36px",marginBottom:"8px"}},"🔑"));
  d.appendChild(h("div",{style:{fontSize:"18px",fontWeight:"800",marginBottom:"14px"}},"Raum beitreten"));
  const inp=h("input",{placeholder:"CODE",maxLength:"6",style:{width:"100%",maxWidth:"260px",background:"#1C1C42",border:"2px solid #2D2D5E",borderRadius:"14px",padding:"16px",color:"#F1F0FF",fontSize:"26px",fontWeight:"900",fontFamily:"monospace",textAlign:"center",letterSpacing:"8px"}});
  inp.addEventListener("input",()=>{inp.value=inp.value.toUpperCase().replace(/[^A-Z0-9]/g,"");inp.style.borderColor=inp.value.length===6?V.v:"#2D2D5E"});
  d.appendChild(inp);
  const err=h("div",{style:{color:V.ro,fontSize:"12px",marginTop:"8px",minHeight:"18px"}});
  d.appendChild(err);
  d.appendChild(h("button",{class:"b",style:{marginTop:"8px",width:"100%",maxWidth:"260px"},onClick:()=>{
    if(inp.value.length<6)return;
    so.emit("join",{code:inp.value,name:myN,avatar:myA},r=>{
      if(r.ok){rc=r.code;lobby()}else{err.textContent=r.err||"Fehler";sx.bad()}
    })
  }},"BEITRETEN"));
  d.appendChild(h("button",{class:"b bs",style:{marginTop:"12px"},onClick:()=>setup(mode)},"← Zurück"));
  R(d)
}

// ═══ LOBBY ═══
function lobby(mode){
  const d=h("div",{class:"ct",style:{animation:"up .4s ease"}});
  const cb=h("button",{class:"c",style:{display:"inline-block",padding:"12px 28px",marginBottom:"16px",background:"#1C1C42",cursor:"pointer"},onClick:()=>{try{navigator.clipboard.writeText(rc);cb.querySelector(".cp").textContent="✓ Kopiert!";setTimeout(()=>cb.querySelector(".cp").textContent="📋 Antippen zum Kopieren",2000)}catch(_){}}},
    h("div",{style:{fontSize:"9px",color:"#5D5B7A",letterSpacing:"2px",textTransform:"uppercase"}},"RAUM-CODE"),
    h("div",{style:{fontSize:"34px",fontWeight:"900",color:V.am,fontFamily:"monospace",letterSpacing:"8px"}},rc),
    h("div",{class:"cp",style:{fontSize:"10px",color:V.v,marginTop:"2px"}},"📋 Antippen zum Kopieren"));
  d.appendChild(cb);
  const pl=h("div",{class:"c",style:{padding:"14px",marginBottom:"14px",textAlign:"left"},id:"pl"});
  d.appendChild(pl);
  let rn=3;
  if(isH){
    const rd=h("div",{class:"fx",style:{alignItems:"center",marginBottom:"14px"}},h("span",{style:{fontSize:"12px",color:"#A5A3C8"}},"Runden:"));
    [1,3,5].forEach(r=>{rd.appendChild(h("button",{style:{width:"38px",height:"38px",borderRadius:"10px",background:r===rn?"linear-gradient(135deg,#8B5CF6,#EC4899)":"#1C1C42",color:"#fff",fontWeight:"800",fontSize:"15px"},onClick:()=>{sx.tap();rn=r;rd.querySelectorAll("button").forEach((b,i)=>b.style.background=[1,3,5][i]===rn?"linear-gradient(135deg,#8B5CF6,#EC4899)":"#1C1C42")}},String(r)))});
    d.appendChild(rd)
  }
  d.appendChild(h("div",{style:{fontSize:"11px",color:"#A5A3C8",marginBottom:"14px",animation:"pulse 1.5s ease infinite"},id:"wt"},"Warte auf Spieler..."));
  if(isH)d.appendChild(h("button",{class:"b",style:{width:"100%",maxWidth:"300px"},id:"sb",onClick:()=>so.emit("start")},"SPIEL STARTEN"));
  else d.appendChild(h("div",{class:"c ct",style:{padding:"12px"}},h("div",{class:"sb"},"Warte auf den Host...")));
  R(d);upl()
}
function upl(){
  const el=$("pl");if(!el)return;el.innerHTML="";
  el.appendChild(h("div",{style:{fontSize:"10px",color:"#5D5B7A",letterSpacing:"2px",textTransform:"uppercase",marginBottom:"10px"}},"SPIELER ("+(st.players?.length||0)+")"));
  (st.players||[]).forEach((p,i)=>{
    el.appendChild(h("div",{style:{display:"flex",alignItems:"center",gap:"10px",padding:"10px 0",borderBottom:i<st.players.length-1?"1px solid #2D2D5E":"none"}},
      h("div",{style:{fontSize:"24px"}},p.avatar||"😎"),
      h("div",{style:{flex:"1"}},h("span",{style:{fontWeight:"700",fontSize:"14px"}},p.name),
        p.host?h("span",{style:{fontSize:"9px",color:V.am,marginLeft:"6px",fontWeight:"700",background:V.am+"20",padding:"2px 6px",borderRadius:"4px"}},"HOST"):null,
        p.id===myId?h("span",{style:{fontSize:"9px",color:V.v,marginLeft:"6px",fontWeight:"700",background:V.v+"20",padding:"2px 6px",borderRadius:"4px"}},"DU"):null)))
  });
  const sb=$("sb");if(sb)sb.disabled=(st.players?.length||0)<(st.mode==="trust"?4:2)
}

// ═══ BUZZER ═══
function buzzer(tgt){
  bst="ready";t0=0;
  const d=h("div",{class:"ct",style:{animation:"up .3s ease",paddingTop:"20px"}});
  d.appendChild(h("div",{class:"sb mb"},"Runde "+st.round));
  if(tgt!==null)d.appendChild(h("div",{class:"c",style:{display:"inline-block",padding:"12px 28px",borderLeft:"3px solid "+V.v,marginBottom:"16px"}},
    h("div",{style:{fontSize:"9px",color:"#5D5B7A",letterSpacing:"2px",textTransform:"uppercase"}},"ZIELZEIT"),
    h("div",{style:{fontSize:"44px",fontWeight:"900",fontFamily:"monospace"}},tgt.toFixed(1)+"s")));
  else d.appendChild(h("div",{style:{fontSize:"14px",color:V.cy,marginBottom:"16px"}},"Zielzeit ist versteckt"));
  const bz=h("button",{class:"bz bz-r",id:"bz",onClick:()=>{
    if(bst==="ready"){t0=Date.now();bst="timing";bz.className="bz bz-t";bz.querySelector("span").textContent="STOP";vb(25)}
    else if(bst==="timing"){const el=Math.max(.01,(Date.now()-t0)/1000);bst="done";bz.className="bz bz-d";bz.querySelector("span").textContent="✓";sx.tap();vb([50,25,50]);so.emit("submit",{time:el});
      setTimeout(()=>{d.appendChild(h("div",{class:"ct",style:{marginTop:"20px",animation:"fadeIn .3s ease"}},h("div",{style:{fontSize:"14px",color:"#A5A3C8",animation:"pulse 1.5s ease infinite"}},"Warte auf andere...")))},300)}
  }},h("span",null,"START"));
  d.appendChild(bz);R(d)
}

// ═══ ZEITGEFÜHL ═══
function zeitGo(){
  let c=3;
  const d=h("div",{class:"ct",style:{padding:"50px 0"}});
  const n=h("div",{style:{fontSize:"96px",fontWeight:"900",background:"linear-gradient(135deg,#6366F1,#8B5CF6)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",animation:"cPop .3s ease"}},"3");
  d.appendChild(h("div",{style:{fontSize:"10px",color:"#5D5B7A",letterSpacing:"3px",textTransform:"uppercase",marginBottom:"8px"}},"MACH DICH BEREIT"));
  d.appendChild(n);R(d);sx.tick();vb(10);
  const iv=setInterval(()=>{c--;
    if(c>0){n.textContent=c;n.style.animation="none";void n.offsetHeight;n.style.animation="cPop .3s ease";sx.tick();vb(10)}
    else if(c===0){n.textContent="JETZT!";n.style.background="linear-gradient(135deg,#10B981,#06B6D4)";n.style.WebkitBackgroundClip="text";sx.go();vb([50,25,50]);t0=Date.now()}
    else{clearInterval(iv);zeitRun()}
  },1000)
}
function zeitRun(){
  const d=h("div",{class:"ct",style:{padding:"40px 0",animation:"fadeIn .6s ease"}});
  d.appendChild(h("div",{style:{position:"relative",width:"150px",height:"150px",margin:"0 auto 18px"}},
    h("div",{style:{position:"absolute",inset:"0",borderRadius:"50%",border:"2px solid #06B6D422",animation:"ripple 2s ease infinite"}}),
    h("div",{style:{width:"150px",height:"150px",borderRadius:"50%",background:"radial-gradient(circle,#06B6D410,transparent 70%)",display:"flex",alignItems:"center",justifyContent:"center",animation:"breathe 3s ease infinite"}},
      h("div",{style:{width:"46px",height:"46px",borderRadius:"50%",background:"linear-gradient(135deg,#6366F1,#8B5CF6)",opacity:".5"}}))));
  d.appendChild(h("div",{style:{fontSize:"16px",fontWeight:"700",color:V.cy}},"Zähle mit..."));
  d.appendChild(h("div",{style:{fontSize:"12px",color:"#5D5B7A",marginTop:"4px",fontStyle:"italic"}},"Timer läuft seit \\"JETZT!\\""));
  R(d)
}
function zeitEst(){
  sx.good();vb([50,25,50]);
  const d=h("div",{class:"ct",style:{padding:"14px 0",animation:"up .4s ease"}});
  d.appendChild(h("div",{style:{fontSize:"60px",fontWeight:"900",background:"linear-gradient(135deg,#F97316,#F43F5E)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",marginBottom:"16px",animation:"pop .3s ease"}},"STOP!"));
  d.appendChild(h("div",{style:{fontSize:"18px",fontWeight:"800",marginBottom:"16px"}},"Wie lange war das?"));
  const inp=h("input",{type:"text",inputMode:"decimal",placeholder:"0.00",style:{width:"130px",textAlign:"center",fontSize:"42px",fontWeight:"900",color:"#F1F0FF",fontFamily:"monospace",border:"none",borderBottom:"3px solid #2D2D5E",background:"transparent",padding:"3px 0"}});
  inp.addEventListener("input",()=>{inp.value=inp.value.replace(/[^0-9.]/g,"");inp.style.borderBottomColor=inp.value?V.cy:"#2D2D5E"});
  d.appendChild(h("div",{class:"c",style:{display:"inline-block",padding:"18px 24px",borderTop:"3px solid "+V.cy,maxWidth:"240px"}},
    h("div",{style:{fontSize:"9px",color:"#5D5B7A",letterSpacing:"2px",textTransform:"uppercase",marginBottom:"6px"}},"DEINE SCHÄTZUNG"),
    h("div",{style:{display:"flex",alignItems:"baseline",justifyContent:"center",gap:"3px"}},inp,h("span",{style:{fontSize:"18px",color:"#5D5B7A"}},"s"))));
  const sb=h("button",{class:"b",style:{marginTop:"16px"},onClick:()=>{const g=parseFloat(inp.value);if(isNaN(g)||g<=0)return;sx.tap();so.emit("submit",{time:g});sb.disabled=true;sb.textContent="WARTET..."}},"ABGEBEN");
  d.appendChild(sb);R(d);setTimeout(()=>inp.focus(),120)
}

// ═══ RESULTS ═══
function results(data){
  const d=h("div",{style:{maxWidth:"380px",margin:"0 auto",animation:"up .3s ease"}});
  d.appendChild(h("div",{class:"ct mb"},h("div",{style:{fontSize:"11px",color:"#5D5B7A",letterSpacing:"3px",textTransform:"uppercase"}},"RUNDE "+data.round),
    h("div",{style:{fontSize:"12px",color:"#A5A3C8",marginTop:"4px"}},"Ziel: "+data.target.toFixed(1)+"s")));
  data.results.forEach((r,i)=>{const g=gr(r.ms);
    d.appendChild(h("div",{class:"c",style:{display:"flex",alignItems:"center",gap:"10px",padding:"11px 14px",marginBottom:"7px",borderLeft:"3px solid "+(r.elim?V.ro:g.c),background:r.elim?"#F43F5E15":"#141432",animation:"sL .4s ease "+i*.08+"s both"}},
      h("div",{style:{fontSize:"20px",width:"30px",textAlign:"center"}},r.elim?"💀":md(r.rank)),
      h("div",{style:{flex:"1"}},h("div",{style:{fontWeight:"700",fontSize:"13px",color:r.elim?V.ro:"#F1F0FF",textDecoration:r.elim?"line-through":"none"}},r.name+(r.id===myId?" (Du)":"")),
        h("div",{style:{fontSize:"11px",color:"#A5A3C8",fontFamily:"monospace"}},r.time.toFixed(3)+"s")),
      h("div",{style:{fontFamily:"monospace",fontWeight:"800",fontSize:"14px",color:g.c}},r.ms+"ms")))});
  const el=data.results.find(r=>r.elim);
  if(el)d.appendChild(h("div",{class:"ct",style:{color:V.ro,fontSize:"13px",fontWeight:"700",margin:"8px 0",animation:"shake .5s ease"}},"💀 "+el.name+" ist raus!"));
  if(isH)d.appendChild(h("div",{class:"ct",style:{marginTop:"14px"}},h("button",{class:"b",onClick:()=>so.emit("nextRound")},"WEITER")));
  else d.appendChild(h("div",{class:"ct",style:{marginTop:"14px",color:"#A5A3C8",fontSize:"12px",animation:"pulse 1.5s ease infinite"}},"Host drückt weiter..."));
  R(d);sx.good();vb(25)
}
function winner(data){
  const d=h("div",{class:"ct",style:{animation:"pop .5s ease",paddingTop:"30px"}});
  const cf=h("div",{style:{position:"fixed",inset:"0",pointerEvents:"none",overflow:"hidden",zIndex:"999"}});
  [V.v,V.pk,V.am,V.em,V.cy,V.or].forEach((c,_)=>{for(let i=0;i<5;i++){const x=h("div",null);x.style.cssText="position:absolute;top:-12px;left:"+Math.random()*100+"%;width:"+(5+Math.random()*8)+"px;height:"+(5+Math.random()*8)+"px;border-radius:"+(i%3===0?"50%":"2px")+";background:"+c+";animation:conf "+(1.2+Math.random()*1.3)+"s ease "+Math.random()*1.3+"s forwards";cf.appendChild(x)}});
  d.appendChild(cf);
  d.appendChild(h("div",{style:{fontSize:"60px",animation:"float 2s ease infinite",marginBottom:"8px"}},"🏆"));
  d.appendChild(h("div",{style:{fontSize:"28px",fontWeight:"900",background:"linear-gradient(135deg,#F59E0B,#FBBF24)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}},data.winner));
  d.appendChild(h("div",{style:{fontSize:"12px",color:"#A5A3C8",marginTop:"4px"}},"gewinnt!"));
  d.appendChild(h("button",{class:"b",style:{marginTop:"24px"},onClick:home},"HOME"));
  R(d);sx.win();vb([25,40,25,40,70])
}

// ═══ TRUST BREAKER ═══
function roleReveal(role){myRole=role;
  const rc=role==="fake"?V.or:role==="saboteur"?V.ro:V.em;
  const d=h("div",{class:"ct",style:{padding:"30px 16px",animation:"pop .4s ease"}});
  d.appendChild(h("div",{style:{fontSize:"13px",color:"#A5A3C8",marginBottom:"14px"}},"Zeige niemandem dein Handy!"));
  const hb=h("button",{class:"c",style:{padding:"28px 32px",cursor:"pointer",borderStyle:"dashed",display:"inline-block"},onClick:()=>{sx.tap();vb(25);hb.remove();
    d.appendChild(h("div",{style:{animation:"pop .3s ease"}},
      h("div",{class:"c",style:{padding:"20px 24px",marginBottom:"16px",borderTop:"3px solid "+rc}},
        h("div",{style:{fontSize:"28px",fontWeight:"900",color:rc}},role==="fake"?"🎭 Fake":role==="saboteur"?"🗡️ Saboteur":"✅ Normal"),
        h("div",{style:{fontSize:"11px",color:"#A5A3C8",marginTop:"6px"}},role==="fake"?"±0.4s pro Runde":role==="saboteur"?"1x sabotieren":"Entlarve die Betrüger!")),
      h("div",{style:{fontSize:"11px",color:V.ro,marginBottom:"12px"}},"Merke dir deine Rolle!"),
      h("div",{class:"sb"},"Spiel startet wenn alle bereit sind...")))
  }},h("div",{style:{fontSize:"14px",color:"#A5A3C8"}},"Antippen um Rolle zu sehen"));
  d.appendChild(hb);R(d);sx.drama()
}
function fakePrompt(time){
  const d=h("div",{class:"ct",style:{padding:"40px 16px",animation:"pop .3s ease"}});
  d.appendChild(h("div",{style:{fontSize:"22px",fontWeight:"800",color:V.or,marginBottom:"8px"}},"🎭 Deine Aktion"));
  d.appendChild(h("div",{style:{fontSize:"12px",color:"#5D5B7A",marginBottom:"16px"}},"Deine Zeit: "+time.toFixed(3)+"s — Anpassen?"));
  d.appendChild(h("div",{class:"fx"},
    h("button",{class:"b bs",style:{background:"linear-gradient(135deg,#6366F1,#8B5CF6)"},onClick:()=>{so.emit("fakeAct",{dir:"minus"});waiting()}},"-0.4s"),
    h("button",{class:"b bs",onClick:()=>{so.emit("fakeSkip");waiting()}},"Skip"),
    h("button",{class:"b bs",style:{background:"linear-gradient(135deg,#F97316,#F43F5E)"},onClick:()=>{so.emit("fakeAct",{dir:"plus"});waiting()}},"+0.4s")));
  R(d)
}
function sabPrompt(targets){
  const d=h("div",{class:"ct",style:{padding:"40px 16px",animation:"pop .3s ease"}});
  d.appendChild(h("div",{style:{fontSize:"22px",fontWeight:"800",color:V.ro,marginBottom:"16px"}},"🗡️ Sabotage"));
  const l=h("div",{style:{display:"flex",flexDirection:"column",gap:"8px"}});
  targets.forEach(t=>{l.appendChild(h("button",{class:"c",style:{padding:"14px 18px",cursor:"pointer",textAlign:"left"},onClick:()=>{so.emit("sabAct",{targetId:t.id});waiting()}},h("span",{style:{fontWeight:"700",fontSize:"14px"}},t.name)))});
  l.appendChild(h("button",{class:"b bs",style:{marginTop:"6px"},onClick:()=>{so.emit("sabSkip");waiting()}},"Skip"));
  d.appendChild(l);R(d)
}
function waiting(){R(h("div",{class:"ct",style:{padding:"60px 16px",animation:"fadeIn .4s ease"}},
  h("div",{class:"fx",style:{marginBottom:"8px"}},...[0,1,2].map(i=>h("div",{style:{width:"8px",height:"8px",borderRadius:"4px",background:V.v,animation:"dotP 1.2s ease "+i*.2+"s infinite"}}))),
  h("div",{style:{fontSize:"14px",color:"#A5A3C8"}},"Berechne Ergebnis...")))}
function vote(players){
  let fg=null,sg=null;
  const d=h("div",{class:"ct",style:{padding:"16px",animation:"up .4s ease"}});
  d.appendChild(h("div",{class:"gt",style:{fontSize:"22px",fontWeight:"800",marginBottom:"14px"}},"Abstimmung"));
  ["Wer ist der Fake?","Wer ist der Saboteur?"].forEach((q,qi)=>{
    d.appendChild(h("div",{style:{fontSize:"14px",fontWeight:"700",marginBottom:"8px"}},q));
    const dv=h("div",{class:"fx",style:{flexWrap:"wrap",marginBottom:"14px"}});
    players.filter(p=>p.id!==myId).forEach(p=>{
      const col=qi===0?V.or:V.ro;
      dv.appendChild(h("button",{class:"c",style:{padding:"10px 16px"},onClick:()=>{sx.tap();
        if(qi===0)fg=p.id;else sg=p.id;
        dv.querySelectorAll("button").forEach(b=>{b.style.background="#141432";b.style.borderColor="#2D2D5E"});
        event.currentTarget.style.background=col+"20";event.currentTarget.style.borderColor=col}},
        h("span",{style:{fontWeight:"700",fontSize:"13px"}},p.name)))});
    d.appendChild(dv)});
  d.appendChild(h("button",{class:"b",style:{width:"100%"},onClick:()=>{if(!fg||!sg)return;so.emit("vote",{fakeGuess:fg,sabGuess:sg});waiting()}},"ABSTIMMEN"));
  R(d)
}
function tbReveal(data){
  const d=h("div",{class:"ct",style:{padding:"20px 12px",animation:"pop .5s ease"}});
  d.appendChild(h("div",{style:{fontSize:"24px",fontWeight:"900",marginBottom:"14px"}},"Aufgedeckt!"));
  (st.players||[]).forEach((p,i)=>{const role=data.roles[p.id]||"normal";const rc=role==="fake"?V.or:role==="saboteur"?V.ro:V.em;
    d.appendChild(h("div",{class:"c",style:{padding:"14px 16px",marginBottom:"8px",borderLeft:"4px solid "+rc,textAlign:"left",animation:"sL .4s ease "+i*.1+"s both"}},
      h("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center"}},
        h("span",{style:{fontWeight:"800",fontSize:"14px"}},p.name+(p.id===myId?" (Du)":"")),
        h("span",{style:{fontWeight:"800",fontSize:"12px",color:rc}},role==="fake"?"🎭 Fake":role==="saboteur"?"🗡️ Saboteur":"✅ Normal"))))});
  const wc=data.normalWin?V.em:V.ro;
  d.appendChild(h("div",{class:"c",style:{padding:"16px",marginTop:"12px",textAlign:"center",borderTop:"3px solid "+wc}},
    h("div",{style:{fontSize:"18px",fontWeight:"900",color:wc,marginBottom:"4px"}},data.normalWin?"Normale gewinnen!":"Betrüger gewinnen!"),
    h("div",{style:{fontSize:"11px",color:"#A5A3C8"}},"Fake "+(data.fakeFound?"enttarnt":"unentdeckt")+" ("+data.fV+"/"+data.maj+") · Saboteur "+(data.sabFound?"enttarnt":"unentdeckt")+" ("+data.sV+"/"+data.maj+")")));
  d.appendChild(h("button",{class:"b",style:{marginTop:"16px"},onClick:home},"HOME"));
  R(d);sx.drama();vb([25,40,25,40,70])
}

// ═══ SOCKET EVENTS ═══
so.on("state",s=>{st=s;if(st.status==="lobby")upl();if(st.status==="hidden")waiting()});
so.on("roundStart",d=>{if(st.mode==="zeit")zeitGo();else buzzer(d.target)});
so.on("zeitStop",()=>zeitEst());
so.on("roundResults",d=>results(d));
so.on("gameEnd",d=>winner(d));
so.on("role",d=>roleReveal(d.role));
so.on("fakePrompt",d=>fakePrompt(d.time));
so.on("sabPrompt",d=>sabPrompt(d.targets));
so.on("voteStart",d=>vote(d.players));
so.on("tbReveal",d=>tbReveal(d));
home()
<\/script></body></html>`;

server.listen(PORT, () => console.log("TimeTap live on port " + PORT));
