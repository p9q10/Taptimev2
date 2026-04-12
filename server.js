const express=require("express"),http=require("http"),{Server}=require("socket.io"),path=require("path");
const app=express(),srv=http.createServer(app),io=new Server(srv,{cors:{origin:"*"},pingTimeout:30000,pingInterval:10000});
const PORT=process.env.PORT||3000;
app.use(express.static(path.join(__dirname,"public")));
const rooms=new Map();
const CH="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function mkCode(){let c;do{c="";for(let i=0;i<4;i++)c+=CH[Math.floor(Math.random()*CH.length)]}while(rooms.has(c));return c}
function rng(a,b){return Math.floor(Math.random()*(b-a+1))+a}

// Unified: 0.5-5s, max 1 decimal
function genTarget(){
  const vals=[];for(let v=0.5;v<=5;v+=0.5)vals.push(v);
  // Also add some .1/.2/.3 etc for variety
  for(let v=0.5;v<=5;v+=0.1)vals.push(parseFloat(v.toFixed(1)));
  return vals[Math.floor(Math.random()*vals.length)];
}

function genRoundData(mode,format,round){
  switch(mode){
    case"bullseye":{
      const tgt=genTarget();
      return{targetTime:tgt,teamMode:format==="teams"};
    }
    case"timesense":{
      const dur=genTarget(); // 0.5-5s hidden
      const waitDelay=parseFloat((2+Math.random()*3).toFixed(1));
      return{hiddenDuration:dur,waitDelay};
    }
    case"memory":{
      const decimals=Math.random()>.5?4:3;
      const val=parseFloat((0.5+Math.random()*4.5).toFixed(decimals));
      return{shownTime:val,showDuration:rng(200,350),decimals};
    }
    case"reaction":{
      const greenIdx=rng(0,9); // which of 10 buzzers turns green
      return{greenIdx};
    }
    default:return{};
  }
}

function makeRoom(code,sk,name,avatar,mode,format,roundsPerPhase){
  return{code,phase:"lobby",mode:mode||"bullseye",format:format||"ffa",
    roundsPerPhase:roundsPerPhase||3,currentRound:0,currentPhaseRound:0,
    players:[{id:sk.id,name,avatar,team:null,connected:true,eliminated:false}],
    hostId:sk.id,roundData:null,results:null,subs:{},teamSubs:{},
    scores:{},phaseScores:{},finalScores:null,zeitTimers:[]}
}

function roomState(room){
  var subMap={};Object.keys(room.subs||{}).forEach(k=>{subMap[k]=true});
  var tSubMap={};Object.keys(room.teamSubs||{}).forEach(k=>{tSubMap[k]=true});
  return{code:room.code,phase:room.phase,mode:room.mode,format:room.format,
    roundsPerPhase:room.roundsPerPhase,currentRound:room.currentRound,
    currentPhaseRound:room.currentPhaseRound,
    roundData:room.roundData,
    players:room.players.map(p=>({id:p.id,name:p.name,avatar:p.avatar,team:p.team,connected:p.connected,eliminated:p.eliminated})),
    results:room.results,finalScores:room.finalScores,
    scores:room.scores,phaseScores:room.phaseScores,
    hostId:room.hostId,subs:subMap,teamSubs:tSubMap};
}
function bc(room){const s=roomState(room);room.players.forEach(p=>{io.to(p.id).emit("sync",{...s,myId:p.id})})}
function findRoom(sid){for(const[c,r]of rooms){const p=r.players.find(x=>x.id===sid);if(p)return{code:c,room:r,player:p}}return null}
function clearTimers(room){(room.zeitTimers||[]).forEach(t=>clearTimeout(t));room.zeitTimers=[]}
function activePlayers(room){return room.players.filter(p=>p.connected&&!p.eliminated)}

// Remove player from any room they're in
function leaveCurrentRoom(sk){
  const f=findRoom(sk.id);if(!f)return;
  const{code,room,player}=f;
  player.connected=false;
  room.players=room.players.filter(p=>p.id!==sk.id);
  sk.leave(code);
  const connected=room.players.filter(p=>p.connected);
  if(connected.length===0){clearTimers(room);rooms.delete(code)}
  else{if(room.hostId===sk.id)room.hostId=connected[0].id;bc(room)}
}

function scheduleZeitStop(room){
  if(room.mode!=="timesense"||!room.roundData.hiddenDuration)return;
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
  room.results=null;room.finalScores=null;room.roundData=null;
  room.scores={};room.phaseScores={};
  room.players.forEach(p=>{room.scores[p.id]=0;room.phaseScores[p.id]=0;p.eliminated=false});
}

function startRound(room){
  room.currentRound++;room.currentPhaseRound++;
  room.roundData=genRoundData(room.mode,room.format,room.currentRound);
  room.subs={};room.teamSubs={};room.results=null;
  room.phase="playing";bc(room);
  scheduleZeitStop(room);
}

// After round results: check elimination logic for FFA
function checkElimination(room){
  if(room.format!=="ffa")return false;
  if(room.currentPhaseRound<room.roundsPerPhase)return false;
  // Phase complete: eliminate worst performer
  const active=activePlayers(room);
  if(active.length<=1)return false;
  // Find worst phaseScore
  let worstId=null,worstScore=Infinity;
  active.forEach(p=>{
    const s=room.phaseScores[p.id]||0;
    if(s<worstScore||(s===worstScore&&Math.random()>.5)){worstScore=s;worstId=p.id}
  });
  if(worstId){
    const wp=room.players.find(p=>p.id===worstId);
    if(wp)wp.eliminated=true;
  }
  // Reset phase scores for next elimination phase
  room.currentPhaseRound=0;
  room.phaseScores={};activePlayers(room).forEach(p=>{room.phaseScores[p.id]=0});
  // Check if only 1 left = game over
  if(activePlayers(room).length<=1)return true; // game over
  return false; // eliminated but continue
}

