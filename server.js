const express=require("express"),http=require("http"),{Server}=require("socket.io"),path=require("path");
const app=express(),srv=http.createServer(app),io=new Server(srv,{cors:{origin:"*"},pingTimeout:30000,pingInterval:10000});
const PORT=process.env.PORT||3000;
app.use(express.static(path.join(__dirname,"public")));
const rooms=new Map();
const CH="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function mkCode(){let c;do{c="";for(let i=0;i<4;i++)c+=CH[Math.floor(Math.random()*CH.length)]}while(rooms.has(c));return c}
function rng(a,b){return Math.floor(Math.random()*(b-a+1))+a}
const GAME_MODES=["bullseye","reaction","tapfrenzy"];

/* ═══════════════════════════════════════════
   ELO SYSTEM (Feature 1)
   ═══════════════════════════════════════════ */
const playerElo=new Map(); // pid (persistent) -> {bullseye, timesense, memory, reaction, countdown, tapfrenzy, _matches}
const ELO_START=1000;
const ELO_K=32;
const ELO_K_NEW=64;       // first 5 matches per mode = double K
const ELO_NEW_THRESHOLD=5;
function ensurePlayerElo(pid){
  if(!playerElo.has(pid)){
    const e={_matches:{}};
    GAME_MODES.forEach(m=>{e[m]=ELO_START;e._matches[m]=0});
    playerElo.set(pid,e);
  }
  return playerElo.get(pid);
}
function getElo(pid,mode){return ensurePlayerElo(pid)[mode]||ELO_START}
function getMatchCount(pid,mode){return ensurePlayerElo(pid)._matches[mode]||0}
function eloTier(elo){
  if(elo<800)return{name:"Bronze",icon:"🥉",color:"#A06030",min:0};
  if(elo<1000)return{name:"Silber",icon:"🥈",color:"#8A8A8A",min:800};
  if(elo<1200)return{name:"Gold",icon:"🥇",color:"#D4A040",min:1000};
  if(elo<1400)return{name:"Platin",icon:"💎",color:"#5BA3C0",min:1200};
  if(elo<1600)return{name:"Diamant",icon:"💠",color:"#7B68EE",min:1400};
  if(elo<1800)return{name:"Master",icon:"👑",color:"#C040A0",min:1600};
  return{name:"Grandmaster",icon:"⚡",color:"#FFB800",min:1800};
}
function expectedScore(eloA,eloB){return 1/(1+Math.pow(10,(eloB-eloA)/400))}
/*
  Pairwise ELO update for FFA:
  Each player plays every other player. If their rank is lower (better), they "win" that pairwise match.
  Final delta = average of all pairwise deltas.
*/
function calcEloUpdates(rankings,mode){
  // rankings = [{pid, rank}, ...] (rank 1 = best)
  if(rankings.length<2)return{};
  const updates={};
  rankings.forEach(p=>{
    const myElo=getElo(p.pid,mode);
    const myMatches=getMatchCount(p.pid,mode);
    const k=myMatches<ELO_NEW_THRESHOLD?ELO_K_NEW:ELO_K;
    let totalDelta=0;
    let pairs=0;
    rankings.forEach(o=>{
      if(o.pid===p.pid)return;
      const oppElo=getElo(o.pid,mode);
      const expected=expectedScore(myElo,oppElo);
      const actual=p.rank<o.rank?1:p.rank>o.rank?0:0.5;
      totalDelta+=k*(actual-expected);
      pairs++;
    });
    const delta=pairs>0?Math.round(totalDelta/pairs):0;
    updates[p.pid]={oldElo:myElo,delta,newElo:Math.max(0,myElo+delta)};
  });
  return updates;
}
function applyEloUpdates(updates,mode){
  Object.keys(updates).forEach(pid=>{
    const e=ensurePlayerElo(pid);
    e[mode]=updates[pid].newElo;
    e._matches[mode]=(e._matches[mode]||0)+1;
  });
}
/* Return ELO data for a player (used in sync) */
function getPlayerEloData(pid){
  const e=ensurePlayerElo(pid);
  const data={};
  GAME_MODES.forEach(m=>{
    data[m]={elo:e[m],matches:e._matches[m]||0,tier:eloTier(e[m])};
  });
  // overall = average of modes that have been played at least once, else default
  let sum=0,cnt=0;
  GAME_MODES.forEach(m=>{if(e._matches[m]>0){sum+=e[m];cnt++}});
  data.overall={elo:cnt>0?Math.round(sum/cnt):ELO_START,matches:cnt,tier:eloTier(cnt>0?Math.round(sum/cnt):ELO_START)};
  return data;
}
/* Allow client to restore ELO from localStorage backup if server lost state */
function restorePlayerEloFromBackup(pid,backup){
  if(!backup||typeof backup!=="object")return;
  const e=ensurePlayerElo(pid);
  // only restore if our current values are defaults (server lost state)
  let isDefault=true;
  GAME_MODES.forEach(m=>{if(e._matches[m]>0)isDefault=false});
  if(!isDefault)return; // server has fresher data, ignore backup
  GAME_MODES.forEach(m=>{
    if(backup[m]&&typeof backup[m].elo==="number"&&typeof backup[m].matches==="number"){
      e[m]=Math.max(0,Math.min(3000,backup[m].elo)); // sanity-clamp
      e._matches[m]=Math.max(0,Math.min(10000,backup[m].matches));
    }
  });
}
/* ═══════════════════════════════════════════ */

/* ═══════════════════════════════════════════
   PREDICTOR LAYER (Feature 3)
   ═══════════════════════════════════════════ */
const PREDICTION_TIMEOUT_MS=8000;
const PREDICTION_OPTIONS={
  bullseye:[
    {id:"perfect",label:"<0.1s",mult:2.0,stars:3},
    {id:"good",label:"<0.3s",mult:1.5,stars:2},
    {id:"ok",label:"<1s",mult:1.5,stars:1},
    {id:"miss",label:">1s",mult:1.5,stars:1}
  ],
  reaction:[
    {id:"elite",label:"≤200ms",mult:2.0,stars:3},
    {id:"good",label:"≤280ms",mult:1.5,stars:2},
    {id:"ok",label:"≤350ms",mult:1.5,stars:1},
    {id:"slow",label:">350ms",mult:1.5,stars:1}
  ],
  memory:[
    {id:"exact",label:"Exakt",mult:2.0,stars:3},
    {id:"close",label:"<0.1s",mult:1.5,stars:2},
    {id:"ok",label:"<0.5s",mult:1.5,stars:1},
    {id:"miss",label:"Daneben",mult:1.5,stars:1}
  ],
  countdown:[
    {id:"first",label:"Platz 1",mult:2.0,stars:3},
    {id:"top3",label:"Top 3",mult:1.5,stars:2},
    {id:"mid",label:"Mittelfeld",mult:1.5,stars:1},
    {id:"last",label:"Letzter",mult:1.5,stars:1}
  ],
  timesense:[
    {id:"perfect",label:"<0.3s",mult:2.0,stars:3},
    {id:"good",label:"<1s",mult:1.5,stars:2},
    {id:"ok",label:"<2s",mult:1.5,stars:1},
    {id:"miss",label:">2s",mult:1.5,stars:1}
  ],
  tapfrenzy:[
    {id:"high",label:"≥45 Taps",mult:2.0,stars:3},
    {id:"good",label:"≥35 Taps",mult:1.5,stars:2},
    {id:"ok",label:"≥25 Taps",mult:1.5,stars:1},
    {id:"low",label:"<25 Taps",mult:1.5,stars:1}
  ]
};
function getPredictionOptions(mode){return PREDICTION_OPTIONS[mode]||null}

