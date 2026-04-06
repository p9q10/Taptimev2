const express=require("express"),http=require("http"),{Server}=require("socket.io"),path=require("path");
const app=express(),srv=http.createServer(app),io=new Server(srv,{cors:{origin:"*"},pingTimeout:30000,pingInterval:10000});
const PORT=process.env.PORT||3000;
app.use(express.static(path.join(__dirname,"public")));

// ═══ STATE ═══
const rooms=new Map();
const CH="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function mkCode(){let c;do{c="";for(let i=0;i<6;i++)c+=CH[Math.floor(Math.random()*CH.length)]}while(rooms.has(c));return c}
function genTarget(round,isZeit){
  if(isZeit){const lo=round<=2?3:round<=5?4:5,hi=round<=2?6:round<=5?8:12;return Math.round((lo+Math.random()*(hi-lo))*10)/10}
  const lo=round<=2?1.5:round<=5?2:3,hi=round<=2?3.5:round<=5?6:9;return Math.round((lo+Math.random()*(hi-lo))*10)/10
}

// Full state that every client receives
function fullState(room){
  return {
    code:room.code, mode:room.mode, status:room.status,
    round:room.round, totalRounds:room.totalRounds,
    target:room.mode==="zeit"?null:room.target,
    players:room.players.map(p=>({
      id:p.id, name:p.name, avatar:p.avatar,
      host:p.host, elim:p.elim, submitted:!!room.subs[p.id],
      connected:p.connected
    })),
    submittedCount:Object.keys(room.subs).length,
    activeCount:room.players.filter(p=>!p.elim).length,
    roundResults:room.lastResults||null
  }
}

function broadcast(code){
  const room=rooms.get(code);
  if(!room)return;
  const state=fullState(room);
  // Send to each player individually with their private data
  room.players.forEach(p=>{
    const private_data={...state};
    if(room.mode==="trust"&&room.roles[p.id]){
      private_data.myRole=room.roles[p.id];
    }
    io.to(p.id).emit("sync",private_data);
  });
}

function findRoomBySocket(sid){
  for(const[code,room] of rooms){
    const p=room.players.find(x=>x.id===sid);
    if(p)return{code,room,player:p};
  }
  return null;
}

