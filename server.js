const express=require("express"),http=require("http"),{Server}=require("socket.io"),path=require("path");
const app=express(),srv=http.createServer(app),io=new Server(srv,{cors:{origin:"*"},pingTimeout:30000,pingInterval:10000});
const PORT=process.env.PORT||3000;
app.use(express.static(path.join(__dirname,"public")));
const rooms=new Map();
const CH="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function mkCode(){let c;do{c="";for(let i=0;i<4;i++)c+=CH[Math.floor(Math.random()*CH.length)]}while(rooms.has(c));return c}
function rng(a,b){return Math.floor(Math.random()*(b-a+1))+a}
const GAME_MODES=["bullseye","timesense","memory","reaction","countdown"];
function pickMode(room){
  var h=room.modeHistory||[];
  var attempts=0,mode;
  do{mode=GAME_MODES[Math.floor(Math.random()*GAME_MODES.length)];attempts++}
  while(attempts<3&&h.length>=2&&h[h.length-1]===mode&&h[h.length-2]===mode);
  h.push(mode);if(h.length>5)h.shift();
  room.modeHistory=h;
  return mode;
}

// Unified: 0.5-5s, max 1 decimal
function genTarget(){return parseFloat((0.5+Math.random()*4.5).toFixed(1))}

function genRoundData(mode,format){
  switch(mode){
    case"bullseye":return{targetTime:genTarget()};
    case"timesense":{
      const dur=genTarget();
      const waitDelay=parseFloat((2+Math.random()*3).toFixed(1));
      return{hiddenDuration:dur,waitDelay};
    }
    case"memory":{
      const dec=Math.random()>.5?4:3;
      return{shownTime:parseFloat((0.5+Math.random()*4.5).toFixed(dec)),showDuration:105,decimals:dec};
    }
    case"reaction":return{greenIdx:rng(0,9)};
    case"countdown":return{targetTime:parseFloat((2+Math.random()*6).toFixed(1)),duration:7000,power:2.5};
    default:return{};
  }
}

function makeRoom(code,sk,name,avatar,format,roundsPerPhase){
  return{code,phase:"lobby",mode:null,format:format||"ffa",
    roundsPerPhase:roundsPerPhase||3,currentRound:0,currentPhaseRound:0,
    players:[{id:sk.id,name,avatar,team:null,connected:true,eliminated:false}],
    hostId:sk.id,roundData:null,results:null,subs:{},teamSubs:{},
    scores:{},phaseScores:{},finalScores:null,zeitTimers:[],modeHistory:[],playerStates:{}}
}

function roomState(room){
  var subMap={};Object.keys(room.subs||{}).forEach(k=>{subMap[k]=true});
  var tSubMap={};Object.keys(room.teamSubs||{}).forEach(k=>{tSubMap[k]=true});
  return{code:room.code,phase:room.phase,mode:room.mode,format:room.format,
    roundsPerPhase:room.roundsPerPhase,currentRound:room.currentRound,
    currentPhaseRound:room.currentPhaseRound,roundData:room.roundData,
    players:room.players.map(p=>({id:p.id,name:p.name,avatar:p.avatar,team:p.team,connected:p.connected,eliminated:p.eliminated})),
    results:room.results,finalScores:room.finalScores,teamScores:room.teamScores||null,
    scores:room.scores,phaseScores:room.phaseScores,
    hostId:room.hostId,subs:subMap,teamSubs:tSubMap};
}
function bc(room){const s=roomState(room);room.players.forEach(p=>{io.to(p.id).emit("sync",{...s,myId:p.id})})}
function findRoom(sid){for(const[c,r]of rooms){const p=r.players.find(x=>x.id===sid);if(p)return{code:c,room:r,player:p}}return null}
function clearTimers(room){(room.zeitTimers||[]).forEach(t=>clearTimeout(t));room.zeitTimers=[]}
function activePlayers(room){return room.players.filter(p=>p.connected&&!p.eliminated)}

function leaveCurrentRoom(sk){
  const f=findRoom(sk.id);if(!f)return;
  const{code,room}=f;
  room.players=room.players.filter(p=>p.id!==sk.id);
  sk.leave(code);
  const connected=room.players.filter(p=>p.connected);
  if(connected.length===0){clearTimers(room);rooms.delete(code)}
  else{if(room.hostId===sk.id)room.hostId=connected[0].id;bc(room)}
}

