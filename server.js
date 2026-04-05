const express=require("express"),http=require("http"),{Server}=require("socket.io");
const app=express(),srv=http.createServer(app),io=new Server(srv,{cors:{origin:"*"}});
const PORT=process.env.PORT||3000;
const rooms=new Map(),s2r=new Map(),CH="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function mkC(){let c;do{c=Array.from({length:6},()=>CH[Math.floor(Math.random()*CH.length)]).join("")}while(rooms.has(c));return c}
function gT(r,iz){if(iz){const l=r<=2?3:r<=5?4:5,h2=r<=2?6:r<=5?8:12;return Math.round((l+Math.random()*(h2-l))*10)/10}const l=r<=2?1.5:r<=5?2:3,h2=r<=2?3.5:r<=5?6:9;return Math.round((l+Math.random()*(h2-l))*10)/10}
function pub(r){return{code:r.code,mode:r.mode,status:r.status,players:r.players.map(p=>({id:p.id,name:p.name,avatar:p.avatar,host:p.host,elim:p.elim})),round:r.round,totalRounds:r.totalRounds,target:r.mode==="zeit"?null:r.target,submitted:r.subs?Object.keys(r.subs).length:0,activeCount:r.players.filter(p=>!p.elim).length}}
function bc(c){const r=rooms.get(c);if(r)io.to(c).emit("state",pub(r))}
io.on("connection",sk=>{
sk.on("create",({name,avatar,mode,rounds},cb)=>{const c=mkC();const r={code:c,mode:mode||"normal",status:"lobby",players:[{id:sk.id,name,avatar,host:true,elim:false}],round:0,totalRounds:rounds||3,target:0,subs:{},finalTimes:{},roles:{},fakeUsedRound:false,sabUsedGame:false,fakeResolved:false,sabResolved:false,votes:{},roundHistory:[]};rooms.set(c,r);sk.join(c);s2r.set(sk.id,c);cb({ok:true,code:c});bc(c)});
sk.on("join",({code:c,name,avatar},cb)=>{const r=rooms.get(c&&c.toUpperCase());if(!r)return cb({ok:false,err:"Room not found"});if(r.status!=="lobby")return cb({ok:false,err:"Game started"});if(r.players.length>=10)return cb({ok:false,err:"Room full"});r.players.push({id:sk.id,name,avatar,host:false,elim:false});sk.join(r.code);s2r.set(sk.id,r.code);cb({ok:true,code:r.code});bc(r.code)});
sk.on("start",()=>{const c=s2r.get(sk.id),r=rooms.get(c);if(!r)return;const p=r.players.find(x=>x.id===sk.id);if(!p||!p.host||r.players.length<2)return;r.status="playing";r.round=1;r.subs={};r.finalTimes={};r.target=gT(1,r.mode==="zeit");r.roundHistory=[];r.players.forEach(p2=>p2.elim=false);if(r.mode==="trust"){r.roles={};r.sabUsedGame=false;const ids=r.players.map(p2=>p2.id).sort(()=>Math.random()-.5);r.players.forEach(p2=>r.roles[p2.id]="normal");if(ids.length>=2){r.roles[ids[0]]="fake";r.roles[ids[1]]="saboteur"}r.players.forEach(p2=>io.to(p2.id).emit("role",{role:r.roles[p2.id]}))}bc(c);io.to(c).emit("roundStart",{round:r.round,target:r.mode==="zeit"?null:r.target});if(r.mode==="zeit"){const rn=r.round;setTimeout(()=>{if(r.status==="playing"&&r.round===rn)io.to(c).emit("zeitStop")},r.target*1000)}});
sk.on("submit",({time})=>{const c=s2r.get(sk.id),r=rooms.get(c);if(!r||r.status!=="playing")return;const p=r.players.find(x=>x.id===sk.id);if(!p||p.elim||r.subs[sk.id]!==undefined)return;r.subs[sk.id]=time;r.finalTimes[sk.id]=time;bc(c);if(Object.keys(r.subs).length>=r.players.filter(x=>!x.elim).length){if(r.mode==="trust"){r.status="hidden";r.fakeUsedRound=false;r.fakeResolved=false;r.sabResolved=r.sabUsedGame;bc(c);const fi=Object.entries(r.roles).find(([,x])=>x==="fake"),si=Object.entries(r.roles).find(([,x])=>x==="saboteur");const fid=fi?fi[0]:null,sid=si?si[0]:null;if(fid)io.to(fid).emit("fakePrompt",{time:r.subs[fid]});else r.fakeResolved=true;if(sid&&!r.sabUsedGame)io.to(sid).emit("sabPrompt",{targets:r.players.filter(p2=>p2.id!==sid&&!p2.elim).map(p2=>({id:p2.id,name:p2.name}))});else r.sabResolved=true;setTimeout(()=>{if(r.status==="hidden")res(c)},12e3);chk(c)}else res(c)}});
sk.on("fakeAct",({dir})=>{const c=s2r.get(sk.id),r=rooms.get(c);if(!r||r.roles[sk.id]!=="fake"||r.fakeResolved)return;const o=r.subs[sk.id];if(o===undefined)return;r.finalTimes[sk.id]=o+(dir==="plus"?.4:-.4);r.fakeResolved=true;chk(c)});
sk.on("fakeSkip",()=>{const c=s2r.get(sk.id),r=rooms.get(c);if(!r||r.roles[sk.id]!=="fake")return;r.fakeResolved=true;chk(c)});
sk.on("sabAct",({targetId})=>{const c=s2r.get(sk.id),r=rooms.get(c);if(!r||r.roles[sk.id]!=="saboteur"||r.sabUsedGame)return;const tv=r.finalTimes[targetId];if(tv===undefined)return;r.finalTimes[targetId]=tv+((tv-r.target)>=0?.3:-.3);r.sabUsedGame=true;r.sabResolved=true;chk(c)});
sk.on("sabSkip",()=>{const c=s2r.get(sk.id),r=rooms.get(c);if(!r||r.roles[sk.id]!=="saboteur")return;r.sabResolved=true;chk(c)});
sk.on("vote",({fakeGuess,sabGuess})=>{const c=s2r.get(sk.id),r=rooms.get(c);if(!r||r.status!=="voting")return;r.votes[sk.id]={fake:fakeGuess,sab:sabGuess};if(Object.keys(r.votes).length>=r.players.length){const fi=Object.entries(r.roles).find(([,x])=>x==="fake"),si=Object.entries(r.roles).find(([,x])=>x==="saboteur");const fid=fi?fi[0]:null,sid=si?si[0]:null;const fV=Object.values(r.votes).filter(v=>v.fake===fid).length,sV=Object.values(r.votes).filter(v=>v.sab===sid).length,maj=Math.ceil(r.players.length/2);r.status="reveal";io.to(c).emit("tbReveal",{roles:r.roles,fakeId:fid,sabId:sid,fakeFound:fV>=maj,sabFound:sV>=maj,normalWin:fV>=maj&&sV>=maj,votes:r.votes,fV:fV,sV:sV,maj:maj})}});
sk.on("nextRound",()=>{const c=s2r.get(sk.id),r=rooms.get(c);if(!r)return;const p=r.players.find(x=>x.id===sk.id);if(!p||!p.host)return;const act=r.players.filter(x=>!x.elim);if(r.mode==="trust"&&r.round>=r.totalRounds){r.status="voting";r.votes={};io.to(c).emit("voteStart",{players:r.players.map(p2=>({id:p2.id,name:p2.name,avatar:p2.avatar}))});return}if(act.length<=1||(r.mode!=="trust"&&r.round>=r.totalRounds)){end(c);return}r.round++;r.subs={};r.finalTimes={};r.target=gT(r.round,r.mode==="zeit");r.status="playing";r.fakeUsedRound=false;r.fakeResolved=false;r.sabResolved=r.sabUsedGame;bc(c);io.to(c).emit("roundStart",{round:r.round,target:r.mode==="zeit"?null:r.target});if(r.mode==="zeit"){const rn=r.round;setTimeout(()=>{if(r.status==="playing"&&r.round===rn)io.to(c).emit("zeitStop")},r.target*1000)}});
sk.on("disconnect",()=>{const c=s2r.get(sk.id);if(!c)return;const r=rooms.get(c);if(!r)return;r.players=r.players.filter(p=>p.id!==sk.id);if(!r.players.length)rooms.delete(c);else{if(!r.players.some(p=>p.host))r.players[0].host=true;bc(c)}s2r.delete(sk.id)});
});
function chk(c){const r=rooms.get(c);if(!r||r.status!=="hidden")return;if(r.fakeResolved&&r.sabResolved)res(c)}
function res(c){const r=rooms.get(c);if(!r)return;const act=r.players.filter(p=>!p.elim),ft=r.finalTimes||r.subs;const rs=act.map(p=>{const tv=ft[p.id]||r.subs[p.id]||0;return{id:p.id,name:p.name,avatar:p.avatar,time:Math.round(tv*1e3)/1e3,ms:Math.round(Math.abs(tv-r.target)*1e3),elim:false}}).sort((a,b)=>a.ms-b.ms);rs.forEach((x,i)=>x.rank=i+1);if(r.mode!=="trust"&&act.length>2){rs[rs.length-1].elim=true;const w=r.players.find(p=>p.id===rs[rs.length-1].id);if(w)w.elim=true}r.roundHistory.push({round:r.round,target:r.target,results:rs});r.status="results";io.to(c).emit("roundResults",{round:r.round,target:r.target,results:rs})}
function end(c){const r=rooms.get(c);if(!r)return;r.status="ended";io.to(c).emit("gameEnd",{winner:r.players.filter(p=>!p.elim)[0]?r.players.filter(p=>!p.elim)[0].name:"?"})}
app.get("/",(q,s)=>s.send(HTML));
app.get("/health",(q,s)=>s.json({ok:true,rooms:rooms.size}));