io.on("connection",sk=>{
  sk.on("leave",()=>{leaveCurrentRoom(sk)});

  sk.on("create",({name,avatar,mode,format,roundsPerPhase},cb)=>{
    if(!name)return cb({ok:false,err:"Name fehlt"});
    leaveCurrentRoom(sk); // leave any old room first
    const code=mkCode();
    const room=makeRoom(code,sk,name,avatar,mode,format,roundsPerPhase);
    room.scores[sk.id]=0;room.phaseScores[sk.id]=0;
    rooms.set(code,room);sk.join(code);cb({ok:true,code});bc(room);
  });

  sk.on("join",({code,name,avatar},cb)=>{
    leaveCurrentRoom(sk); // leave any old room first
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
  sk.on("updateSettings",({mode,format,roundsPerPhase})=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    if(mode)room.mode=mode;if(format)room.format=format;if(roundsPerPhase)room.roundsPerPhase=roundsPerPhase;bc(room);
  });

  sk.on("start",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    const connected=room.players.filter(p=>p.connected);if(connected.length<2)return;
    if(room.format==="teams")connected.forEach((p,i)=>{if(!p.team)p.team=i%2===0?"a":"b"});
    fullReset(room);room.phase="pregame";bc(room);
  });

  sk.on("startFirstRound",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    startRound(room);
  });

  sk.on("submit",({value})=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;
    if(room.phase!=="playing")return;if(room.subs[sk.id])return;
    if(f.player.eliminated)return; // eliminated players can't submit
    room.subs[sk.id]={pid:sk.id,name:f.player.name,avatar:f.player.avatar,value,ts:Date.now()};
    bc(room);
    const active=activePlayers(room);
    if(Object.keys(room.subs).length>=active.length){
      const sorted=Object.values(room.subs).sort((a,b)=>a.value-b.value);
      sorted.forEach((r,i)=>{
        const pts=Math.max(sorted.length-i,1);
        room.scores[r.pid]=(room.scores[r.pid]||0)+pts;
        room.phaseScores[r.pid]=(room.phaseScores[r.pid]||0)+pts;
      });
      room.results=sorted;room.phase="results";bc(room);
    }
  });

  sk.on("teamSubmit",({value})=>{const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.phase!=="playing")return;room.teamSubs[sk.id]={pid:sk.id,name:f.player.name,value};bc(room)});

  sk.on("teamConfirm",({teamTotal})=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.phase!=="playing")return;
    const team=f.player.team;if(!team)return;
    const tgt=room.roundData.targetTime;const dev=Math.abs(teamTotal-tgt);
    const devSec=parseFloat(dev.toFixed(1));
    room.players.filter(p=>p.team===team&&p.connected&&!p.eliminated).forEach(p=>{
      if(!room.subs[p.id])room.subs[p.id]={pid:p.id,name:p.name,avatar:p.avatar,value:devSec};
    });
    bc(room);
    const active=activePlayers(room);
    if(Object.keys(room.subs).length>=active.length){
      const sorted=Object.values(room.subs).sort((a,b)=>a.value-b.value);
      room.players.filter(p=>p.connected&&!p.eliminated).forEach(p=>{
        const isA=p.team==="a";
        const teamASubs=sorted.filter(s=>{const pl=room.players.find(x=>x.id===s.pid);return pl&&pl.team==="a"});
        const teamBSubs=sorted.filter(s=>{const pl=room.players.find(x=>x.id===s.pid);return pl&&pl.team==="b"});
        const avgA=teamASubs.length?teamASubs.reduce((s,r)=>s+r.value,0)/teamASubs.length:99;
        const avgB=teamBSubs.length?teamBSubs.reduce((s,r)=>s+r.value,0)/teamBSubs.length:99;
        const won=(isA&&avgA<=avgB)||(!isA&&avgB<avgA);
        room.scores[p.id]=(room.scores[p.id]||0)+(won?3:1);
      });
      room.results=sorted;room.phase="results";bc(room);
    }
  });

  sk.on("nextRound",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    clearTimers(room);
    // Check elimination
    const gameOver=checkElimination(room);
    if(gameOver){
      room.finalScores={...room.scores};room.phase="gameover";bc(room);
      return;
    }
    // If elimination happened, broadcast first to show who's out
    if(room.format==="ffa"&&room.currentPhaseRound===0){
      room.phase="elimination";bc(room);return;
    }
    startRound(room);
  });

  sk.on("continueAfterElim",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    startRound(room);
  });

  sk.on("endGame",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    clearTimers(room);room.finalScores={...room.scores};room.phase="gameover";bc(room);
  });

  sk.on("playAgain",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    fullReset(room);room.phase="lobby";bc(room);
  });

  sk.on("disconnect",()=>{const f=findRoom(sk.id);if(!f)return;const{code,room,player}=f;
    player.connected=false;if(room.phase==="lobby")room.players=room.players.filter(p=>p.id!==sk.id);
    const connected=room.players.filter(p=>p.connected);
    if(connected.length===0){setTimeout(()=>{const r=rooms.get(code);if(r&&r.players.every(p=>!p.connected)){clearTimers(r);rooms.delete(code)}},60000)}
    else{if(room.hostId===sk.id)room.hostId=connected[0].id}bc(room)});
});
app.get("/",(q,s)=>s.sendFile(path.join(__dirname,"public","index.html")));
app.get("/health",(q,s)=>s.json({ok:true,rooms:rooms.size}));
srv.listen(PORT,()=>console.log("TimeTap on :"+PORT));