function scheduleZeitStop(room){
  if(room.mode!=="timesense"||!room.roundData||!room.roundData.hiddenDuration)return;
  clearTimers(room);
  const dur=room.roundData.hiddenDuration,wait=room.roundData.waitDelay||3,rnd=room.currentRound;
  const t=setTimeout(()=>{
    if(room.phase==="playing"&&room.currentRound===rnd)io.to(room.code).emit("zeitStop",{actual:dur});
  },(wait+dur)*1000);
  room.zeitTimers.push(t);
}

function fullReset(room){
  clearTimers(room);
  room.currentRound=0;room.currentPhaseRound=0;room.subs={};room.teamSubs={};
  room.results=null;room.finalScores=null;room.roundData=null;room.mode=null;
  room.scores={};room.phaseScores={};room.modeHistory=[];room.zeitStartedAt=null;room.teamScores=null;room.playerStates={};
  room.players.forEach(p=>{room.scores[p.id]=0;room.phaseScores[p.id]=0;p.eliminated=false});
}

// Spin phase: pick random mode, prepare round data
function spinForRound(room){
  // Safety: prevent overflow rounds in teams mode
  if(room.format==="teams"&&room.currentRound>=room.roundsPerPhase){
    room.finalScores={...room.scores};room.phase="gameover";bc(room);return;
  }
  room.currentRound++;room.currentPhaseRound++;
  room.mode=pickMode(room);
  room.roundData=genRoundData(room.mode,room.format);
  room.subs={};room.teamSubs={};room.results=null;room.teamScores=null;room.playerStates={};
  room.phase="spin";bc(room);
}

function checkElimination(room){
  if(room.format!=="ffa")return false;
  if(room.currentPhaseRound<room.roundsPerPhase)return false;
  const active=activePlayers(room);
  if(active.length<=1)return false;
  let worstId=null,worstScore=Infinity;
  active.forEach(p=>{
    const s=room.phaseScores[p.id]||0;
    if(s<worstScore||(s===worstScore&&Math.random()>.5)){worstScore=s;worstId=p.id}
  });
  if(worstId){const wp=room.players.find(p=>p.id===worstId);if(wp)wp.eliminated=true}
  room.currentPhaseRound=0;
  room.phaseScores={};activePlayers(room).forEach(p=>{room.phaseScores[p.id]=0});
  if(activePlayers(room).length<=1)return true;
  return false;
}

