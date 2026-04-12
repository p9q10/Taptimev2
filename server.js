const express=require("express"),http=require("http"),{Server}=require("socket.io"),path=require("path");
const app=express(),srv=http.createServer(app),io=new Server(srv,{cors:{origin:"*"},pingTimeout:30000,pingInterval:10000});
const PORT=process.env.PORT||3000;
app.use(express.static(path.join(__dirname,"public")));
const rooms=new Map();
const CH="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function mkCode(){let c;do{c="";for(let i=0;i<4;i++)c+=CH[Math.floor(Math.random()*CH.length)]}while(rooms.has(c));return c}
function rng(a,b){return Math.floor(Math.random()*(b-a+1))+a}
function rngF(a,b){return Math.random()*(b-a)+a}

function genRoundData(mode,format,round){
  switch(mode){
    case"bullseye":{
      if(format==="teams"){return{targetTime:parseFloat(rngF(10,25).toFixed(2)),teamMode:true}}
      const lo=1.5,hi=5;return{targetTime:parseFloat(rngF(lo,hi).toFixed(2)),teamMode:false};
    }
    case"timesense":{
      const dur=parseFloat(rngF(3,10).toFixed(2));
      const waitDelay=parseFloat(rngF(2,5).toFixed(2));
      return{hiddenDuration:dur,waitDelay};
    }
    case"memory":{
      const hard=round%2===0||Math.random()>.4;
      const decimals=hard?4:3;
      const val=parseFloat(rngF(1,9).toFixed(decimals));
      return{shownTime:val,showDuration:rng(180,300),decimals};
    }
    case"reaction":{
      // Strong movement + shrinking buzzer
      const xOff=rng(-120,120),yOff=rng(-100,100);
      const size=Math.max(100,180-round*8);
      return{xOff,yOff,size};
    }
    default:return{};
  }
}

function makeRoom(code,sk,name,avatar,mode,format,rounds){
  return{code,phase:"lobby",mode:mode||"bullseye",format:format||"ffa",
    totalRounds:rounds||5,currentRound:0,preGameDone:false,
    players:[{id:sk.id,name,avatar,team:null,connected:true}],
    hostId:sk.id,roundData:null,results:null,subs:{},scores:{},finalScores:null,
    teamSubs:{},zeitTimers:[]}
}

function roomState(room){
  var subMap={};Object.keys(room.subs||{}).forEach(k=>{subMap[k]=true});
  var tSubMap={};Object.keys(room.teamSubs||{}).forEach(k=>{tSubMap[k]=true});
  return{code:room.code,phase:room.phase,mode:room.mode,format:room.format,
    totalRounds:room.totalRounds,currentRound:room.currentRound,
    roundData:room.roundData,preGameDone:room.preGameDone||false,
    players:room.players.map(p=>({id:p.id,name:p.name,avatar:p.avatar,team:p.team,connected:p.connected})),
    results:room.results,finalScores:room.finalScores,scores:room.scores,
    hostId:room.hostId,subs:subMap,teamSubs:tSubMap};
}
function bc(room){const s=roomState(room);room.players.forEach(p=>{io.to(p.id).emit("sync",{...s,myId:p.id})})}
function findRoom(sid){for(const[c,r]of rooms){const p=r.players.find(x=>x.id===sid);if(p)return{code:c,room:r,player:p}}return null}

function clearTimers(room){(room.zeitTimers||[]).forEach(t=>clearTimeout(t));room.zeitTimers=[]}

function scheduleZeitStop(room){
  if(room.mode!=="timesense"||!room.roundData.hiddenDuration)return;
  clearTimers(room);
  const dur=room.roundData.hiddenDuration,wait=room.roundData.waitDelay||3,rnd=room.currentRound;
  const t=setTimeout(()=>{
    if(room.phase==="playing"&&room.currentRound===rnd){
      io.to(room.code).emit("zeitStop",{actual:dur});
    }
  },(wait+dur)*1000);
  room.zeitTimers.push(t);
}

function fullReset(room){
  clearTimers(room);
  room.currentRound=0;room.subs={};room.teamSubs={};room.results=null;room.finalScores=null;room.roundData=null;room.preGameDone=false;
  room.scores={};room.players.forEach(p=>{room.scores[p.id]=0});
}