// ═══ CONNECTION ═══
io.on("connection",sk=>{
  console.log("connect:",sk.id);

  // CREATE ROOM
  sk.on("create",({name,avatar,mode,rounds},cb)=>{
    if(!name||!avatar)return cb({ok:false,err:"Missing data"});
    const code=mkCode();
    const room={
      code, mode:mode||"normal", status:"lobby",
      players:[{id:sk.id,name,avatar,host:true,elim:false,connected:true}],
      round:0, totalRounds:rounds||3, target:0,
      subs:{}, finalTimes:{},
      roles:{}, sabUsedGame:false, fakeResolved:false, sabResolved:false,
      votes:{}, roundHistory:[], lastResults:null,
      zeitTimers:[]
    };
    rooms.set(code,room);
    sk.join(code);
    cb({ok:true,code});
    broadcast(code);
  });

  // JOIN ROOM
  sk.on("join",({code,name,avatar},cb)=>{
    if(!code||!name)return cb({ok:false,err:"Missing data"});
    const room=rooms.get(code.toUpperCase());
    if(!room)return cb({ok:false,err:"Room not found"});
    if(room.status!=="lobby")return cb({ok:false,err:"Game already started"});
    if(room.players.length>=10)return cb({ok:false,err:"Room full"});
    if(room.players.find(p=>p.name===name))return cb({ok:false,err:"Name taken"});
    room.players.push({id:sk.id,name,avatar,host:false,elim:false,connected:true});
    sk.join(room.code);
    cb({ok:true,code:room.code});
    broadcast(room.code);
  });

  // REJOIN (reconnect)
  sk.on("rejoin",({code,name},cb)=>{
    const room=rooms.get(code);
    if(!room)return cb({ok:false,err:"Room gone"});
    const player=room.players.find(p=>p.name===name);
    if(!player)return cb({ok:false,err:"Player not found"});
    // Update socket ID
    const oldId=player.id;
    player.id=sk.id;
    player.connected=true;
    sk.join(code);
    // Update subs/finalTimes/votes keys
    if(room.subs[oldId]!==undefined){room.subs[sk.id]=room.subs[oldId];delete room.subs[oldId]}
    if(room.finalTimes[oldId]!==undefined){room.finalTimes[sk.id]=room.finalTimes[oldId];delete room.finalTimes[oldId]}
    if(room.roles[oldId]){room.roles[sk.id]=room.roles[oldId];delete room.roles[oldId]}
    if(room.votes[oldId]){room.votes[sk.id]=room.votes[oldId];delete room.votes[oldId]}
    cb({ok:true,code});
    broadcast(code);
  });

  // HOST STARTS GAME
  sk.on("start",()=>{
    const found=findRoomBySocket(sk.id);
    if(!found)return;
    const{code,room,player}=found;
    if(!player.host)return;
    if(room.players.filter(p=>p.connected).length<2)return;

    room.status="playing";
    room.round=1;
    room.subs={};
    room.finalTimes={};
    room.target=genTarget(1,room.mode==="zeit");
    room.roundHistory=[];
    room.lastResults=null;
    room.players.forEach(p=>p.elim=false);

    // Trust Breaker roles
    if(room.mode==="trust"){
      room.roles={};room.sabUsedGame=false;
      const ids=room.players.map(p=>p.id).sort(()=>Math.random()-.5);
      room.players.forEach(p=>room.roles[p.id]="normal");
      if(ids.length>=2){room.roles[ids[0]]="fake";room.roles[ids[1]]="saboteur"}
    }

    broadcast(code);

    // Zeitgefühl: schedule stop
    if(room.mode==="zeit"){
      scheduleZeitStop(room);
    }
  });

  // SUBMIT TIME
  sk.on("submit",({time})=>{
    const found=findRoomBySocket(sk.id);
    if(!found)return;
    const{code,room,player}=found;
    if(room.status!=="playing"||player.elim)return;
    if(room.subs[sk.id]!==undefined)return;

    room.subs[sk.id]=time;
    room.finalTimes[sk.id]=time;
    broadcast(code);

    // Check if all submitted
    const active=room.players.filter(p=>!p.elim&&p.connected);
    if(Object.keys(room.subs).length>=active.length){
      if(room.mode==="trust"){
        startHiddenPhase(code);
      } else {
        resolveRound(code);
      }
    }
  });

  // TRUST BREAKER: Fake actions
  sk.on("fakeAct",({dir})=>{
    const found=findRoomBySocket(sk.id);if(!found)return;
    const{code,room}=found;
    if(room.roles[sk.id]!=="fake"||room.fakeResolved)return;
    const orig=room.subs[sk.id];if(orig===undefined)return;
    room.finalTimes[sk.id]=orig+(dir==="plus"?0.4:-0.4);
    room.fakeResolved=true;
    checkHidden(code);
  });
  sk.on("fakeSkip",()=>{
    const found=findRoomBySocket(sk.id);if(!found)return;
    found.room.fakeResolved=true;
    checkHidden(found.code);
  });

  // TRUST BREAKER: Saboteur actions
  sk.on("sabAct",({targetId})=>{
    const found=findRoomBySocket(sk.id);if(!found)return;
    const{code,room}=found;
    if(room.roles[sk.id]!=="saboteur"||room.sabUsedGame)return;
    const tv=room.finalTimes[targetId];if(tv===undefined)return;
    room.finalTimes[targetId]=tv+((tv-room.target)>=0?0.3:-0.3);
    room.sabUsedGame=true;room.sabResolved=true;
    checkHidden(code);
  });
  sk.on("sabSkip",()=>{
    const found=findRoomBySocket(sk.id);if(!found)return;
    found.room.sabResolved=true;
    checkHidden(found.code);
  });

  // TRUST BREAKER: Vote
  sk.on("vote",({fakeGuess,sabGuess})=>{
    const found=findRoomBySocket(sk.id);if(!found)return;
    const{code,room}=found;
    if(room.status!=="voting")return;
    room.votes[sk.id]={fake:fakeGuess,sab:sabGuess};
    const connected=room.players.filter(p=>p.connected);
    if(Object.keys(room.votes).length>=connected.length){
      const fakeId=Object.entries(room.roles).find(([,r])=>r==="fake")?.[0];
      const sabId=Object.entries(room.roles).find(([,r])=>r==="saboteur")?.[0];
      const fV=Object.values(room.votes).filter(v=>v.fake===fakeId).length;
      const sV=Object.values(room.votes).filter(v=>v.sab===sabId).length;
      const maj=Math.ceil(connected.length/2);
      room.status="reveal";
      io.to(code).emit("tbReveal",{
        roles:room.roles,fakeId,sabId,
        fakeFound:fV>=maj,sabFound:sV>=maj,
        normalWin:fV>=maj&&sV>=maj,fV,sV,maj
      });
    }
  });

  // HOST: Next round
  sk.on("nextRound",()=>{
    const found=findRoomBySocket(sk.id);if(!found)return;
    const{code,room,player}=found;
    if(!player.host)return;

    const active=room.players.filter(p=>!p.elim&&p.connected);

    // Trust: go to voting after last round
    if(room.mode==="trust"&&room.round>=room.totalRounds){
      room.status="voting";room.votes={};
      broadcast(code);
      return;
    }

    // Game over check
    if(active.length<=1||(room.mode!=="trust"&&room.round>=room.totalRounds)){
      room.status="ended";
      room.lastResults=null;
      broadcast(code);
      return;
    }

    // Next round
    room.round++;
    room.subs={};room.finalTimes={};
    room.target=genTarget(room.round,room.mode==="zeit");
    room.status="playing";
    room.lastResults=null;
    room.fakeResolved=false;
    room.sabResolved=room.sabUsedGame;
    broadcast(code);

    if(room.mode==="zeit"){
      scheduleZeitStop(room);
    }
  });

  // DISCONNECT
  sk.on("disconnect",()=>{
    console.log("disconnect:",sk.id);
    for(const[code,room] of rooms){
      const player=room.players.find(p=>p.id===sk.id);
      if(!player)continue;

      player.connected=false;

      // If lobby, remove completely
      if(room.status==="lobby"){
        room.players=room.players.filter(p=>p.id!==sk.id);
      }

      // If no connected players, delete room after 60s
      const connected=room.players.filter(p=>p.connected);
      if(connected.length===0){
        setTimeout(()=>{
          const r=rooms.get(code);
          if(r&&r.players.every(p=>!p.connected))rooms.delete(code);
        },60000);
      } else {
        // Transfer host if needed
        if(player.host){
          player.host=false;
          const newHost=connected[0];
          if(newHost)newHost.host=true;
        }
      }
      broadcast(code);
      break;
    }
  });
});