const HTML=`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta name="apple-mobile-web-app-capable" content="yes"><title>TimeTap</title>
<script src="https://cdn.socket.io/4.7.4/socket.io.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:'SF Pro Display','Segoe UI',system-ui,sans-serif;min-height:100dvh;overflow-x:hidden;transition:background .3s,color .3s}
#app{max-width:440px;margin:0 auto;padding:14px 16px 40px}
button{font-family:inherit;cursor:pointer;border:none;outline:none}input{font-family:inherit;outline:none}
#sd{position:fixed;top:8px;right:8px;width:10px;height:10px;border-radius:50%;z-index:9999;transition:background .3s}
@keyframes pop{0%{transform:scale(.3);opacity:0}60%{transform:scale(1.06)}100%{transform:scale(1);opacity:1}}
@keyframes up{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes sL{from{transform:translateX(-14px);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}
@keyframes cPop{0%{transform:scale(.5);opacity:0}50%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
@keyframes breathe{0%,100%{transform:scale(1);opacity:.35}50%{transform:scale(1.12);opacity:.75}}
@keyframes ripple{0%{transform:scale(.8);opacity:.5}100%{transform:scale(2);opacity:0}}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}
@keyframes conf{0%{transform:translateY(0) rotate(0);opacity:1}100%{transform:translateY(220px) rotate(720deg);opacity:0}}
@keyframes dotP{0%,80%,100%{opacity:.3}40%{opacity:1}}
</style></head><body><div id="sd"></div><div id="app"></div>
<script>
var L={de:{sub:"Stoppe die Zeit. Triff die Zielzeit.",normal:"Normal",normalD:"Zielzeit sichtbar",zeit:"Zeitgef\u00fchl",zeitD:"Kein Timer \u2013 sch\u00e4tze im Kopf",tb:"Trust Breaker",tbD:"4\u20136 Spieler \u00b7 Rollen",settings:"Einstellungen",home:"Home",back:"Zur\u00fcck",next:"Weiter",ready:"Bereit!",submit:"Abgeben",result:"Ergebnis",rnd:"Runde",rnds:"Runden",pts:"Punkte",dev:"Abweichung",tgt:"Ziel",tgtTime:"Zielzeit",perf:"PERFEKT!",strong:"Stark!",good:"Gut!",close:"Knapp",miss:"Daneben",getReady:"Mach dich bereit",now:"JETZT!",countNow:"Ab jetzt z\u00e4hlen!",countAlong:"Z\u00e4hle mit...",timerSince:"Timer l\u00e4uft seit JETZT!",stop:"STOP!",howLong:"Wie lange war das?",yourEst:"Deine Sch\u00e4tzung",name:"Dein Name...",avatar:"Avatar w\u00e4hlen",create:"Erstellen",join:"Beitreten",joinRoom:"Raum beitreten",roomCode:"Raum-Code",copied:"Kopiert!",waitPl:"Warte auf Spieler...",waitHost:"Warte auf den Host...",startGame:"Spiel starten",players:"Spieler",tgtHidden:"Zielzeit ist versteckt",elimRnd:"Eliminationsrunde",isOut:"ist raus!",winsTrn:"gewinnt!",tapSee:"Antippen um Rolle zu sehen",fake:"Fake",sab:"Saboteur",norm:"Normal",fakeD:"\u00b10.4s pro Runde",sabD:"1x sabotieren",normD:"Entlarve die Betr\u00fcger!",noShow:"Zeige niemandem!",calc:"Berechne...",skip:"Skip",sabotage:"Sabotiere",discuss:"Host dr\u00fcckt weiter",whoFake:"Wer ist Fake?",whoSab:"Wer ist Saboteur?",vote:"Abstimmen",revealed:"Aufgedeckt!",normWin:"Normale gewinnen!",cheatWin:"Betr\u00fcger gewinnen!",exposed:"enttarnt",undetected:"unentdeckt",lang:"Sprache",theme:"Erscheinungsbild",dark:"Dunkel",light:"Hell",waiting:"Warte auf andere..."},
en:{sub:"Stop the time. Hit the target.",normal:"Normal",normalD:"Target visible",zeit:"Time Feel",zeitD:"No timer \u2013 estimate",tb:"Trust Breaker",tbD:"4\u20136 players \u00b7 Roles",settings:"Settings",home:"Home",back:"Back",next:"Next",ready:"Ready!",submit:"Submit",result:"Result",rnd:"Round",rnds:"Rounds",pts:"Points",dev:"Deviation",tgt:"Target",tgtTime:"Target Time",perf:"PERFECT!",strong:"Strong!",good:"Good!",close:"Close",miss:"Missed",getReady:"Get ready",now:"NOW!",countNow:"Start counting!",countAlong:"Keep counting...",timerSince:"Timer since NOW!",stop:"STOP!",howLong:"How long was that?",yourEst:"Your estimate",name:"Your name...",avatar:"Choose avatar",create:"Create",join:"Join",joinRoom:"Join Room",roomCode:"Room Code",copied:"Copied!",waitPl:"Waiting for players...",waitHost:"Waiting for host...",startGame:"Start Game",players:"Players",tgtHidden:"Target hidden",elimRnd:"Elimination Round",isOut:"is out!",winsTrn:"wins!",tapSee:"Tap to see role",fake:"Fake",sab:"Saboteur",norm:"Normal",fakeD:"\u00b10.4s per round",sabD:"Sabotage once",normD:"Expose cheaters!",noShow:"Don't show anyone!",calc:"Calculating...",skip:"Skip",sabotage:"Sabotage",discuss:"Host continues",whoFake:"Who is Fake?",whoSab:"Who is Saboteur?",vote:"Vote",revealed:"Revealed!",normWin:"Normals win!",cheatWin:"Cheaters win!",exposed:"exposed",undetected:"undetected",lang:"Language",theme:"Appearance",dark:"Dark",light:"Light",waiting:"Waiting..."},
sq:{sub:"Ndalo koh\u00ebn. Q\u00ebllo objektivin.",normal:"Normal",normalD:"Koha e dukshme",zeit:"Ndjenja e Koh\u00ebs",zeitD:"Pa kronometr\u00ebr",tb:"Trust Breaker",tbD:"4\u20136 lojtar\u00eb",settings:"Cil\u00ebsimet",home:"Kryefaqja",back:"Kthehu",next:"Vazhdo",ready:"Gati!",submit:"D\u00ebrgo",result:"Rezultati",rnd:"Raundi",rnds:"Raunde",pts:"Pik\u00eb",dev:"Devijimi",tgt:"Objektivi",tgtTime:"Koha objektiv",perf:"PERFEKT!",strong:"Fort\u00eb!",good:"Mir\u00eb!",close:"Af\u00ebr",miss:"Gabim",getReady:"P\u00ebrgatitu",now:"TANI!",countNow:"Fillo!",countAlong:"Vazhdo...",timerSince:"Nga TANI!",stop:"NDALO!",howLong:"Sa koh\u00eb?",yourEst:"Vl\u00ebr\u00ebsimi",name:"Emri yt...",avatar:"Zgjidh avatarin",create:"Krijo",join:"Bashkohu",joinRoom:"Bashkohu",roomCode:"Kodi",copied:"Kopjuar!",waitPl:"Duke pritur...",waitHost:"Duke pritur hostin...",startGame:"Fillo loj\u00ebn",players:"Lojtar\u00eb",tgtHidden:"Koha e fshehur",elimRnd:"Raundi eliminues",isOut:"u eliminua!",winsTrn:"fiton!",tapSee:"Prek p\u00ebr t\u00eb par\u00eb",fake:"Fake",sab:"Saboteur",norm:"Normal",fakeD:"\u00b10.4s",sabD:"1x saboto",normD:"Zbulo!",noShow:"Mos trego!",calc:"Duke llogaritur...",skip:"Kalo",sabotage:"Saboto",discuss:"Hosti vazhdon",whoFake:"Kush \u00ebsht\u00eb Fake?",whoSab:"Kush \u00ebsht\u00eb Saboteur?",vote:"Voto",revealed:"U zbulua!",normWin:"Normal\u00ebt fituan!",cheatWin:"Mashtruesit fituan!",exposed:"zbuluar",undetected:"pazbuluar",lang:"Gjuha",theme:"Pamja",dark:"Err\u00ebt",light:"Ndri\u00e7uar",waiting:"Duke pritur..."}};
var TH={dark:{bg:"#0B0B1E",card:"#141432",raised:"#1C1C42",tx:"#F1F0FF",sub:"#A5A3C8",mt:"#5D5B7A",ln:"#2D2D5E"},light:{bg:"#F5F3FF",card:"#FFFFFF",raised:"#EDE9FE",tx:"#1E1B4B",sub:"#6B7280",mt:"#9CA3AF",ln:"#E5E7EB"}};
var A={v:"#8B5CF6",pk:"#EC4899",or:"#F97316",cy:"#06B6D4",am:"#F59E0B",em:"#10B981",ro:"#F43F5E",sk:"#38BDF8"};
var GR={brand:"linear-gradient(135deg,#8B5CF6,#EC4899)",warm:"linear-gradient(135deg,#F97316,#F43F5E)",cool:"linear-gradient(135deg,#6366F1,#8B5CF6)",mint:"linear-gradient(135deg,#10B981,#06B6D4)",trust:"linear-gradient(135deg,#F43F5E,#F97316)"};
var AV=["😎","😀","🤖","🐯","🐸","🔥","🚀","👻","🧠","⚡"];
var lang="de",theme="dark",T=TH.dark;
function t(k){return(L[lang]||L.de)[k]||k}
function setTh(th){theme=th;T=TH[th];document.body.style.background=T.bg;document.body.style.color=T.tx}
setTh("dark");
var _ac;function ac(){if(!_ac)_ac=new(window.AudioContext||window.webkitAudioContext)();if(_ac.state==="suspended")_ac.resume();return _ac}
function bp(f,d,w,v){w=w||"sine";v=v||.18;try{var c=ac(),o=c.createOscillator(),g=c.createGain();o.connect(g);g.connect(c.destination);o.type=w;o.frequency.value=f;g.gain.setValueAtTime(v,c.currentTime);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+d);o.start();o.stop(c.currentTime+d)}catch(e){}}
var sx={tap:function(){bp(880,.06)},tick:function(){bp(660,.1,"square",.12)},go:function(){bp(880,.12,"square",.2);setTimeout(function(){bp(1100,.16,"square",.16)},70)},good:function(){bp(523,.1);setTimeout(function(){bp(659,.1)},80);setTimeout(function(){bp(784,.16)},160)},bad:function(){bp(380,.12,"sawtooth",.08)},win:function(){[523,659,784,1047,784,1047].forEach(function(f,i){setTimeout(function(){bp(f,.14)},i*100)})},drama:function(){[200,250,300,350,400,500,600,800].forEach(function(f,i){setTimeout(function(){bp(f,.1,"triangle",.08+i*.02)},i*100)})}};
function vb(p){try{navigator.vibrate(p)}catch(e){}}
var so=io(location.origin,{transports:["websocket","polling"],reconnection:true,reconnectionAttempts:30,reconnectionDelay:1e3});
var myId=null,st={},rc="",isH=false,myN="",myA=AV[0],t0=0,bst="ready";
so.on("connect",function(){myId=so.id;document.getElementById("sd").style.background=A.em});
so.on("disconnect",function(){document.getElementById("sd").style.background=A.ro});
function $(id){return document.getElementById(id)}
function h(tag,a){var e=document.createElement(tag);if(a)Object.keys(a).forEach(function(k){var v=a[k];if(k==="style"&&typeof v==="object")Object.assign(e.style,v);else if(k.indexOf("on")===0)e.addEventListener(k.slice(2).toLowerCase(),v);else e.setAttribute(k,v)});for(var i=2;i<arguments.length;i++){var c=arguments[i];if(c!=null){if(Array.isArray(c))c.forEach(function(x){if(x!=null)e.appendChild(typeof x==="string"?document.createTextNode(x):x)});else e.appendChild(typeof c==="string"?document.createTextNode(c):c)}}return e}
function R(el){var a=$("app");a.innerHTML="";if(typeof el==="string")a.innerHTML=el;else a.appendChild(el)}
function gr(ms){if(ms<=30)return{t:t("perf"),c:A.am};if(ms<=100)return{t:t("strong"),c:A.em};if(ms<=250)return{t:t("good"),c:A.v};if(ms<=500)return{t:t("close"),c:"#A5A3C8"};return{t:t("miss"),c:A.ro}}
function medal(r){return r===1?"🥇":r===2?"🥈":r===3?"🥉":"#"+r}
function cd(x){return Object.assign({background:T.card,borderRadius:"16px",border:"1px solid "+T.ln},x||{})}
function btnS(p,x){return Object.assign({borderRadius:"14px",padding:p?"16px 36px":"10px 18px",color:"#fff",fontSize:p?"15px":"13px",fontWeight:p?"800":"600",letterSpacing:p?"1.5px":"0",textTransform:p?"uppercase":"none",background:p?GR.brand:T.raised,border:p?"none":"1px solid "+T.ln,boxShadow:p?"0 0 10px "+A.v+"30":"none",transition:"transform .12s",fontFamily:"inherit"},x||{})}

function home(){
R(h("div",{style:{animation:"fadeIn .5s ease"}},
h("div",{style:{textAlign:"center",paddingTop:"20px"}},
h("div",{style:{fontSize:"50px",animation:"float 3s ease infinite",marginBottom:"4px"}},"⏱️"),
h("h1",{style:{fontSize:"42px",fontWeight:"900",margin:"0 0 4px",lineHeight:"1.1",background:GR.brand,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}},"TimeTap"),
h("p",{style:{color:T.sub,fontSize:"14px",marginBottom:"24px"}},t("sub"))),
["normal","zeit","trust"].map(function(m,i){
var c={normal:{ic:"🎯",tk:"normal",dk:"normalD",bg:GR.mint},zeit:{ic:"🧠",tk:"zeit",dk:"zeitD",bg:GR.brand},trust:{ic:"🕵️",tk:"tb",dk:"tbD",bg:GR.trust}}[m];
return h("button",{style:{width:"100%",padding:"18px 20px",marginBottom:"12px",display:"flex",alignItems:"center",gap:"14px",textAlign:"left",borderRadius:"18px",border:"none",background:c.bg,fontFamily:"inherit",animation:"sL .4s ease "+i*.07+"s both",boxShadow:"0 0 16px rgba(0,0,0,.2)"},onClick:function(){sx.tap();vb(10);setup(m)}},
h("div",{style:{fontSize:"28px"}},c.ic),h("div",null,h("div",{style:{fontSize:"17px",fontWeight:"800",color:"#fff"}},t(c.tk)),h("div",{style:{fontSize:"12px",color:"rgba(255,255,255,.75)"}},t(c.dk))),h("div",{style:{marginLeft:"auto",fontSize:"20px",color:"rgba(255,255,255,.5)"}},"›"))}),
h("button",{style:{marginTop:"20px",background:T.raised,border:"1px solid "+T.ln,borderRadius:"12px",padding:"10px 20px",fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:"8px"},onClick:function(){sx.tap();settings()}},h("span",{style:{fontSize:"16px"}},"⚙️"),h("span",{style:{fontSize:"13px",fontWeight:"600",color:T.sub}},t("settings"))),
h("div",{style:{marginTop:"16px",color:T.mt,fontSize:"10px"}},"TimeTap v5.1")))}

function settings(){var d=h("div",{style:{animation:"up .4s ease"}});
d.appendChild(h("button",{style:btnS(false,{marginBottom:"20px"}),onClick:home},"← "+t("back")));
d.appendChild(h("div",{style:{textAlign:"center",marginBottom:"20px"}},h("div",{style:{fontSize:"22px",fontWeight:"900",color:T.tx}},t("settings"))));
var lc=h("div",{style:cd({padding:"16px",marginBottom:"14px"})});
lc.appendChild(h("div",{style:{fontSize:"10px",color:T.mt,letterSpacing:"2px",textTransform:"uppercase",marginBottom:"10px"}},t("lang")));
var lr=h("div",{style:{display:"flex",gap:"8px"}});
[{id:"de",lb:"Deutsch",fl:"🇩🇪"},{id:"en",lb:"English",fl:"🇬🇧"},{id:"sq",lb:"Shqip",fl:"🇦🇱"}].forEach(function(l){
lr.appendChild(h("button",{style:{flex:"1",padding:"12px 8px",borderRadius:"12px",border:lang===l.id?"2px solid "+A.v:"1px solid "+T.ln,background:lang===l.id?A.v+"20":T.raised,fontFamily:"inherit",textAlign:"center"},onClick:function(){sx.tap();lang=l.id;settings()}},h("div",{style:{fontSize:"22px",marginBottom:"4px"}},l.fl),h("div",{style:{fontSize:"11px",fontWeight:"700",color:lang===l.id?A.v:T.tx}},l.lb)))});
lc.appendChild(lr);d.appendChild(lc);
var tc=h("div",{style:cd({padding:"16px"})});
tc.appendChild(h("div",{style:{fontSize:"10px",color:T.mt,letterSpacing:"2px",textTransform:"uppercase",marginBottom:"10px"}},t("theme")));
var tr2=h("div",{style:{display:"flex",gap:"8px"}});
[{id:"dark",k:"dark",ic:"🌙"},{id:"light",k:"light",ic:"☀️"}].forEach(function(m){
tr2.appendChild(h("button",{style:{flex:"1",padding:"14px 12px",borderRadius:"12px",border:theme===m.id?"2px solid "+A.v:"1px solid "+T.ln,background:theme===m.id?A.v+"20":T.raised,fontFamily:"inherit",textAlign:"center"},onClick:function(){sx.tap();setTh(m.id);settings()}},h("div",{style:{fontSize:"24px",marginBottom:"4px"}},m.ic),h("div",{style:{fontSize:"12px",fontWeight:"700",color:theme===m.id?A.v:T.tx}},t(m.k))))});
tc.appendChild(tr2);d.appendChild(tc);R(d)}

function setup(mode){var av=AV[0];
var d=h("div",{style:{animation:"up .4s ease"}});
d.appendChild(h("button",{style:btnS(false,{marginBottom:"20px"}),onClick:home},"← "+t("home")));
d.appendChild(h("div",{style:{textAlign:"center",marginBottom:"14px"}},h("div",{style:{fontSize:"18px",fontWeight:"800",color:T.tx}},t(mode==="trust"?"tb":mode==="zeit"?"zeit":"normal")),h("div",{style:{color:T.sub,fontSize:"12px"}},(mode==="trust"?"4–6":"2–10")+" "+t("players"))));
var ni=h("input",{placeholder:t("name"),maxLength:"12",style:{width:"100%",background:"transparent",border:"none",borderBottom:"2px solid "+T.ln,padding:"10px 0",color:T.tx,fontSize:"18px",fontWeight:"800",textAlign:"center"}});
var ag=h("div",{style:{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:"8px",marginBottom:"10px"}});
function ra(){ag.innerHTML="";AV.forEach(function(a){ag.appendChild(h("button",{style:{aspectRatio:"1",borderRadius:"12px",fontSize:"22px",display:"flex",alignItems:"center",justifyContent:"center",background:av===a?A.v+"30":T.raised,border:av===a?"2px solid "+A.v:"1px solid "+T.ln},onClick:function(){sx.tap();av=a;ra()}},a))})}ra();
d.appendChild(h("div",{style:cd({padding:"18px 20px",marginBottom:"14px"})},ni,h("div",{style:{fontSize:"10px",color:T.mt,letterSpacing:"2px",textTransform:"uppercase",textAlign:"center",margin:"16px 0 10px"}},t("avatar")),ag));
d.appendChild(h("div",{style:{display:"flex",gap:"14px",justifyContent:"center",marginTop:"10px"}},
h("div",{style:{textAlign:"center"}},h("button",{style:{width:"80px",height:"80px",borderRadius:"50%",background:GR.mint,fontSize:"28px",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 0 14px "+A.em+"30"},onClick:function(){var n=ni.value.trim();if(!n)return;sx.tap();myN=n;myA=av;isH=true;so.emit("create",{name:n,avatar:av,mode:mode,rounds:3},function(r){if(r.ok){rc=r.code;lobby()}else alert(r.err)})}},"+"),h("div",{style:{fontSize:"12px",color:T.sub,marginTop:"6px",fontWeight:"600"}},t("create"))),
h("div",{style:{textAlign:"center"}},h("button",{style:{width:"80px",height:"80px",borderRadius:"50%",background:"linear-gradient(135deg,"+A.sk+","+A.cy+")",fontSize:"28px",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 0 14px "+A.sk+"30"},onClick:function(){var n=ni.value.trim();if(!n)return;sx.tap();myN=n;myA=av;isH=false;joinCodeScreen(mode)}},"→"),h("div",{style:{fontSize:"12px",color:T.sub,marginTop:"6px",fontWeight:"600"}},t("join")))));R(d)}

function joinCodeScreen(mode){var d=h("div",{style:{textAlign:"center",animation:"up .4s ease",paddingTop:"30px"}});
d.appendChild(h("div",{style:{fontSize:"36px",marginBottom:"8px"}},"🔑"));
d.appendChild(h("div",{style:{fontSize:"18px",fontWeight:"800",color:T.tx,marginBottom:"14px"}},t("joinRoom")));
var inp=h("input",{placeholder:"CODE",maxLength:"6",style:{width:"100%",maxWidth:"260px",background:T.raised,border:"2px solid "+T.ln,borderRadius:"14px",padding:"16px",color:T.tx,fontSize:"26px",fontWeight:"900",fontFamily:"monospace",textAlign:"center",letterSpacing:"8px"}});
inp.addEventListener("input",function(){inp.value=inp.value.toUpperCase().replace(/[^A-Z0-9]/g,"");inp.style.borderColor=inp.value.length===6?A.v:T.ln});
var err=h("div",{style:{color:A.ro,fontSize:"12px",marginTop:"8px",minHeight:"18px"}});
d.appendChild(inp);d.appendChild(err);
d.appendChild(h("button",{style:btnS(true,{marginTop:"12px",width:"100%",maxWidth:"260px"}),onClick:function(){if(inp.value.length<6)return;so.emit("join",{code:inp.value,name:myN,avatar:myA},function(r){if(r.ok){rc=r.code;lobby()}else{err.textContent=r.err||"Error";sx.bad()}})}},t("join")));
d.appendChild(h("button",{style:btnS(false,{marginTop:"12px"}),onClick:function(){setup(mode)}},"← "+t("back")));R(d)}

function lobby(){var d=h("div",{style:{textAlign:"center",animation:"up .4s ease"}});
var cpt=h("div",{style:{fontSize:"10px",color:A.v,marginTop:"2px"}},"📋 "+t("roomCode"));
var cb=h("button",{style:cd({display:"inline-block",padding:"12px 28px",marginBottom:"16px",background:T.raised,cursor:"pointer"}),onClick:function(){try{navigator.clipboard.writeText(rc);cpt.textContent="✓ "+t("copied");setTimeout(function(){cpt.textContent="📋 "+t("roomCode")},2e3)}catch(e){}}},h("div",{style:{fontSize:"9px",color:T.mt,letterSpacing:"2px",textTransform:"uppercase"}},t("roomCode")),h("div",{style:{fontSize:"34px",fontWeight:"900",color:A.am,fontFamily:"monospace",letterSpacing:"8px"}},rc),cpt);
d.appendChild(cb);
d.appendChild(h("div",{style:cd({padding:"14px",marginBottom:"14px",textAlign:"left"}),id:"pl"}));
var rn=3;
if(isH){var rd=h("div",{style:{display:"flex",gap:"10px",alignItems:"center",justifyContent:"center",marginBottom:"14px"}});rd.appendChild(h("span",{style:{fontSize:"12px",color:T.sub}},t("rnds")+":"));
[1,3,5].forEach(function(r){rd.appendChild(h("button",{style:{width:"38px",height:"38px",borderRadius:"10px",background:r===rn?GR.brand:T.raised,color:"#fff",fontWeight:"800",fontSize:"15px",border:"none",fontFamily:"inherit"},onClick:function(){sx.tap();rn=r;var btns=rd.querySelectorAll("button");btns.forEach(function(b,i){b.style.background=[1,3,5][i]===rn?GR.brand:T.raised})}},String(r)))});d.appendChild(rd)}
d.appendChild(h("div",{style:{fontSize:"11px",color:T.sub,marginBottom:"14px",animation:"pulse 1.5s ease infinite"}},t("waitPl")));
if(isH)d.appendChild(h("button",{style:btnS(true,{width:"100%",maxWidth:"300px"}),id:"sb",onClick:function(){so.emit("start")}},t("startGame")));
else d.appendChild(h("div",{style:cd({padding:"12px",textAlign:"center"})},h("div",{style:{color:T.sub,fontSize:"12px"}},t("waitHost"))));
R(d);upl()}

function upl(){var el=$("pl");if(!el)return;el.innerHTML="";
el.appendChild(h("div",{style:{fontSize:"10px",color:T.mt,letterSpacing:"2px",textTransform:"uppercase",marginBottom:"10px"}},t("players")+" ("+(st.players?st.players.length:0)+")"));
(st.players||[]).forEach(function(p,i){el.appendChild(h("div",{style:{display:"flex",alignItems:"center",gap:"10px",padding:"10px 0",borderBottom:i<st.players.length-1?"1px solid "+T.ln:"none"}},
h("div",{style:{fontSize:"24px"}},p.avatar||"😎"),
h("div",{style:{flex:"1"}},h("span",{style:{fontWeight:"700",fontSize:"14px",color:T.tx}},p.name),
p.host?h("span",{style:{fontSize:"9px",color:A.am,marginLeft:"6px",fontWeight:"700",background:A.am+"20",padding:"2px 6px",borderRadius:"4px"}},"HOST"):null,
p.id===myId?h("span",{style:{fontSize:"9px",color:A.v,marginLeft:"6px",fontWeight:"700",background:A.v+"20",padding:"2px 6px",borderRadius:"4px"}},"DU"):null)))});
var sb=$("sb");if(sb)sb.disabled=(st.players?st.players.length:0)<(st.mode==="trust"?4:2)}

function buzzer(tgt){bst="ready";t0=0;
var d=h("div",{style:{textAlign:"center",animation:"up .3s ease",paddingTop:"20px"}});
d.appendChild(h("div",{style:{color:T.sub,fontSize:"12px",marginBottom:"14px"}},t("rnd")+" "+st.round));
if(tgt!==null)d.appendChild(h("div",{style:cd({display:"inline-block",padding:"12px 28px",borderLeft:"3px solid "+A.v,marginBottom:"16px"})},h("div",{style:{fontSize:"9px",color:T.mt,letterSpacing:"2px",textTransform:"uppercase"}},t("tgtTime")),h("div",{style:{fontSize:"44px",fontWeight:"900",fontFamily:"monospace",color:T.tx}},tgt.toFixed(1)+"s")));
else d.appendChild(h("div",{style:{fontSize:"14px",color:A.cy,marginBottom:"16px"}},t("tgtHidden")));
var sp=h("span",{style:{color:"#fff",fontSize:"16px",fontWeight:"900",letterSpacing:"4px"}},"START");
var bz=h("button",{style:{width:"175px",height:"175px",borderRadius:"50%",background:GR.brand,border:"3px solid rgba(255,255,255,.2)",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 0 24px "+A.v+"30",position:"relative",zIndex:"1",fontFamily:"inherit",transition:"transform .3s"},onClick:function(){
if(bst==="ready"){t0=Date.now();bst="timing";bz.style.background=GR.warm;bz.style.boxShadow="0 0 24px "+A.ro+"30";sp.textContent="STOP";vb(25)}
else if(bst==="timing"){var el=Math.max(.01,(Date.now()-t0)/1000);bst="done";bz.style.background="linear-gradient(135deg,#5D5B7A,#555)";bz.style.boxShadow="none";sp.textContent="✓";sx.tap();vb([50,25,50]);so.emit("submit",{time:el});
setTimeout(function(){d.appendChild(h("div",{style:{textAlign:"center",marginTop:"20px",animation:"fadeIn .3s ease"}},h("div",{style:{fontSize:"14px",color:T.sub,animation:"pulse 1.5s ease infinite"}},t("waiting"))))},300)}}},sp);
d.appendChild(h("div",{style:{position:"relative",width:"175px",height:"175px",margin:"0 auto"}},bz));R(d)}

function zeitGo(){var c=3;var d=h("div",{style:{textAlign:"center",padding:"50px 0"}});
var lb=h("div",{style:{fontSize:"10px",color:T.mt,letterSpacing:"3px",textTransform:"uppercase",marginBottom:"8px"}},t("getReady"));
var n=h("div",{style:{fontSize:"96px",fontWeight:"900",background:GR.cool,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",animation:"cPop .3s ease"}},"3");
d.appendChild(lb);d.appendChild(n);R(d);sx.tick();vb(10);
var iv=setInterval(function(){c--;if(c>0){n.textContent=c;n.style.animation="none";void n.offsetHeight;n.style.animation="cPop .3s ease";sx.tick();vb(10)}else if(c===0){n.textContent=t("now");n.style.background=GR.mint;n.style.WebkitBackgroundClip="text";lb.textContent=t("countNow");lb.style.color=A.cy;sx.go();vb([50,25,50]);t0=Date.now()}else{clearInterval(iv);zeitRun()}},1e3)}

function zeitRun(){var d=h("div",{style:{textAlign:"center",padding:"40px 0",animation:"fadeIn .6s ease"}});
d.appendChild(h("div",{style:{position:"relative",width:"150px",height:"150px",margin:"0 auto 18px"}},
h("div",{style:{position:"absolute",inset:"0",borderRadius:"50%",border:"2px solid "+A.cy+"22",animation:"ripple 2s ease infinite"}}),
h("div",{style:{width:"150px",height:"150px",borderRadius:"50%",background:"radial-gradient(circle,"+A.cy+"10,transparent 70%)",display:"flex",alignItems:"center",justifyContent:"center",animation:"breathe 3s ease infinite"}},
h("div",{style:{width:"46px",height:"46px",borderRadius:"50%",background:GR.cool,opacity:".5"}}))));
d.appendChild(h("div",{style:{fontSize:"16px",fontWeight:"700",color:A.cy}},t("countAlong")));
d.appendChild(h("div",{style:{fontSize:"12px",color:T.mt,marginTop:"4px",fontStyle:"italic"}},t("timerSince")));R(d)}

function zeitEst(){sx.good();vb([50,25,50]);
var d=h("div",{style:{textAlign:"center",padding:"14px 0",animation:"up .4s ease"}});
d.appendChild(h("div",{style:{fontSize:"60px",fontWeight:"900",background:GR.warm,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",marginBottom:"16px",animation:"pop .3s ease"}},t("stop")));
d.appendChild(h("div",{style:{fontSize:"18px",fontWeight:"800",color:T.tx,marginBottom:"16px"}},t("howLong")));
var inp=h("input",{type:"text",inputMode:"decimal",placeholder:"0.00",style:{width:"130px",textAlign:"center",fontSize:"42px",fontWeight:"900",color:T.tx,fontFamily:"monospace",border:"none",borderBottom:"3px solid "+T.ln,background:"transparent",padding:"3px 0"}});
inp.addEventListener("input",function(){inp.value=inp.value.replace(/[^0-9.]/g,"");inp.style.borderBottomColor=inp.value?A.cy:T.ln});
d.appendChild(h("div",{style:cd({display:"inline-block",padding:"18px 24px",borderTop:"3px solid "+A.cy,maxWidth:"240px"})},h("div",{style:{fontSize:"9px",color:T.mt,letterSpacing:"2px",textTransform:"uppercase",marginBottom:"6px"}},t("yourEst")),h("div",{style:{display:"flex",alignItems:"baseline",justifyContent:"center",gap:"3px"}},inp,h("span",{style:{fontSize:"18px",color:T.mt}},"s"))));
var sb2=h("button",{style:btnS(true,{marginTop:"16px"}),onClick:function(){var g=parseFloat(inp.value);if(isNaN(g)||g<=0)return;sx.tap();so.emit("submit",{time:g});sb2.disabled=true;sb2.textContent=t("waiting")}},t("submit"));
d.appendChild(sb2);R(d);setTimeout(function(){inp.focus()},120)}

function results(data){var d=h("div",{style:{maxWidth:"380px",margin:"0 auto",animation:"up .3s ease"}});
d.appendChild(h("div",{style:{textAlign:"center",marginBottom:"14px"}},h("div",{style:{fontSize:"11px",color:T.mt,letterSpacing:"3px",textTransform:"uppercase"}},t("elimRnd")+" "+data.round),h("div",{style:{fontSize:"12px",color:T.sub,marginTop:"4px"}},t("tgt")+": "+data.target.toFixed(1)+"s")));
data.results.forEach(function(r,i){var g=gr(r.ms);d.appendChild(h("div",{style:cd({display:"flex",alignItems:"center",gap:"10px",padding:"11px 14px",marginBottom:"7px",borderLeft:"3px solid "+(r.elim?A.ro:g.c),background:r.elim?A.ro+"15":T.card,animation:"sL .4s ease "+i*.08+"s both"})},
h("div",{style:{fontSize:"20px",width:"30px",textAlign:"center"}},r.elim?"💀":medal(r.rank)),
h("div",{style:{flex:"1"}},h("div",{style:{fontWeight:"700",fontSize:"13px",color:r.elim?A.ro:T.tx,textDecoration:r.elim?"line-through":"none"}},r.name+(r.id===myId?" (Du)":"")),h("div",{style:{fontSize:"11px",color:T.sub,fontFamily:"monospace"}},r.time.toFixed(3)+"s")),
h("div",{style:{fontFamily:"monospace",fontWeight:"800",fontSize:"14px",color:g.c}},r.ms+"ms")))});
var el=data.results.filter(function(r){return r.elim})[0];
if(el)d.appendChild(h("div",{style:{textAlign:"center",color:A.ro,fontSize:"13px",fontWeight:"700",margin:"8px 0",animation:"shake .5s ease"}},"💀 "+el.name+" "+t("isOut")));
if(isH)d.appendChild(h("div",{style:{textAlign:"center",marginTop:"14px"}},h("button",{style:btnS(true),onClick:function(){so.emit("nextRound")}},t("next"))));
else d.appendChild(h("div",{style:{textAlign:"center",marginTop:"14px",color:T.sub,fontSize:"12px",animation:"pulse 1.5s ease infinite"}},t("discuss")));
R(d);sx.good();vb(25)}

function winner(data){var d=h("div",{style:{textAlign:"center",animation:"pop .5s ease",paddingTop:"30px"}});
var cf=h("div",{style:{position:"fixed",inset:"0",pointerEvents:"none",overflow:"hidden",zIndex:"999"}});
[A.v,A.pk,A.am,A.em,A.cy,A.or].forEach(function(c){for(var i=0;i<5;i++){var x=document.createElement("div");x.style.cssText="position:absolute;top:-12px;left:"+Math.random()*100+"%;width:"+(5+Math.random()*8)+"px;height:"+(5+Math.random()*8)+"px;border-radius:"+(i%3===0?"50%":"2px")+";background:"+c+";animation:conf "+(1.2+Math.random()*1.3)+"s ease "+Math.random()*1.3+"s forwards";cf.appendChild(x)}});d.appendChild(cf);
d.appendChild(h("div",{style:{fontSize:"60px",animation:"float 2s ease infinite",marginBottom:"8px"}},"🏆"));
d.appendChild(h("div",{style:{fontSize:"28px",fontWeight:"900",background:"linear-gradient(135deg,"+A.am+",#FBBF24)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}},data.winner));
d.appendChild(h("div",{style:{fontSize:"12px",color:T.sub,marginTop:"4px"}},t("winsTrn")));
d.appendChild(h("button",{style:btnS(true,{marginTop:"24px"}),onClick:home},t("home")));R(d);sx.win();vb([25,40,25,40,70])}

function roleReveal(role){var rc2=role==="fake"?A.or:role==="saboteur"?A.ro:A.em;
var d=h("div",{style:{textAlign:"center",padding:"30px 16px",animation:"pop .4s ease"}});
d.appendChild(h("div",{style:{fontSize:"13px",color:T.sub,marginBottom:"14px"}},t("noShow")));
var hb=h("button",{style:cd({padding:"28px 32px",cursor:"pointer",borderStyle:"dashed",display:"inline-block"}),onClick:function(){sx.tap();vb(25);hb.remove();
d.appendChild(h("div",{style:{animation:"pop .3s ease"}},
h("div",{style:cd({padding:"20px 24px",marginBottom:"16px",borderTop:"3px solid "+rc2})},h("div",{style:{fontSize:"28px",fontWeight:"900",color:rc2}},role==="fake"?"🎭 "+t("fake"):role==="saboteur"?"🗡️ "+t("sab"):"✅ "+t("norm")),h("div",{style:{fontSize:"11px",color:T.sub,marginTop:"6px"}},role==="fake"?t("fakeD"):role==="saboteur"?t("sabD"):t("normD"))),
h("div",{style:{fontSize:"12px",color:T.sub,animation:"pulse 1.5s ease infinite"}},t("waitPl"))))}},h("div",{style:{fontSize:"14px",color:T.sub}},t("tapSee")));
d.appendChild(hb);R(d);sx.drama()}

function fakePrompt(time){var d=h("div",{style:{textAlign:"center",padding:"40px 16px",animation:"pop .3s ease"}});
d.appendChild(h("div",{style:{fontSize:"22px",fontWeight:"800",color:A.or,marginBottom:"8px"}},"🎭 "+t("fake")));
d.appendChild(h("div",{style:{fontSize:"12px",color:T.mt,marginBottom:"16px"}},time.toFixed(3)+"s"));
d.appendChild(h("div",{style:{display:"flex",gap:"10px",justifyContent:"center"}},
h("button",{style:btnS(false,{background:GR.cool}),onClick:function(){so.emit("fakeAct",{dir:"minus"});waitingScreen()}},"-0.4s"),
h("button",{style:btnS(false),onClick:function(){so.emit("fakeSkip");waitingScreen()}},t("skip")),
h("button",{style:btnS(false,{background:GR.warm}),onClick:function(){so.emit("fakeAct",{dir:"plus"});waitingScreen()}},"+0.4s")));R(d)}

function sabPrompt(targets){var d=h("div",{style:{textAlign:"center",padding:"40px 16px",animation:"pop .3s ease"}});
d.appendChild(h("div",{style:{fontSize:"22px",fontWeight:"800",color:A.ro,marginBottom:"16px"}},"🗡️ "+t("sabotage")));
var l=h("div",{style:{display:"flex",flexDirection:"column",gap:"8px"}});
targets.forEach(function(tg){l.appendChild(h("button",{style:cd({padding:"14px 18px",cursor:"pointer",textAlign:"left"}),onClick:function(){so.emit("sabAct",{targetId:tg.id});waitingScreen()}},h("span",{style:{fontWeight:"700",fontSize:"14px",color:T.tx}},tg.name)))});
l.appendChild(h("button",{style:btnS(false,{marginTop:"6px"}),onClick:function(){so.emit("sabSkip");waitingScreen()}},t("skip")));
d.appendChild(l);R(d)}

function waitingScreen(){R(h("div",{style:{textAlign:"center",padding:"60px 16px",animation:"fadeIn .4s ease"}},
h("div",{style:{display:"flex",gap:"6px",justifyContent:"center",marginBottom:"8px"}},[0,1,2].map(function(i){return h("div",{style:{width:"8px",height:"8px",borderRadius:"4px",background:A.v,animation:"dotP 1.2s ease "+i*.2+"s infinite"}})})),
h("div",{style:{fontSize:"14px",color:T.sub}},t("calc"))))}

function voteScreen(players){var fg=null,sg=null;
var d=h("div",{style:{textAlign:"center",padding:"16px",animation:"up .4s ease"}});
d.appendChild(h("div",{style:{fontSize:"22px",fontWeight:"800",marginBottom:"14px",background:GR.brand,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}},t("vote")));
[[t("whoFake"),A.or,"fg"],[t("whoSab"),A.ro,"sg"]].forEach(function(arr){
var q=arr[0],col=arr[1],vr=arr[2];
d.appendChild(h("div",{style:{fontSize:"14px",fontWeight:"700",color:T.tx,marginBottom:"8px"}},q));
var dv=h("div",{style:{display:"flex",gap:"6px",justifyContent:"center",flexWrap:"wrap",marginBottom:"14px"}});
players.filter(function(p){return p.id!==myId}).forEach(function(p){var b=h("button",{style:cd({padding:"10px 16px",cursor:"pointer"}),onClick:function(){sx.tap();if(vr==="fg")fg=p.id;else sg=p.id;dv.querySelectorAll("button").forEach(function(x){x.style.background=T.card;x.style.borderColor=T.ln});b.style.background=col+"20";b.style.borderColor=col}},h("span",{style:{fontWeight:"700",fontSize:"13px",color:T.tx}},p.name));dv.appendChild(b)});d.appendChild(dv)});
d.appendChild(h("button",{style:btnS(true,{width:"100%"}),onClick:function(){if(!fg||!sg)return;so.emit("vote",{fakeGuess:fg,sabGuess:sg});waitingScreen()}},t("vote")));R(d)}

function tbReveal(data){var d=h("div",{style:{textAlign:"center",padding:"20px 12px",animation:"pop .5s ease"}});
var cf=h("div",{style:{position:"fixed",inset:"0",pointerEvents:"none",overflow:"hidden",zIndex:"999"}});
[A.v,A.pk,A.am,A.em,A.cy,A.or].forEach(function(c){for(var i=0;i<5;i++){var x=document.createElement("div");x.style.cssText="position:absolute;top:-12px;left:"+Math.random()*100+"%;width:"+(5+Math.random()*8)+"px;height:"+(5+Math.random()*8)+"px;border-radius:"+(i%3===0?"50%":"2px")+";background:"+c+";animation:conf "+(1.2+Math.random()*1.3)+"s ease "+Math.random()*1.3+"s forwards";cf.appendChild(x)}});d.appendChild(cf);
d.appendChild(h("div",{style:{fontSize:"24px",fontWeight:"900",color:T.tx,marginBottom:"14px"}},t("revealed")));
(st.players||[]).forEach(function(p,i){var role=(data.roles||{})[p.id]||"normal";var rc2=role==="fake"?A.or:role==="saboteur"?A.ro:A.em;
d.appendChild(h("div",{style:cd({padding:"14px 16px",marginBottom:"8px",borderLeft:"4px solid "+rc2,textAlign:"left",animation:"sL .4s ease "+i*.1+"s both"})},
h("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center"}},
h("span",{style:{fontWeight:"800",fontSize:"14px",color:T.tx}},p.name+(p.id===myId?" (Du)":"")),
h("span",{style:{fontWeight:"800",fontSize:"12px",color:rc2}},role==="fake"?"🎭 "+t("fake"):role==="saboteur"?"🗡️ "+t("sab"):"✅ "+t("norm")))))});
var wc=data.normalWin?A.em:A.ro;
d.appendChild(h("div",{style:cd({padding:"16px",marginTop:"12px",textAlign:"center",borderTop:"3px solid "+wc})},
h("div",{style:{fontSize:"18px",fontWeight:"900",color:wc,marginBottom:"4px"}},data.normalWin?t("normWin"):t("cheatWin")),
h("div",{style:{fontSize:"11px",color:T.sub}},t("fake")+" "+(data.fakeFound?t("exposed"):t("undetected"))+" ("+data.fV+"/"+data.maj+") · "+t("sab")+" "+(data.sabFound?t("exposed"):t("undetected"))+" ("+data.sV+"/"+data.maj+")")));
d.appendChild(h("button",{style:btnS(true,{marginTop:"16px"}),onClick:home},t("home")));R(d);sx.drama();vb([25,40,25,40,70])}

so.on("state",function(s){st=s;if(st.status==="lobby")upl();if(st.status==="hidden")waitingScreen()});
so.on("roundStart",function(d){if(st.mode==="zeit")zeitGo();else buzzer(d.target)});
so.on("zeitStop",function(){zeitEst()});
so.on("roundResults",function(d){results(d)});
so.on("gameEnd",function(d){winner(d)});
so.on("role",function(d){roleReveal(d.role)});
so.on("fakePrompt",function(d){fakePrompt(d.time)});
so.on("sabPrompt",function(d){sabPrompt(d.targets)});
so.on("voteStart",function(d){voteScreen(d.players)});
so.on("tbReveal",function(d){tbReveal(d)});
home()
<\/script></body></html>
`;
srv.listen(PORT,function(){console.log("TimeTap on :"+PORT)});