io.on("connection",sk=>{
  sk.on("create",({name,avatar,mode,format,rounds},cb)=>{
    if(!name)return cb({ok:false,err:"Name fehlt"});
    const code=mkCode();
    const room=makeRoom(code,sk,name,avatar,mode,format,rounds);
    room.scores[sk.id]=0;rooms.set(code,room);sk.join(code);
    cb({ok:true,code});bc(room);
  });

  sk.on("join",({code,name,avatar},cb)=>{
    const room=rooms.get(code&&code.toUpperCase());
    if(!room)return cb({ok:false,err:"Raum nicht gefunden"});
    if(room.phase!=="lobby")return cb({ok:false,err:"Spiel läuft bereits"});
    if(room.players.length>=8)return cb({ok:false,err:"Raum voll"});
    if(room.players.find(p=>p.name===name))return cb({ok:false,err:"Name vergeben"});
    room.players.push({id:sk.id,name,avatar,team:null,connected:true});
    room.scores[sk.id]=0;sk.join(code.toUpperCase());cb({ok:true,code:code.toUpperCase()});bc(room);
  });

  sk.on("setTeam",({team})=>{const f=findRoom(sk.id);if(!f)return;f.player.team=team;bc(f.room)});
  sk.on("updateSettings",({mode,format,rounds})=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    if(mode)room.mode=mode;if(format)room.format=format;if(rounds)room.totalRounds=rounds;bc(room);
  });

  sk.on("start",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    const connected=room.players.filter(p=>p.connected);if(connected.length<2)return;
    if(room.format==="teams"){connected.forEach((p,i)=>{if(!p.team)p.team=i%2===0?"a":"b"})}
    fullReset(room);room.phase="pregame";bc(room);
  });

  sk.on("startFirstRound",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    room.preGameDone=true;room.currentRound=1;
    room.roundData=genRoundData(room.mode,room.format,1);
    room.subs={};room.teamSubs={};room.phase="playing";bc(room);
    scheduleZeitStop(room);
  });

  sk.on("submit",({value,extra})=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;
    if(room.phase!=="playing")return;if(room.subs[sk.id])return;
    room.subs[sk.id]={pid:sk.id,name:f.player.name,avatar:f.player.avatar,value,extra:extra||{},ts:Date.now()};
    bc(room);
    const connected=room.players.filter(p=>p.connected);
    if(Object.keys(room.subs).length>=connected.length){
      const sorted=Object.values(room.subs).sort((a,b)=>a.value-b.value);
      sorted.forEach((r,i)=>{const pts=Math.max(sorted.length-i,1);room.scores[r.pid]=(room.scores[r.pid]||0)+pts});
      room.results=sorted;room.phase="results";bc(room);
    }
  });

  // Team Bullseye: each player submits their segment
  sk.on("teamSubmit",({value})=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;
    if(room.phase!=="playing")return;
    room.teamSubs[sk.id]={pid:sk.id,name:f.player.name,value,ts:Date.now()};
    bc(room);
  });

  // Team captain confirms final time
  sk.on("teamConfirm",({teamTotal})=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;
    if(room.phase!=="playing")return;
    const team=f.player.team;if(!team)return;
    const tgt=room.roundData.targetTime;
    const dev=Math.abs(teamTotal-tgt);const ms=Math.round(dev*1000);
    // Submit for all team members
    room.players.filter(p=>p.team===team&&p.connected).forEach(p=>{
      if(!room.subs[p.id])room.subs[p.id]={pid:p.id,name:p.name,avatar:p.avatar,value:ms,ts:Date.now()};
    });
    bc(room);
    const connected=room.players.filter(p=>p.connected);
    if(Object.keys(room.subs).length>=connected.length){
      // Team scoring: compare team averages
      const teamA=Object.values(room.subs).filter(s=>{const p=room.players.find(x=>x.id===s.pid);return p&&p.team==="a"});
      const teamB=Object.values(room.subs).filter(s=>{const p=room.players.find(x=>x.id===s.pid);return p&&p.team==="b"});
      const avgA=teamA.length?teamA.reduce((s,r)=>s+r.value,0)/teamA.length:99999;
      const avgB=teamB.length?teamB.reduce((s,r)=>s+r.value,0)/teamB.length:99999;
      const sorted=Object.values(room.subs).sort((a,b)=>a.value-b.value);
      // Winning team gets more points
      room.players.filter(p=>p.connected).forEach(p=>{
        const isTeamA=p.team==="a";
        const won=(isTeamA&&avgA<=avgB)||(!isTeamA&&avgB<avgA);
        room.scores[p.id]=(room.scores[p.id]||0)+(won?3:1);
      });
      room.results=sorted;room.phase="results";bc(room);
    }
  });

  sk.on("nextRound",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    clearTimers(room);
    if(room.currentRound>=room.totalRounds){room.finalScores={...room.scores};room.phase="gameover";bc(room)}
    else{room.currentRound++;room.roundData=genRoundData(room.mode,room.format,room.currentRound);room.subs={};room.teamSubs={};room.results=null;room.phase="playing";bc(room);scheduleZeitStop(room)}
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