// ═══ GAME LOGIC ═══

function scheduleZeitStop(room){
  // Clear any existing timers
  room.zeitTimers.forEach(t=>clearTimeout(t));
  room.zeitTimers=[];
  const rnd=room.round;
  // 3s countdown + target duration
  const timer=setTimeout(()=>{
    if(room.status==="playing"&&room.round===rnd){
      io.to(room.code).emit("zeitStop");
    }
  },room.target*1000+3000);
  room.zeitTimers.push(timer);
}

function startHiddenPhase(code){
  const room=rooms.get(code);if(!room)return;
  room.status="hidden";
  room.fakeResolved=false;
  room.sabResolved=room.sabUsedGame;

  const fakeEntry=Object.entries(room.roles).find(([,r])=>r==="fake");
  const sabEntry=Object.entries(room.roles).find(([,r])=>r==="saboteur");

  if(fakeEntry){
    io.to(fakeEntry[0]).emit("fakePrompt",{time:room.subs[fakeEntry[0]]});
  } else {
    room.fakeResolved=true;
  }

  if(sabEntry&&!room.sabUsedGame){
    io.to(sabEntry[0]).emit("sabPrompt",{
      targets:room.players.filter(p=>p.id!==sabEntry[0]&&!p.elim&&p.connected)
        .map(p=>({id:p.id,name:p.name}))
    });
  } else {
    room.sabResolved=true;
  }

  broadcast(code);

  // Timeout fallback
  setTimeout(()=>{
    if(room.status==="hidden")resolveRound(code);
  },15000);

  checkHidden(code);
}

function checkHidden(code){
  const room=rooms.get(code);
  if(!room||room.status!=="hidden")return;
  if(room.fakeResolved&&room.sabResolved)resolveRound(code);
}

function resolveRound(code){
  const room=rooms.get(code);if(!room)return;
  const active=room.players.filter(p=>!p.elim&&p.connected);
  const ft=room.finalTimes;

  const results=active.map(p=>{
    const time=ft[p.id]||room.subs[p.id]||0;
    return {
      id:p.id, name:p.name, avatar:p.avatar,
      time:Math.round(time*1000)/1000,
      ms:Math.round(Math.abs(time-room.target)*1000),
      elim:false
    };
  }).sort((a,b)=>a.ms-b.ms);

  results.forEach((r,i)=>r.rank=i+1);

  // Eliminate worst (not in trust mode, not if only 2 left)
  if(room.mode!=="trust"&&active.length>2){
    const worst=results[results.length-1];
    worst.elim=true;
    const wp=room.players.find(p=>p.id===worst.id);
    if(wp)wp.elim=true;
  }

  room.roundHistory.push({round:room.round,target:room.target,results});
  room.status="results";
  room.lastResults={round:room.round,target:room.target,results};
  broadcast(code);
}

// ═══ ROUTES ═══
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.get("/health",(req,res)=>res.json({ok:true,rooms:rooms.size,connections:io.engine.clientsCount}));

srv.listen(PORT,()=>console.log("TimeTap v6 on port "+PORT));