/* Evaluate if a prediction was correct based on actual result */
function evaluatePrediction(mode,optionId,result,rank,totalPlayers){
  if(!optionId||!result)return false;
  const opts=PREDICTION_OPTIONS[mode];if(!opts)return false;
  const opt=opts.find(o=>o.id===optionId);if(!opt)return false;
  const v=result.value;
  if(mode==="bullseye"){
    /* value = deviation in seconds (smaller=better) */
    if(optionId==="perfect")return v<0.1;
    if(optionId==="good")return v>=0.1&&v<0.3;
    if(optionId==="ok")return v>=0.3&&v<1;
    if(optionId==="miss")return v>=1;
  }
  if(mode==="reaction"){
    const ms=typeof result.reactionMs==="number"?result.reactionMs:v*1000;
    if(ms>=9000)return optionId==="slow"; /* false start counts as slow tier */
    if(optionId==="elite")return ms<=200;
    if(optionId==="good")return ms>200&&ms<=280;
    if(optionId==="ok")return ms>280&&ms<=350;
    if(optionId==="slow")return ms>350;
  }
  if(mode==="memory"){
    if(optionId==="exact")return v<0.01;
    if(optionId==="close")return v>=0.01&&v<0.1;
    if(optionId==="ok")return v>=0.1&&v<0.5;
    if(optionId==="miss")return v>=0.5;
  }
  if(mode==="countdown"){
    if(optionId==="first")return rank===1;
    if(optionId==="top3")return rank>1&&rank<=3;
    if(optionId==="mid")return rank>3&&rank<totalPlayers;
    if(optionId==="last")return rank===totalPlayers;
  }
  if(mode==="timesense"){
    if(optionId==="perfect")return v<0.3;
    if(optionId==="good")return v>=0.3&&v<1;
    if(optionId==="ok")return v>=1&&v<2;
    if(optionId==="miss")return v>=2;
  }
  if(mode==="tapfrenzy"){
    /* tapfrenzy: value is sec/tap, lower = more taps. Convert to taps via duration. */
    /* Need duration from roundData; assume passed via result or fallback */
    const tapsPerSec=v>0?1/v:0; /* approximation */
    const taps=Math.round(tapsPerSec*5); /* assume 5s default; refined below if we have duration */
    if(optionId==="high")return taps>=45;
    if(optionId==="good")return taps>=35&&taps<45;
    if(optionId==="ok")return taps>=25&&taps<35;
    if(optionId==="low")return taps<25;
  }
  return false;
}
/* ═══════════════════════════════════════════ */
const playerReactionStats=new Map(); // pid -> { best (ms), recent (last 10 ms), count, lastUpdated }
const globalReactionLeaderboard=[];   // sorted array: { pid, name, avatar, time(ms), achievedAt }
const REACTION_LB_SIZE=10;
const REACTION_LB_MIN_MATCHES=5;       // need this many reactions to be eligible for global LB

function getReactionStats(pid){
  if(!playerReactionStats.has(pid)){
    playerReactionStats.set(pid,{best:null,recent:[],count:0,lastUpdated:0});
  }
  return playerReactionStats.get(pid);
}
function reactionTier(ms){
  if(ms===null||ms===undefined||isNaN(ms))return{name:"—",icon:"·",color:"#8A8A8A",rank:-1};
  if(ms>=9000)return{name:"FEHLSTART",icon:"✗",color:"#F43F5E",rank:99};
  if(ms<150)return{name:"GOTTLIKE",icon:"⚡",color:"#FFB800",rank:0};
  if(ms<180)return{name:"ELITE",icon:"🔥",color:"#C040A0",rank:1};
  if(ms<220)return{name:"EXCELLENT",icon:"💎",color:"#7B68EE",rank:2};
  if(ms<280)return{name:"GOOD",icon:"💠",color:"#5BA3C0",rank:3};
  if(ms<350)return{name:"AVERAGE",icon:"●",color:"#34D399",rank:4};
  if(ms<500)return{name:"SLOW",icon:"○",color:"#A8A098",rank:5};
  return{name:"TOO SLOW",icon:"·",color:"#8A8A8A",rank:6};
}
function recordReaction(pid,name,avatar,timeMs){
  if(typeof timeMs!=="number"||isNaN(timeMs)||timeMs<50||timeMs>=9000)return{isPB:false,prevBest:null};
  const stats=getReactionStats(pid);
  const prevBest=stats.best;
  const isPB=prevBest===null||timeMs<prevBest;
  if(isPB)stats.best=timeMs;
  stats.recent.push(timeMs);
  if(stats.recent.length>10)stats.recent.shift();
  stats.count++;
  stats.lastUpdated=Date.now();
  /* update global leaderboard */
  if(stats.count>=REACTION_LB_MIN_MATCHES){
    const existingIdx=globalReactionLeaderboard.findIndex(e=>e.pid===pid);
    if(existingIdx>=0){
      if(timeMs<globalReactionLeaderboard[existingIdx].time){
        globalReactionLeaderboard[existingIdx]={pid,name,avatar,time:timeMs,achievedAt:Date.now()};
      }
    }else{
      globalReactionLeaderboard.push({pid,name,avatar,time:timeMs,achievedAt:Date.now()});
    }
    globalReactionLeaderboard.sort((a,b)=>a.time-b.time);
    if(globalReactionLeaderboard.length>REACTION_LB_SIZE)globalReactionLeaderboard.length=REACTION_LB_SIZE;
  }
  return{isPB,prevBest};
}
function getReactionStatsClient(pid){
  const s=getReactionStats(pid);
  const avg=s.recent.length>0?s.recent.reduce((a,b)=>a+b,0)/s.recent.length:null;
  return{
    best:s.best,
    avgLast10:avg,
    count:s.count,
    bestTier:s.best?reactionTier(s.best):null
  };
}
function getGlobalReactionLB(myPid){
  const lb=globalReactionLeaderboard.map((e,i)=>({
    rank:i+1,name:e.name,avatar:e.avatar,time:e.time,
    tier:reactionTier(e.time),isMine:e.pid===myPid
  }));
  return lb;
}
/* ═══════════════════════════════════════════ */

/* ═══════════════════════════════════════════
   HIDDEN TRICKS (Feature 7)
   ═══════════════════════════════════════════ */
const HIDDEN_TRICKS={
  bullseye_cancel:{id:"bullseye_cancel",name:"Pre-Tap Cancel",icon:"🎯",mode:"bullseye",description:"START drücken, innerhalb 100ms loslassen — Tap wird gecancelt"},
  reaction_antitilt:{id:"reaction_antitilt",name:"Anti-Tilt",icon:"⚡",mode:"reaction",description:"Nach 3 schwachen Reaktionen wird die nächste leichter"},
  memory_doubletap:{id:"memory_doubletap",name:"Doubletap-Zoom",icon:"💾",mode:"memory",description:"Doppeltap zeigt Zahl 200ms länger (-5 Coins)"},
  countdown_lockin:{id:"countdown_lockin",name:"Lock-In Window",icon:"⏱",mode:"countdown",description:"Stoppe innerhalb 0.05s der Zielzeit für +5 Bonus"}
};
const playerDiscoveredTricks=new Map();   // pid -> Set of trick IDs
const playerTrickStats=new Map();          // pid -> {trickId: count}
const playerReactionRecent=new Map();      // pid -> array of last 3 reaction ms (for anti-tilt)

