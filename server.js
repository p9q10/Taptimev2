const express=require("express"),http=require("http"),{Server}=require("socket.io"),path=require("path");
const app=express(),srv=http.createServer(app),io=new Server(srv,{cors:{origin:"*"},pingTimeout:30000,pingInterval:10000});
const PORT=process.env.PORT||3000;
app.use(express.static(path.join(__dirname,"public")));

const rooms=new Map();
const CH="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function mkCode(){let c;do{c="";for(let i=0;i<4;i++)c+=CH[Math.floor(Math.random()*CH.length)]}while(rooms.has(c));return c}
function rng(a,b){return Math.floor(Math.random()*(b-a+1))+a}
function rngF(a,b){return Math.random()*(b-a)+a}

function genRoundData(mode){
  switch(mode){
    case"bullseye":return{targetTime:parseFloat(rngF(1.5,8).toFixed(2))};
    case"timesense":return{hiddenDuration:parseFloat(rngF(3,8).toFixed(2))};
    case"memory":return{shownTime:parseFloat(rngF(1,6).toFixed(3)),showDuration:rng(200,400)};
    case"reaction":return{};
    default:return{};
  }
}

function roomState(room){
  var subMap={};Object.keys(room.subs||{}).forEach(function(k){subMap[k]=true});
  return{code:room.code,phase:room.phase,mode:room.mode,format:room.format,
    totalRounds:room.totalRounds,currentRound:room.currentRound,
    roundData:room.roundData,
    players:room.players.map(p=>({id:p.id,name:p.name,avatar:p.avatar,team:p.team,connected:p.connected})),
    results:room.results,finalScores:room.finalScores,scores:room.scores,
    hostId:room.hostId,subs:subMap};
}

function bc(room){const s=roomState(room);room.players.forEach(p=>{io.to(p.id).emit("sync",{...s,myId:p.id})})}

function findRoom(sid){for(const[code,room]of rooms){const p=room.players.find(x=>x.id===sid);if(p)return{code,room,player:p}}return null}

// Schedule zeitStop for timesense mode
function scheduleZeitStop(room){
  if(room.mode!=="timesense"||!room.roundData.hiddenDuration)return;
  const dur=room.roundData.hiddenDuration;
  const rnd=room.currentRound;
  // Client: 2s wait + 3s countdown = 5s before counting starts
  const totalDelay=(5+dur)*1000;
  setTimeout(()=>{
    if(room.phase==="playing"&&room.currentRound===rnd){
      io.to(room.code).emit("zeitStop",{actual:dur});
    }
  },totalDelay);
}

io.on("connection",sk=>{
  sk.on("create",({name,avatar,mode,format,rounds},cb)=>{
    if(!name)return cb({ok:false,err:"Name fehlt"});
    const code=mkCode();
    const room={code,phase:"lobby",mode:mode||"bullseye",format:format||"ffa",
      totalRounds:rounds||5,currentRound:0,
      players:[{id:sk.id,name,avatar,team:null,connected:true}],
      hostId:sk.id,roundData:null,results:null,subs:{},scores:{},finalScores:null};
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
    if(room.format==="teams"){const shuffled=[...connected].sort(()=>Math.random()-.5);shuffled.forEach((p,i)=>{if(!p.team)p.team=i%2===0?"a":"b"})}
    room.currentRound=1;room.roundData=genRoundData(room.mode);
    room.subs={};room.results=null;room.finalScores=null;
    room.scores={};connected.forEach(p=>{room.scores[p.id]=0});
    room.phase="playing";bc(room);scheduleZeitStop(room);
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

  sk.on("nextRound",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    if(room.currentRound>=room.totalRounds){room.finalScores={...room.scores};room.phase="gameover";bc(room)}
    else{room.currentRound++;room.roundData=genRoundData(room.mode);room.subs={};room.results=null;room.phase="playing";bc(room);scheduleZeitStop(room)}
  });

  sk.on("playAgain",()=>{const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    room.phase="lobby";room.currentRound=0;room.results=null;room.finalScores=null;room.subs={};
    room.scores={};room.players.forEach(p=>{room.scores[p.id]=0});bc(room)});

  sk.on("disconnect",()=>{const f=findRoom(sk.id);if(!f)return;const{code,room,player}=f;
    player.connected=false;if(room.phase==="lobby")room.players=room.players.filter(p=>p.id!==sk.id);
    const connected=room.players.filter(p=>p.connected);
    if(connected.length===0){setTimeout(()=>{const r=rooms.get(code);if(r&&r.players.every(p=>!p.connected))rooms.delete(code)},60000)}
    else{if(room.hostId===sk.id)room.hostId=connected[0].id}bc(room)});
});

app.get("/",(q,s)=>s.sendFile(path.join(__dirname,"public","index.html")));
app.get("/health",(q,s)=>s.json({ok:true,rooms:rooms.size}));
srv.listen(PORT,()=>console.log("TimeTap on :"+PORT));