io.on("connection",sk=>{
  sk.on("leave",()=>{leaveCurrentRoom(sk)});

  sk.on("create",({name,avatar,format,roundsPerPhase},cb)=>{
    if(!name)return cb({ok:false,err:"Name fehlt"});
    leaveCurrentRoom(sk);
    const code=mkCode();
    const room=makeRoom(code,sk,name,avatar,format,roundsPerPhase);
    room.scores[sk.id]=0;room.phaseScores[sk.id]=0;
    rooms.set(code,room);sk.join(code);cb({ok:true,code});bc(room);
  });

  sk.on("join",({code,name,avatar},cb)=>{
    leaveCurrentRoom(sk);
    const room=rooms.get(code&&code.toUpperCase());
    if(!room)return cb({ok:false,err:"Raum nicht gefunden"});
    if(room.phase!=="lobby")return cb({ok:false,err:"Spiel läuft"});
    if(room.players.length>=8)return cb({ok:false,err:"Voll"});
    if(room.players.find(p=>p.name===name))return cb({ok:false,err:"Name vergeben"});
    room.players.push({id:sk.id,name,avatar,team:null,connected:true,eliminated:false});
    room.scores[sk.id]=0;room.phaseScores[sk.id]=0;
    sk.join(code.toUpperCase());cb({ok:true,code:code.toUpperCase()});bc(room);
  });

  sk.on("setTeam",({team})=>{const f=findRoom(sk.id);if(!f)return;f.player.team=team;bc(f.room)});
  sk.on("updateSettings",({format,roundsPerPhase})=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    if(format)room.format=format;if(roundsPerPhase)room.roundsPerPhase=roundsPerPhase;bc(room);
  });

  sk.on("start",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    const connected=room.players.filter(p=>p.connected);if(connected.length<2)return;
    if(room.format==="teams")connected.forEach((p,i)=>{if(!p.team)p.team=i%2===0?"a":"b"});
    fullReset(room);room.phase="pregame";bc(room);
  });

  // After pregame → first spin
  sk.on("startFirstRound",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    spinForRound(room);
  });

  // After spin animation → begin playing
  sk.on("beginPlay",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    room.phase="playing";
    if(room.mode==="timesense")room.zeitStartedAt=Date.now();
    bc(room);
    scheduleZeitStop(room);
  });

  sk.on("submit",({value})=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;
    if(room.phase!=="playing")return;if(room.subs[sk.id])return;
    if(f.player.eliminated)return;
    room.subs[sk.id]={pid:sk.id,name:f.player.name,avatar:f.player.avatar,value,ts:Date.now()};
    bc(room);
    const active=activePlayers(room);
    if(Object.keys(room.subs).length>=active.length){
      const sorted=Object.values(room.subs).sort((a,b)=>a.value-b.value);
      if(room.format==="teams"){
        const teamA=sorted.filter(s=>{const pl=room.players.find(x=>x.id===s.pid);return pl&&pl.team==="a"});
        const teamB=sorted.filter(s=>{const pl=room.players.find(x=>x.id===s.pid);return pl&&pl.team==="b"});
        const sumA=teamA.reduce((s,r)=>s+r.value,0);
        const sumB=teamB.reduce((s,r)=>s+r.value,0);
        room.teamScores={a:sumA,b:sumB};
        room.players.filter(p=>p.connected&&!p.eliminated).forEach(p=>{
          const won=(p.team==="a"&&sumA<=sumB)||(p.team==="b"&&sumB<sumA);
          room.scores[p.id]=(room.scores[p.id]||0)+(won?3:1);
        });
      }else{
        sorted.forEach((r,i)=>{
          const pts=Math.max(sorted.length-i,1);
          room.scores[r.pid]=(room.scores[r.pid]||0)+pts;
          room.phaseScores[r.pid]=(room.phaseScores[r.pid]||0)+pts;
        });
      }
      room.results=sorted;room.phase="results";bc(room);
    }
  });

  sk.on("teamSubmit",({value})=>{const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.phase!=="playing")return;room.teamSubs[sk.id]={pid:sk.id,name:f.player.name,value};bc(room)});

  sk.on("teamConfirm",({teamTotal})=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.phase!=="playing")return;
    const team=f.player.team;if(!team)return;
    const tgt=room.roundData.targetTime;const dev=Math.abs(teamTotal-tgt);
    room.players.filter(p=>p.team===team&&p.connected&&!p.eliminated).forEach(p=>{
      if(!room.subs[p.id])room.subs[p.id]={pid:p.id,name:p.name,avatar:p.avatar,value:dev};
    });
    bc(room);
    const active=activePlayers(room);
    if(Object.keys(room.subs).length>=active.length){
      const sorted=Object.values(room.subs).sort((a,b)=>a.value-b.value);
      const teamASubs=sorted.filter(s=>{const pl=room.players.find(x=>x.id===s.pid);return pl&&pl.team==="a"});
      const teamBSubs=sorted.filter(s=>{const pl=room.players.find(x=>x.id===s.pid);return pl&&pl.team==="b"});
      const avgA=teamASubs.length?teamASubs.reduce((s,r)=>s+r.value,0)/teamASubs.length:99;
      const avgB=teamBSubs.length?teamBSubs.reduce((s,r)=>s+r.value,0)/teamBSubs.length:99;
      room.players.filter(p=>p.connected&&!p.eliminated).forEach(p=>{
        const won=(p.team==="a"&&avgA<=avgB)||(p.team==="b"&&avgB<avgA);
        room.scores[p.id]=(room.scores[p.id]||0)+(won?3:1);
      });
      room.results=sorted;room.phase="results";bc(room);
    }
  });

  sk.on("nextRound",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    clearTimers(room);
    // Team mode: enforce round limit
    if(room.format==="teams"){
      if(room.currentRound>=room.roundsPerPhase){
        room.finalScores={...room.scores};room.phase="gameover";bc(room);return;
      }
      spinForRound(room);return;
    }
    const gameOver=checkElimination(room);
    if(gameOver){room.finalScores={...room.scores};room.phase="gameover";bc(room);return}
    if(room.format==="ffa"&&room.currentPhaseRound===0){room.phase="elimination";bc(room);return}
    spinForRound(room);
  });

  sk.on("continueAfterElim",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    spinForRound(room);
  });

  sk.on("endGame",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    clearTimers(room);room.finalScores={...room.scores};room.phase="gameover";bc(room);
  });

  sk.on("playAgain",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    fullReset(room);room.phase="lobby";bc(room);
  });

  // Spectator: eliminated player selects who to watch
  sk.on("spectate",({targetPid})=>{
    const f=findRoom(sk.id);if(!f||!f.player.eliminated)return;
    f.player.spectating=targetPid||null;
    // Send current stored state of target
    if(targetPid&&f.room.playerStates[targetPid]){
      sk.emit("spectatorUpdate",f.room.playerStates[targetPid]);
    }
  });

  // Active player broadcasts gameplay state for spectators
  sk.on("playerState",(state)=>{
    const f=findRoom(sk.id);if(!f||f.player.eliminated)return;
    const ps={...state,pid:sk.id,name:f.player.name,avatar:f.player.avatar};
    f.room.playerStates[sk.id]=ps;
    // Broadcast to entire room — client filters by selected player
    sk.to(f.code).emit("spectatorUpdate",ps);
  });

  // Resume/reconnect: client requests fresh state
  sk.on("requestSync",()=>{
    const f=findRoom(sk.id);if(!f)return;
    const s=roomState(f.room);
    sk.emit("sync",{...s,myId:sk.id});
    // Re-emit zeitStop if it should have already fired for this client
    if(f.room.phase==="playing"&&f.room.mode==="timesense"&&f.room.roundData&&f.room.zeitStartedAt){
      const wait=(f.room.roundData.waitDelay||3)*1000;
      const dur=(f.room.roundData.hiddenDuration||3)*1000;
      const elapsed=Date.now()-f.room.zeitStartedAt;
      if(elapsed>=wait+dur){
        sk.emit("zeitStop",{actual:f.room.roundData.hiddenDuration});
      }
    }
  });

  // Rejoin after socket reconnect (new socket ID)
  sk.on("rejoin",({code,name},cb)=>{
    if(!code||!name)return cb&&cb({ok:false,err:"Missing data"});
    const room=rooms.get(code.toUpperCase());
    if(!room)return cb&&cb({ok:false,err:"Raum nicht gefunden"});
    // Find player by name — accept BOTH connected and disconnected
    // (mobile browsers often reconnect before server detects old disconnect)
    const player=room.players.find(p=>p.name===name);
    if(!player)return cb&&cb({ok:false,err:"Spieler nicht gefunden"});
    // Skip if already this socket
    if(player.id===sk.id){player.connected=true;cb&&cb({ok:true,code:code.toUpperCase()});bc(room);return}
    // Remap old socket ID to new one
    const oldId=player.id;
    // Disconnect old socket from room if it still exists
    try{const oldSk=io.sockets.sockets.get(oldId);if(oldSk)oldSk.leave(code.toUpperCase())}catch(e){}
    player.id=sk.id;player.connected=true;
    sk.join(code.toUpperCase());
    // Update scores/subs keys from old ID to new ID
    if(room.scores[oldId]!==undefined){room.scores[sk.id]=room.scores[oldId];delete room.scores[oldId]}
    if(room.phaseScores[oldId]!==undefined){room.phaseScores[sk.id]=room.phaseScores[oldId];delete room.phaseScores[oldId]}
    if(room.subs[oldId]){room.subs[sk.id]=room.subs[oldId];room.subs[sk.id].pid=sk.id;delete room.subs[oldId]}
    if(room.teamSubs[oldId]){room.teamSubs[sk.id]=room.teamSubs[oldId];room.teamSubs[sk.id].pid=sk.id;delete room.teamSubs[oldId]}
    if(room.hostId===oldId)room.hostId=sk.id;
    // Update results if they reference old ID
    if(room.results){room.results.forEach(r=>{if(r.pid===oldId)r.pid=sk.id})}
    cb&&cb({ok:true,code:code.toUpperCase()});
    bc(room);
  });

  sk.on("disconnect",()=>{const f=findRoom(sk.id);if(!f)return;const{code,room,player}=f;
    // Only mark disconnected if this socket is still the player's current socket
    // (rejoin may have already remapped to a new socket)
    if(player.id!==sk.id)return;
    player.connected=false;if(room.phase==="lobby")room.players=room.players.filter(p=>p.id!==sk.id);
    const connected=room.players.filter(p=>p.connected);
    if(connected.length===0){setTimeout(()=>{const r=rooms.get(code);if(r&&r.players.every(p=>!p.connected)){clearTimers(r);rooms.delete(code)}},60000)}
    else{if(room.hostId===sk.id)room.hostId=connected[0].id}bc(room)});
});
app.get("/",(q,s)=>s.sendFile(path.join(__dirname,"public","index.html")));
app.get("/health",(q,s)=>s.json({ok:true,rooms:rooms.size}));
srv.listen(PORT,()=>console.log("TimeTap on :"+PORT));