function ensureTrickState(pid){
  if(!playerDiscoveredTricks.has(pid))playerDiscoveredTricks.set(pid,new Set());
  if(!playerTrickStats.has(pid))playerTrickStats.set(pid,{});
}
function activateTrick(pid,trickId,result){
  if(!pid||!HIDDEN_TRICKS[trickId])return false;
  ensureTrickState(pid);
  const set=playerDiscoveredTricks.get(pid);
  const isFirst=!set.has(trickId);
  set.add(trickId);
  const stats=playerTrickStats.get(pid);
  stats[trickId]=(stats[trickId]||0)+1;
  if(result){
    result.trickActivated=trickId;
    result.trickFirstDiscovery=isFirst;
  }
  return isFirst;
}
function getTrickStatsClient(pid){
  ensureTrickState(pid);
  const set=playerDiscoveredTricks.get(pid);
  const stats=playerTrickStats.get(pid);
  const tricks=Object.keys(HIDDEN_TRICKS).map(tid=>{
    const t=HIDDEN_TRICKS[tid];
    const discovered=set.has(tid);
    return{
      id:tid,
      name:discovered?t.name:"???",
      icon:discovered?t.icon:"?",
      mode:discovered?t.mode:"???",
      description:discovered?t.description:"Noch nicht entdeckt",
      discovered,
      count:stats[tid]||0
    };
  });
  return{tricks,discoveredCount:set.size,totalCount:Object.keys(HIDDEN_TRICKS).length};
}
/* Check anti-tilt eligibility for reaction */
function shouldGiveAntiTilt(pid){
  if(!pid)return false;
  const recent=playerReactionRecent.get(pid)||[];
  if(recent.length<3)return false;
  return recent.slice(-3).every(ms=>ms>350);
}
function recordReactionForAntiTilt(pid,ms){
  if(!pid||typeof ms!=="number")return;
  if(!playerReactionRecent.has(pid))playerReactionRecent.set(pid,[]);
  const arr=playerReactionRecent.get(pid);
  arr.push(ms);
  if(arr.length>5)arr.shift();
}
/* ═══════════════════════════════════════════ */

function pickMode(room){
  var pool=room.selectedModes&&room.selectedModes.length>0?room.selectedModes:GAME_MODES;
  var h=room.modeHistory||[];
  var attempts=0,mode;
  do{mode=pool[Math.floor(Math.random()*pool.length)];attempts++}
  while(attempts<3&&pool.length>1&&h.length>=2&&h[h.length-1]===mode&&h[h.length-2]===mode);
  h.push(mode);if(h.length>5)h.shift();
  room.modeHistory=h;
  return mode;
}

// Unified: 0.5-5s, max 1 decimal
function genTarget(){return parseFloat((0.5+Math.random()*4.5).toFixed(1))}

function genRoundData(mode,format,hardcoreMode){
  let data;
  switch(mode){
    case"bullseye":data={targetTime:genTarget()};break;
    case"timesense":{
      const dur=genTarget();
      const waitDelay=parseFloat((2+Math.random()*3).toFixed(1));
      data={hiddenDuration:dur,waitDelay};break;
    }
    case"memory":{
      const dec=Math.random()>.5?4:3;
      data={shownTime:parseFloat((0.5+Math.random()*4.5).toFixed(dec)),showDuration:105,decimals:dec};break;
    }
    case"reaction":data={greenIdx:rng(0,9)};break;
    case"countdown":data={targetTime:parseFloat((2+Math.random()*6).toFixed(1)),duration:7000,power:2.5};break;
    case"tapfrenzy":data={duration:parseFloat(([3,4,5,5,6,7][rng(0,5)]).toFixed(0))};break;
    default:data={};
  }
  /* Feature 8: Hardcore mode adjustments */
  if(hardcoreMode){
    data.hardcore=true;
    if(mode==="reaction"){
      data.hardcoreTarget=200; /* hit exactly 200ms */
    }else if(mode==="bullseye"){
      data.hardcoreSweetSpotMult=5; /* try to hold 5x targetTime */
    }else if(mode==="tapfrenzy"){
      /* exact tap target — scale with duration */
      const exactTaps=rng(15,40);
      data.tapTarget=exactTaps;
    }
  }
  return data;
}

// Coin system: position-based
var RANK_COINS=[100,70,45,25,15,5];
function posCoins(rank){return RANK_COINS[Math.min(rank,RANK_COINS.length-1)]}

/* ═══════════════════════════════════════════
   TOP PLAYS (Feature 6)
   ═══════════════════════════════════════════ */
const playerTopPlays=new Map();        // pid -> array of recent plays (max 50)
const globalTopPlays=[];                // sorted by impressiveness (max 50)
const TP_PLAYER_MAX=50;
const TP_GLOBAL_MAX=50;

function detectTopPlay(room,result){
  const plays=[];
  /* Reaction tier */
  if(room.mode==="reaction"&&typeof result.reactionMs==="number"&&result.reactionMs<=180&&!result.isFalseStart){
    plays.push({
      type:"reaction",metric:result.reactionMs,
      value:result.reactionMs.toFixed(2)+" ms",
      context:result.reactionTier?result.reactionTier.name:"Elite",
      impressiveness:result.reactionMs<150?1500:800
    });
  }
  /* Bullseye perfect */
  if(room.mode==="bullseye"&&result.value<=0.05){
    plays.push({
      type:"bullseye",metric:result.value,
      value:(result.value*1000).toFixed(0)+" ms Abweichung",
      context:result.value<0.02?"Perfekt!":"Sehr gut",
      impressiveness:result.value<0.02?1200:600
    });
  }
  /* Memory exact */
  if(room.mode==="memory"&&result.value<0.01){
    plays.push({
      type:"memory",metric:result.value,
      value:"Exakt!",
      context:"Memory perfekt",
      impressiveness:1000
    });
  }
  /* Tap Frenzy speedster */
  if(room.mode==="tapfrenzy"&&result.value>0&&room.roundData){
    const taps=Math.round((room.roundData.duration||5)/result.value);
    if(taps>=50){
      plays.push({
        type:"tapfrenzy",metric:taps,
        value:taps+" Taps",
        context:taps>=60?"Speedster":"Schnell",
        impressiveness:Math.min(1500,taps*15)
      });
    }
  }
  /* Streak achievement (>=3) */
  if(typeof result.streakAfter==="number"&&result.streakAfter>=3){
    const tier=getStreakTier(result.streakAfter);
    plays.push({
      type:"streak",metric:result.streakAfter,
      value:"Streak "+tier.label+" ×"+tier.mult,
      context:result.streakAfter+" Wins in Folge",
      impressiveness:result.streakAfter*250
    });
  }
  /* Streak broken from high streak (drama) */
  if(result.streakBroken&&result.streakBefore>=4){
    plays.push({
      type:"streakbreak",metric:result.streakBefore,
      value:"Streak gebrochen",
      context:"war auf ×"+getStreakTier(result.streakBefore).mult,
      impressiveness:result.streakBefore*120
    });
  }
  /* Predictor 3-star correct */
  if(result.predictionCorrect&&result.predictionMultiplier>=2.0){
    plays.push({
      type:"predictor",metric:result.predictionMultiplier,
      value:"Vorhersage ×2.0",
      context:"3-Sterne-Treffer",
      impressiveness:200
    });
  }
  if(plays.length===0)return null;
  return plays.sort((a,b)=>b.impressiveness-a.impressiveness)[0];
}

function recordTopPlay(pid,playerName,playerAvatar,mode,play,matchCode){
  if(!pid||!play)return null;
  const entry={
    id:"tp_"+Date.now()+"_"+Math.random().toString(36).substr(2,5),
    pid,playerName,playerAvatar,
    type:play.type,
    value:play.value,
    metric:play.metric,
    context:play.context,
    impressiveness:play.impressiveness,
    mode,
    timestamp:Date.now(),
    matchCode
  };
  /* Personal */
  if(!playerTopPlays.has(pid))playerTopPlays.set(pid,[]);
  const personal=playerTopPlays.get(pid);
  personal.unshift(entry);
  if(personal.length>TP_PLAYER_MAX)personal.length=TP_PLAYER_MAX;
  /* Global */
  globalTopPlays.push(entry);
  globalTopPlays.sort((a,b)=>b.impressiveness-a.impressiveness);
  if(globalTopPlays.length>TP_GLOBAL_MAX)globalTopPlays.length=TP_GLOBAL_MAX;
  return entry;
}

function getTopPlaysForClient(pid){
  const personal=(playerTopPlays.get(pid)||[]).slice(0,20);
  const global=globalTopPlays.slice(0,20).map(p=>({...p,isMine:p.pid===pid}));
  return{personal,global};
}
/* ═══════════════════════════════════════════ */

function makeRoom(code,sk,name,avatar,format,roundsPerPhase){
  return{code,phase:"lobby",mode:null,format:format||"ffa",
    roundsPerPhase:roundsPerPhase||3,currentRound:0,currentPhaseRound:0,
    wheelEnabled:true,selectedModes:[...GAME_MODES],
    hardcoreMode:true, /* Default = on */
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
    players:room.players.map(p=>({
      id:p.id,name:p.name,avatar:p.avatar,team:p.team,connected:p.connected,eliminated:p.eliminated,
      /* ELO data per player (Feature 1) */
      elo:p.pid?getPlayerEloData(p.pid):null
    })),
    results:room.results,finalScores:room.finalScores,teamScores:room.teamScores||null,
    scores:room.scores,phaseScores:room.phaseScores,
    hostId:room.hostId,subs:subMap,teamSubs:tSubMap,
    wheelEnabled:room.wheelEnabled!==false,selectedModes:room.selectedModes||GAME_MODES,
    hardcoreMode:!!room.hardcoreMode, /* Feature 8 */
    /* ELO updates from last round (Feature 1) */
    eloUpdates:room.eloUpdates||null,
    /* Feature 3: prediction state */
    predictions:room.predictions?Object.keys(room.predictions).reduce((m,k)=>{
      /* don't expose other players' predictions during prediction phase — only "submitted: true/false" */
      m[k]={submitted:true};
      return m;
    },{}):{},
    predictionDeadline:room.predictionDeadline||null,
    predictionOptions:room.phase==="prediction"?getPredictionOptions(room.mode):null,
    /* Feature 4: tournament state */
    tournament:room.tournament||null,
    afterResultsAction:room._afterResultsAction||null,
    /* Feature 5: streak state */
    streaks:room.streaks||{}};
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
  room.players.forEach(p=>{room.scores[p.id]=50;room.phaseScores[p.id]=50;p.eliminated=false});
  room.streaks={}; /* Feature 5: streak reset */
}

// Spin phase: pick random mode, prepare round data
function spinForRound(room){
  // Safety: prevent overflow rounds in teams mode
  if(room.format==="teams"&&room.currentRound>=room.roundsPerPhase){
    room.finalScores={...room.scores};room.phase="gameover";bc(room);return;
  }
  room.currentRound++;room.currentPhaseRound++;
  room.mode=pickMode(room);
  room.roundData=genRoundData(room.mode,room.format,room.hardcoreMode);
  /* Feature 7: Reaction Anti-Tilt — if mode is reaction, check eligible players */
  if(room.mode==="reaction"){
    const eligiblePids=[];
    room.players.forEach(p=>{
      if(p.pid&&shouldGiveAntiTilt(p.pid))eligiblePids.push(p.pid);
    });
    if(eligiblePids.length>0){
      room.roundData.antiTiltActive=true;
      room.roundData.antiTiltFor=eligiblePids;
      /* Place green in middle position for slightly easier visual scan */
      room.roundData.greenIdx=5;
    }
  }
  room.subs={};room.teamSubs={};room.results=null;room.teamScores=null;room.playerStates={};
  room.eloUpdates=null; /* Feature 1: clear previous ELO updates */
  room.predictions=null;room.predictionDeadline=null; /* Feature 3 */
  room.phase="spin";bc(room);
}

/* Feature 3: helper to transition from prediction phase to actual play */
function startActualPlay(room){
  if(!room||room.phase==="playing")return;
  room.phase="playing";
  if(room.mode==="timesense")room.zeitStartedAt=Date.now();
  bc(room);
  scheduleZeitStop(room);
}

/* ═══════════════════════════════════════════
   STREAK SYSTEM (Feature 5)
   ═══════════════════════════════════════════ */
const STREAK_TIERS=[
  {wins:0,mult:1,label:""},
  {wins:1,mult:1,label:""},
  {wins:2,mult:2,label:"🔥"},
  {wins:3,mult:4,label:"🔥🔥"},
  {wins:4,mult:8,label:"🔥🔥🔥"}
];
function getStreakTier(wins){
  if(wins>=4)return STREAK_TIERS[4];
  return STREAK_TIERS[wins]||STREAK_TIERS[0];
}
function ensureStreakState(room,sid){
  if(!room.streaks)room.streaks={};
  if(!room.streaks[sid])room.streaks[sid]={current:0,multiplier:1,longest:0};
  return room.streaks[sid];
}
/* ═══════════════════════════════════════════ */

/* ═══════════════════════════════════════════
   TOURNAMENT (Feature 4)
   ═══════════════════════════════════════════ */
const TOURNAMENT_BONUSES={champion:200,finalist:100,semifinalist:50,quarterfinalist:25};
const TOURNAMENT_DC_TIMEOUT=60000;

function generateBracket(playerIds,size){
  const shuffled=[...playerIds].sort(()=>Math.random()-0.5);
  const bracket=[];
  /* Round 0: opening matches */
  for(let i=0;i<size/2;i++){
    bracket.push({
      matchId:size===8?"qf"+(i+1):"sf"+(i+1),
      round:0,
      playerA:shuffled[i*2]||null,
      playerB:shuffled[i*2+1]||null,
      winner:null,scoreA:0,scoreB:0,games:[]
    });
  }
  /* Round 1: semifinals (only if 8) */
  if(size===8){
    for(let i=0;i<2;i++){
      bracket.push({
        matchId:"sf"+(i+1),round:1,
        playerA:null,playerB:null,
        winner:null,scoreA:0,scoreB:0,games:[]
      });
    }
  }
  /* Final */
  bracket.push({
    matchId:"final",round:size===8?2:1,
    playerA:null,playerB:null,
    winner:null,scoreA:0,scoreB:0,games:[]
  });
  return bracket;
}
function getRoundLabel(size,round){
  if(size===8){
    if(round===0)return"VIERTELFINALE";
    if(round===1)return"HALBFINALE";
    return"FINALE";
  }
  if(round===0)return"HALBFINALE";
  return"FINALE";
}
function getActiveTournamentMatch(room){
  if(!room.tournament)return null;
  return room.tournament.bracket[room.tournament.currentMatchIdx]||null;
}
/* After a match win is decided, place winner into next round's slot */
function placeWinnerInNextRound(room,finishedMatchIdx){
  const t=room.tournament;
  const m=t.bracket[finishedMatchIdx];
  if(!m||!m.winner)return;
  /* Find the match in the next round that this winner advances to */
  const size=t.size;
  const myRound=m.round;
  const matchesInRound=size===8?(myRound===0?4:myRound===1?2:1):(myRound===0?2:1);
  const myPosInRound=t.bracket.filter(x=>x.round===myRound).indexOf(m);
  const nextRound=myRound+1;
  const nextPosInRound=Math.floor(myPosInRound/2);
  const nextMatch=t.bracket.find(x=>x.round===nextRound&&t.bracket.filter(y=>y.round===nextRound).indexOf(x)===nextPosInRound);
  if(!nextMatch)return; /* this was the final */
  /* place A or B based on even/odd position */
  if(myPosInRound%2===0)nextMatch.playerA=m.winner;
  else nextMatch.playerB=m.winner;
}
/* Check if all matches in current round are done; advance currentMatchIdx accordingly */
function findNextMatchIdx(room){
  const t=room.tournament;
  for(let i=0;i<t.bracket.length;i++){
    const m=t.bracket[i];
    if(m.winner||(!m.playerA&&!m.playerB))continue;
    /* Match ready if both players assigned */
    if(m.playerA&&m.playerB)return i;
  }
  return -1;
}
function awardTournamentBonuses(room){
  const t=room.tournament;
  const champion=t.bracket[t.bracket.length-1].winner;
  const finalMatch=t.bracket[t.bracket.length-1];
  const finalist=finalMatch.playerA===champion?finalMatch.playerB:finalMatch.playerA;
  const bonuses={};
  if(champion)bonuses[champion]=TOURNAMENT_BONUSES.champion;
  if(finalist)bonuses[finalist]=TOURNAMENT_BONUSES.finalist;
  /* Find semifinalists (lost in round before final) */
  const finalRound=finalMatch.round;
  const semiRound=finalRound-1;
  if(semiRound>=0){
    t.bracket.filter(m=>m.round===semiRound).forEach(m=>{
      if(m.winner){
        const loser=m.playerA===m.winner?m.playerB:m.playerA;
        if(loser&&!bonuses[loser])bonuses[loser]=TOURNAMENT_BONUSES.semifinalist;
      }
    });
  }
  /* Quarterfinalists for 8-player bracket */
  if(t.size===8){
    t.bracket.filter(m=>m.round===0).forEach(m=>{
      if(m.winner){
        const loser=m.playerA===m.winner?m.playerB:m.playerA;
        if(loser&&!bonuses[loser])bonuses[loser]=TOURNAMENT_BONUSES.quarterfinalist;
      }
    });
  }
  /* Apply bonuses */
  Object.keys(bonuses).forEach(sid=>{
    room.scores[sid]=(room.scores[sid]||0)+bonuses[sid];
  });
  t.bonusAwarded=bonuses;
  t.champion=champion;
}
/* Mark non-active tournament players as "eliminated" so they go to spectator */
function updateTournamentEliminations(room){
  const t=room.tournament;
  if(!t)return;
  const activeMatch=getActiveTournamentMatch(room);
  const stillAlive=new Set();
  /* Champion-track: players who haven't lost yet */
  const losers=new Set();
  t.bracket.forEach(m=>{
    if(m.winner&&m.playerA&&m.playerB){
      const loser=m.playerA===m.winner?m.playerB:m.playerA;
      losers.add(loser);
    }
  });
  room.players.forEach(p=>{
    if(losers.has(p.id))p.eliminated=true;
    else p.eliminated=false;
  });
}
/* ═══════════════════════════════════════════ */

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
  if(worstId){const wp=room.players.find(p=>p.id===worstId);if(wp)wp.eliminated=true;
    /* Transfer host if eliminated player was host */
    if(worstId===room.hostId){const remaining=activePlayers(room);if(remaining.length>0){room.hostId=remaining[Math.floor(Math.random()*remaining.length)].id}}}
  room.currentPhaseRound=0;
  room.phaseScores={};activePlayers(room).forEach(p=>{room.phaseScores[p.id]=0});
  if(activePlayers(room).length<=1)return true;
  return false;
}

io.on("connection",sk=>{
  sk.on("leave",()=>{leaveCurrentRoom(sk)});

  sk.on("create",({name,avatar,format,roundsPerPhase,pid,eloBackup},cb)=>{
    if(!name)return cb({ok:false,err:"Name fehlt"});
    if(!pid)return cb({ok:false,err:"PID fehlt"});
    leaveCurrentRoom(sk);
    if(eloBackup)restorePlayerEloFromBackup(pid,eloBackup);
    const code=mkCode();
    const room=makeRoom(code,sk,name,avatar,format,roundsPerPhase);
    /* Attach persistent pid to the player */
    room.players[0].pid=pid;
    room.scores[sk.id]=0;room.phaseScores[sk.id]=0;
    rooms.set(code,room);sk.join(code);cb({ok:true,code});bc(room);
  });

  sk.on("join",({code,name,avatar,pid,eloBackup},cb)=>{
    leaveCurrentRoom(sk);
    const room=rooms.get(code&&code.toUpperCase());
    if(!room)return cb({ok:false,err:"Raum nicht gefunden"});
    if(room.phase!=="lobby")return cb({ok:false,err:"Spiel läuft"});
    if(room.players.length>=8)return cb({ok:false,err:"Voll"});
    if(room.players.find(p=>p.name===name))return cb({ok:false,err:"Name vergeben"});
    if(!pid)return cb({ok:false,err:"PID fehlt"});
    if(eloBackup)restorePlayerEloFromBackup(pid,eloBackup);
    room.players.push({id:sk.id,name,avatar,team:null,connected:true,eliminated:false,pid});
    room.scores[sk.id]=0;room.phaseScores[sk.id]=0;
    sk.join(code.toUpperCase());cb({ok:true,code:code.toUpperCase()});bc(room);
  });

  sk.on("setTeam",({team})=>{const f=findRoom(sk.id);if(!f)return;f.player.team=team;bc(f.room)});

  /* Feature 2: Request reaction stats + global leaderboard */
  sk.on("requestReactionStats",({pid},cb)=>{
    if(!pid||typeof cb!=="function")return cb&&cb({ok:false});
    cb({
      ok:true,
      personal:getReactionStatsClient(pid),
      leaderboard:getGlobalReactionLB(pid)
    });
  });

  /* Feature 6: Request top plays */
  sk.on("requestTopPlays",({pid},cb)=>{
    if(!pid||typeof cb!=="function")return cb&&cb({ok:false});
    const data=getTopPlaysForClient(pid);
    cb({ok:true,personal:data.personal,global:data.global});
  });

  sk.on("updateSettings",({format,roundsPerPhase,wheelEnabled,selectedModes,hardcoreMode})=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    if(format)room.format=format;
    if(roundsPerPhase)room.roundsPerPhase=roundsPerPhase;
    if(wheelEnabled!==undefined)room.wheelEnabled=wheelEnabled;
    if(selectedModes&&Array.isArray(selectedModes)&&selectedModes.length>0)room.selectedModes=selectedModes;
    if(hardcoreMode!==undefined)room.hardcoreMode=!!hardcoreMode; /* Feature 8 */
    bc(room);
  });

  sk.on("start",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    const connected=room.players.filter(p=>p.connected);if(connected.length<2)return;
    if(room.format==="teams")connected.forEach((p,i)=>{if(!p.team)p.team=i%2===0?"a":"b"});
    /* Feature 4: Tournament setup */
    if(room.format==="tournament"){
      if(connected.length!==4&&connected.length!==8)return; /* must be 4 or 8 */
      fullReset(room);
      const size=connected.length;
      room.tournament={
        size,
        bracket:generateBracket(connected.map(p=>p.id),size),
        currentMatchIdx:0,
        currentRound:0,
        champion:null,
        bonusAwarded:{}
      };
      room.phase="bracket";
      bc(room);
      return;
    }
    fullReset(room);
    spinForRound(room);
  });

  /* Feature 4: Host advances tournament from bracket to first/next match */
  sk.on("tournamentNextMatch",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    if(room.format!=="tournament"||!room.tournament)return;
    if(room.phase!=="bracket")return;
    const idx=findNextMatchIdx(room);
    if(idx<0){
      /* No more matches — should already be at tournamentEnd */
      if(!room.tournament.champion)awardTournamentBonuses(room);
      room.phase="tournamentEnd";
      bc(room);
      return;
    }
    room.tournament.currentMatchIdx=idx;
    /* Mark non-active players as eliminated for spectator-routing */
    updateTournamentEliminations(room);
    /* Now spin for the actual game */
    room.subs={};room.teamSubs={};room.results=null;room.playerStates={};
    room.eloUpdates=null;
    room.predictions=null;room.predictionDeadline=null;
    room.streaks={}; /* Feature 5: streaks reset per tournament match */
    room.currentRound++;
    room.mode=pickMode(room);
    room.roundData=genRoundData(room.mode,"ffa",room.hardcoreMode); /* tournament games use FFA round-data shape */
    room.phase="spin";
    bc(room);
  });

  // After pregame → first spin
  sk.on("startFirstRound",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    spinForRound(room);
  });

  // After spin animation → start prediction phase
  sk.on("beginPlay",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    /* Predictor disabled → directly to play */
    startActualPlay(room);
    return;
    /* legacy code below disabled */
    const opts=getPredictionOptions(room.mode);
    if(opts){
      room.phase="prediction";
      room.predictions={};
      room.predictionDeadline=Date.now()+PREDICTION_TIMEOUT_MS;
      bc(room);
      /* Auto-advance after timeout */
      const code=room.code;
      const lockedRound=room.currentRound;
      setTimeout(()=>{
        const r=rooms.get(code);
        if(!r||r.phase!=="prediction"||r.currentRound!==lockedRound)return;
        startActualPlay(r);
      },PREDICTION_TIMEOUT_MS+150);
    }else{
      /* mode without prediction support → straight to play */
      startActualPlay(room);
    }
  });

  /* Feature 3: prediction submission */
  sk.on("predict",({option})=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;
    if(room.phase!=="prediction")return;
    if(f.player.eliminated)return;
    if(room.predictions[sk.id])return; /* already predicted */
    /* Feature 4: in tournament, only the 2 active match players predict */
    if(room.format==="tournament"&&room.tournament){
      const m=getActiveTournamentMatch(room);
      if(!m||(m.playerA!==sk.id&&m.playerB!==sk.id))return;
    }
    const opts=getPredictionOptions(room.mode);if(!opts)return;
    const opt=opts.find(o=>o.id===option);
    if(!opt&&option!=="none")return; /* invalid */
    room.predictions[sk.id]={
      pid:f.player.pid||null,
      option:option==="none"?null:option,
      multiplier:opt?opt.mult:1,
      submittedAt:Date.now()
    };
    bc(room);
    /* If everyone submitted, advance immediately */
    const active=activePlayers(room);
    const requiredCount=(room.format==="tournament"&&room.tournament)?2:active.length;
    if(Object.keys(room.predictions).length>=requiredCount){
      startActualPlay(room);
    }
  });

  /* Feature 7: Hidden Tricks event handlers */
  /* Bullseye Pre-Tap Cancel — client signals it's discovering this trick */
  sk.on("trickBullseyeCancel",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room,player}=f;
    if(room.phase!=="playing"||room.mode!=="bullseye")return;
    if(!player.pid)return;
    /* Track + maybe announce discovery via separate event */
    ensureTrickState(player.pid);
    const set=playerDiscoveredTricks.get(player.pid);
    const isFirst=!set.has("bullseye_cancel");
    set.add("bullseye_cancel");
    const stats=playerTrickStats.get(player.pid);
    stats["bullseye_cancel"]=(stats["bullseye_cancel"]||0)+1;
    if(isFirst){
      io.to(sk.id).emit("trickDiscovered",{trick:HIDDEN_TRICKS.bullseye_cancel});
    }
  });
  /* Memory Doubletap-Zoom — request 200ms extra display time */
  sk.on("trickMemoryDoubletap",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room,player}=f;
    if(room.phase!=="playing"||room.mode!=="memory")return;
    if(!player.pid)return;
    /* Mark on player state so submit knows to deduct 5 coins */
    if(!room.playerStates[sk.id])room.playerStates[sk.id]={};
    room.playerStates[sk.id].memoryDoubletap=true;
    /* Track discovery */
    ensureTrickState(player.pid);
    const set=playerDiscoveredTricks.get(player.pid);
    const isFirst=!set.has("memory_doubletap");
    set.add("memory_doubletap");
    const stats=playerTrickStats.get(player.pid);
    stats["memory_doubletap"]=(stats["memory_doubletap"]||0)+1;
    if(isFirst){
      io.to(sk.id).emit("trickDiscovered",{trick:HIDDEN_TRICKS.memory_doubletap});
    }
  });
  /* Request trick stats for profile */
  sk.on("requestTrickStats",({pid},cb)=>{
    if(!pid||typeof cb!=="function")return cb&&cb({ok:false});
    cb({ok:true,...getTrickStatsClient(pid)});
  });

  sk.on("submit",({value,reactionMs,rawValue})=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;
    if(room.phase!=="playing")return;if(room.subs[sk.id])return;
    if(f.player.eliminated)return;
    /* Feature 4: in tournament, only the 2 active match players can submit */
    if(room.format==="tournament"&&room.tournament){
      const m=getActiveTournamentMatch(room);
      if(!m||(m.playerA!==sk.id&&m.playerB!==sk.id))return;
    }
    /* Feature 2: sanity-clamp for reaction mode (anti-cheat baseline) */
    let sanitizedValue=value;
    let finalReactionMs=null;
    let isFalseStart=false;
    if(room.mode==="reaction"){
      if(typeof sanitizedValue!=="number"||isNaN(sanitizedValue))sanitizedValue=9.999;
      /* impossibly fast reaction (under 80ms) → likely cheat or weird tap */
      else if(sanitizedValue<0.08&&sanitizedValue>=0)sanitizedValue=0.08;
      /* clamp upper limit: 2 seconds = slow but valid; 9.999 = bust signal */
      else if(sanitizedValue>2&&sanitizedValue<9)sanitizedValue=2;
      else if(sanitizedValue>=9)sanitizedValue=9.999;
      /* Feature 2: precise ms tracking */
      isFalseStart=sanitizedValue>=9;
      if(isFalseStart){
        finalReactionMs=9999;
      }else if(typeof reactionMs==="number"&&!isNaN(reactionMs)&&reactionMs>=50&&reactionMs<5000){
        /* trust client high-precision value if within plausible range */
        finalReactionMs=Math.max(50,Math.min(5000,reactionMs));
      }else{
        /* fallback: convert seconds to ms */
        finalReactionMs=Math.max(50,Math.min(5000,sanitizedValue*1000));
      }
      /* Anti-cheat: range validation only (50-5000ms is plausible for human reactions).
         Server-side green-time anchor would require additional client signaling — kept for v2. */
      /* Feature 8: Hardcore Reaction — value becomes deviation from 200ms target (smaller is better) */
      if(room.hardcoreMode&&!isFalseStart){
        const targetMs=200;
        const deviationMs=Math.abs(finalReactionMs-targetMs);
        sanitizedValue=deviationMs/1000; /* in seconds */
      }
    }
    /* Feature 8: Hardcore Bullseye — value becomes deviation from sweetSpot (5x targetTime) */
    if(room.mode==="bullseye"&&room.hardcoreMode&&typeof rawValue==="number"){
      const sweetSpot=room.roundData.targetTime*(room.roundData.hardcoreSweetSpotMult||5);
      sanitizedValue=Math.abs(rawValue-sweetSpot);
    }
    /* Feature 8: Hardcore Tap Frenzy — value becomes |actualTaps - tapTarget| converted to time */
    if(room.mode==="tapfrenzy"&&room.hardcoreMode&&typeof rawValue==="number"){
      const target=room.roundData.tapTarget||25;
      const dev=Math.abs(rawValue-target);
      /* convert to "value" (smaller = better) — divide by 100 to get tap-units in time-like range */
      sanitizedValue=dev/100;
    }
    const subData={pid:sk.id,name:f.player.name,avatar:f.player.avatar,value:sanitizedValue,ts:Date.now()};
    if(room.mode==="reaction"){
      subData.reactionMs=finalReactionMs;
      subData.reactionTier=reactionTier(finalReactionMs);
      subData.isFalseStart=isFalseStart;
      /* Record for personal best + global LB if valid (and player has pid) */
      if(!isFalseStart&&f.player.pid&&finalReactionMs<5000){
        const rec=recordReaction(f.player.pid,f.player.name,f.player.avatar,finalReactionMs);
        subData.isPB=rec.isPB;
        subData.prevBest=rec.prevBest;
        /* Feature 7: anti-tilt tracking */
        recordReactionForAntiTilt(f.player.pid,finalReactionMs);
        /* Was this round an anti-tilt round? Check room's flag */
        if(room.roundData&&room.roundData.antiTiltActive){
          activateTrick(f.player.pid,"reaction_antitilt",subData);
          if(subData.trickFirstDiscovery){
            io.to(sk.id).emit("trickDiscovered",{trick:HIDDEN_TRICKS.reaction_antitilt});
          }
        }
      }
    }
    room.subs[sk.id]=subData;
    bc(room);
    const active=activePlayers(room);
    /* Feature 4: in tournament, only 2 players need to submit */
    const requiredCount=(room.format==="tournament"&&room.tournament)?2:active.length;
    if(Object.keys(room.subs).length>=requiredCount){
      const sorted=Object.values(room.subs).sort((a,b)=>a.value-b.value);
      sorted.forEach((r,i)=>{
        const baseCoins=posCoins(i);
        /* Feature 3: prediction multiplier */
        const pred=room.predictions&&room.predictions[r.pid];
        let multiplier=1;
        let predictionCorrect=false;
        if(pred&&pred.option){
          predictionCorrect=evaluatePrediction(room.mode,pred.option,r,i+1,sorted.length);
          if(predictionCorrect)multiplier=pred.multiplier;
        }
        const finalCoins=Math.round(baseCoins*multiplier);
        r.rank=i+1;r.baseCoins=baseCoins;r.coins=finalCoins;
        r.predictionCorrect=predictionCorrect;
        r.predictionMultiplier=multiplier;
        r.predictionOption=pred?pred.option:null;
        r.bonusCoins=finalCoins-baseCoins;
        room.scores[r.pid]=Math.max(0,(room.scores[r.pid]||0)+finalCoins);
        room.phaseScores[r.pid]=Math.max(0,(room.phaseScores[r.pid]||0)+finalCoins);
      });
      /* ═══ FEATURE 5: STREAK SYSTEM ═══
         FFA + Tournament only. Updates streak state, applies multiplier to winner's coins. */
      if((room.format==="ffa"||room.format==="tournament")&&sorted.length>=1){
        sorted.forEach((r,idx)=>{
          const s=ensureStreakState(room,r.pid);
          if(idx===0){
            /* Winner: increment streak */
            const before=s.current;
            s.current=before+1;
            const tier=getStreakTier(s.current);
            s.multiplier=tier.mult;
            if(s.current>s.longest)s.longest=s.current;
            r.streakBefore=before;
            r.streakAfter=s.current;
            r.streakMultiplier=tier.mult;
            r.streakBroken=false;
            /* Apply additional streak multiplier to winner's coins (on top of prediction) */
            if(tier.mult>1){
              const newFinalCoins=Math.round(r.baseCoins*(r.predictionMultiplier||1)*tier.mult);
              const additionalBonus=newFinalCoins-r.coins;
              r.coins=newFinalCoins;
              r.bonusCoins=(r.bonusCoins||0)+additionalBonus;
              room.scores[r.pid]=Math.max(0,(room.scores[r.pid]||0)+additionalBonus);
              room.phaseScores[r.pid]=Math.max(0,(room.phaseScores[r.pid]||0)+additionalBonus);
            }
          }else{
            /* Loser: reset streak */
            const before=s.current;
            r.streakBefore=before;
            r.streakAfter=0;
            r.streakMultiplier=1;
            r.streakBroken=before>=2; /* was on hot streak before reset */
            s.current=0;
            s.multiplier=1;
          }
        });
      }
      /* ═══ FEATURE 8: HARDCORE COIN BONUS (×1.5 for surviving hardcore) ═══ */
      if(room.hardcoreMode){
        sorted.forEach(r=>{
          const oldCoins=r.coins||0;
          const newCoins=Math.round(oldCoins*1.5);
          const bonus=newCoins-oldCoins;
          r.coins=newCoins;
          r.bonusCoins=(r.bonusCoins||0)+bonus;
          r.hardcoreBonus=bonus;
          room.scores[r.pid]=Math.max(0,(room.scores[r.pid]||0)+bonus);
          room.phaseScores[r.pid]=Math.max(0,(room.phaseScores[r.pid]||0)+bonus);
        });
      }
      /* ═══ FEATURE 7: TRICK DETECTION (Lock-In + Memory Doubletap submission penalty) ═══ */
      sorted.forEach(r=>{
        const player=room.players.find(p=>p.id===r.pid);
        if(!player||!player.pid)return;
        /* Countdown Lock-In: value (deviation) is within 0.05 */
        if(room.mode==="countdown"&&r.value<=0.05){
          activateTrick(player.pid,"countdown_lockin",r);
          /* +5 bonus coins */
          r.coins=(r.coins||0)+5;
          r.bonusCoins=(r.bonusCoins||0)+5;
          room.scores[r.pid]=Math.max(0,(room.scores[r.pid]||0)+5);
          room.phaseScores[r.pid]=Math.max(0,(room.phaseScores[r.pid]||0)+5);
          if(r.trickFirstDiscovery){
            io.to(r.pid).emit("trickDiscovered",{trick:HIDDEN_TRICKS.countdown_lockin});
          }
        }
        /* Memory Doubletap: if used this round, deduct 5 coins */
        if(room.mode==="memory"&&room.playerStates&&room.playerStates[r.pid]&&room.playerStates[r.pid].memoryDoubletap){
          /* Trick already activated when emitted; deduct now */
          r.coins=Math.max(0,(r.coins||0)-5);
          r.bonusCoins=(r.bonusCoins||0)-5;
          room.scores[r.pid]=Math.max(0,(room.scores[r.pid]||0)-5);
          room.phaseScores[r.pid]=Math.max(0,(room.phaseScores[r.pid]||0)-5);
          r.memoryDoubletapUsed=true;
        }
      });
      /* ═══ FEATURE 6: TOP PLAY DETECTION ═══ */
      sorted.forEach(r=>{
        const play=detectTopPlay(room,r);
        if(play){
          const player=room.players.find(p=>p.id===r.pid);
          if(player&&player.pid){
            const entry=recordTopPlay(player.pid,r.name,r.avatar,room.mode,play,room.code);
            r.topPlay=entry;
          }
        }
      });
      if(room.format==="teams"){
        const teamA=sorted.filter(s=>{const pl=room.players.find(x=>x.id===s.pid);return pl&&pl.team==="a"});
        const teamB=sorted.filter(s=>{const pl=room.players.find(x=>x.id===s.pid);return pl&&pl.team==="b"});
        const avgA=teamA.length?teamA.reduce((s,r)=>s+(room.scores[r.pid]||0),0)/teamA.length:0;
        const avgB=teamB.length?teamB.reduce((s,r)=>s+(room.scores[r.pid]||0),0)/teamB.length:0;
        room.teamScores={a:avgA,b:avgB};
      }
      /* ═══ FEATURE 1: ELO UPDATE ═══
         Only for FFA matches with at least 2 players, and only if mode is in GAME_MODES.
         Uses persistent pid (not socket id) for tracking. */
      if(room.format==="ffa"&&sorted.length>=2&&GAME_MODES.indexOf(room.mode)!==-1){
        const eloRankings=sorted.map(r=>{
          const pl=room.players.find(x=>x.id===r.pid);
          return pl&&pl.pid?{pid:pl.pid,rank:r.rank,sockId:r.pid}:null;
        }).filter(x=>x);
        if(eloRankings.length>=2){
          const updates=calcEloUpdates(eloRankings,room.mode);
          applyEloUpdates(updates,room.mode);
          /* Attach ELO updates to room state, keyed by socket-id for client mapping */
          const eloByPid={};
          eloRankings.forEach(er=>{
            const u=updates[er.pid];
            if(u){
              eloByPid[er.sockId]={
                mode:room.mode,
                oldElo:u.oldElo,
                newElo:u.newElo,
                delta:u.delta,
                tierBefore:eloTier(u.oldElo),
                tierAfter:eloTier(u.newElo)
              };
            }
          });
          room.eloUpdates=eloByPid;
        }
      }
      /* Feature 4: Tournament best-of-3 game-decision */
      if(room.format==="tournament"&&room.tournament){
        const t=room.tournament;
        const matchObj=t.bracket[t.currentMatchIdx];
        if(matchObj&&!matchObj.winner){
          const winner=sorted[0];
          if(winner){
            matchObj.games.push({mode:room.mode,winnerId:winner.pid,results:sorted});
            if(winner.pid===matchObj.playerA)matchObj.scoreA++;
            else if(winner.pid===matchObj.playerB)matchObj.scoreB++;
            /* Best-of-3 won? */
            if(matchObj.scoreA>=2||matchObj.scoreB>=2){
              matchObj.winner=matchObj.scoreA>matchObj.scoreB?matchObj.playerA:matchObj.playerB;
              placeWinnerInNextRound(room,t.currentMatchIdx);
              /* Check if this was the final */
              const isLast=t.currentMatchIdx===t.bracket.length-1;
              if(isLast){
                awardTournamentBonuses(room);
                /* Show results for final game first, then transition to tournamentEnd */
                room.results=sorted;room.phase="results";room._afterResultsAction="tournamentEnd";
              }else{
                /* Show game results, then back to bracket */
                room.results=sorted;room.phase="results";room._afterResultsAction="bracket";
              }
            }else{
              /* Match continues — show results, then auto-advance to next game */
              room.results=sorted;room.phase="results";room._afterResultsAction="continueMatch";
            }
            bc(room);
            return;
          }
        }
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
      sorted.forEach((r,i)=>{
        const coins=posCoins(i);
        r.rank=i+1;r.baseCoins=coins;r.coins=coins;
        room.scores[r.pid]=Math.max(0,(room.scores[r.pid]||0)+coins);
        room.phaseScores[r.pid]=Math.max(0,(room.phaseScores[r.pid]||0)+coins);
      });
      const teamA=sorted.filter(s=>{const pl=room.players.find(x=>x.id===s.pid);return pl&&pl.team==="a"});
      const teamB=sorted.filter(s=>{const pl=room.players.find(x=>x.id===s.pid);return pl&&pl.team==="b"});
      const avgA=teamA.length?teamA.reduce((s,r)=>s+(room.scores[r.pid]||0),0)/teamA.length:0;
      const avgB=teamB.length?teamB.reduce((s,r)=>s+(room.scores[r.pid]||0),0)/teamB.length:0;
      room.teamScores={a:avgA,b:avgB};
      room.results=sorted;room.phase="results";bc(room);
    }
  });

  sk.on("nextRound",()=>{
    const f=findRoom(sk.id);if(!f)return;const{room}=f;if(room.hostId!==sk.id)return;
    clearTimers(room);
    /* Feature 4: Tournament flow */
    if(room.format==="tournament"&&room.tournament){
      const action=room._afterResultsAction;
      room._afterResultsAction=null;
      if(action==="tournamentEnd"){
        room.finalScores={...room.scores};
        room.phase="tournamentEnd";
        bc(room);
        return;
      }
      if(action==="bracket"){
        /* Return to bracket view; host can advance to next match */
        updateTournamentEliminations(room);
        room.phase="bracket";
        room.results=null;
        bc(room);
        return;
      }
      /* default: continueMatch — next game in same match */
      room.subs={};room.results=null;room.playerStates={};
      room.eloUpdates=null;
      room.predictions=null;room.predictionDeadline=null;
      room.currentRound++;
      room.mode=pickMode(room);
      room.roundData=genRoundData(room.mode,"ffa",room.hardcoreMode);
      room.phase="spin";
      bc(room);
      return;
    }
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
    if(room.eloUpdates&&room.eloUpdates[oldId]){room.eloUpdates[sk.id]=room.eloUpdates[oldId];delete room.eloUpdates[oldId]}
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
srv.listen(PORT,()=>console.log("Time2Tap on :"+PORT));
