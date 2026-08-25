/*
 Mafia Rooms — rules & secrecy suite (proven against v1)
 Run:
   1) Start the server fast-paced:
      REVEAL_MS=60 NIGHT_MS=500 DAY_MS=130 VOTE_MS=400 BOT_MS=5 PORT=3211 node server.js
   2) In another shell (needs socket.io-client available):
      node test/rules.js
 Proves: role dealing (2 mafia / 1 detective / 1 doctor at 7p), full games to valid
 winners, revealed roles match ground truth, and SECRECY — living non-mafia never
 receive mafiaSeats, role fields, or mafia-channel chat. Plus 3 bot games w/ rematch.
*/
const { io } = require("socket.io-client");
const URL = "http://localhost:3211";
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const pick = (a)=>a[Math.floor(Math.random()*a.length)];

function mk(name){
  const s = io(URL,{ transports:["websocket"] });
  s.nm=name; s.st=null; s.seat=-1; s.role=null; s.violations=[]; s.sawMafChat=0; s.gotMafLeak=0;
  s.on("state",({room,mySeat})=>{
    s.st=room; s.seat=mySeat;
    if (room.yourRole) s.role=room.yourRole;
    const alive = room.players[mySeat] && room.players[mySeat].alive;
    if (room.status==="playing" && alive){
      // players array must never carry roles
      for (const p of room.players) if ("role" in p) s.violations.push("role field leaked in players[]");
      // non-mafia must never see mafia seats
      if (s.role && s.role!=="mafia" && room.mafiaSeats) s.gotMafLeak++;
      // revealed pre-over must only cover the dead
      if (room.status==="playing") for (const k of Object.keys(room.revealed||{}))
        if (room.players[k] && room.players[k].alive) s.violations.push("living player's role revealed");
      // mafia-channel chat must not reach living non-mafia
      if (s.role!=="mafia") for (const m of (room.chat||[])) if (m.ch==="maf") s.sawMafChat++;
    }
  });
  return s;
}

async function act(c){
  const r=c.st; if(!r || r.status!=="playing") return;
  const me=r.players[c.seat]; if(!me || !me.alive) return;
  const living = r.players.map((p,i)=>p.alive&&!p.left?i:-1).filter(i=>i>=0);
  if (r.phase==="night"){
    if (c.role==="mafia" && !(r.yourAct&&r.yourAct.kill!=null)){
      const mates=r.mafiaSeats||[];
      const t=living.filter(i=>!mates.includes(i));
      if (t.length) c.emit("act",{ kill:pick(t) });
      if (!c._chatted){ c._chatted=true; c.emit("chat",{ t:"psst — over here" }); }
    } else if (c.role==="detective" && !(r.yourAct&&r.yourAct.probe!=null)){
      const t=living.filter(i=>i!==c.seat); if(t.length) c.emit("act",{ probe:pick(t) });
    } else if (c.role==="doctor" && !(r.yourAct&&r.yourAct.save!=null)){
      c.emit("act",{ save:pick(living) });
    }
  } else if (r.phase==="vote" && r.yourVote===undefined){
    const t=living.filter(i=>i!==c.seat);
    c.emit("vote", Math.random()<0.85 && t.length ? { target:pick(t) } : { target:-1 });
  }
}

async function playToEnd(cs, cap){
  for (let k=0;k<cap;k++){
    const r=cs[0].st;
    if (r && r.status==="over") return true;
    for (const c of cs) await act(c);
    await sleep(12);
  }
  return false;
}

(async()=>{
  try{
    // ---- Test 1: seven humans, secrecy + correctness ----
    const cs=[]; for (let i=0;i<7;i++) cs.push(mk("P"+i));
    await sleep(300);
    let code=null; cs[0].on("joined",j=>{code=j.code;});
    cs[0].emit("create",{ name:"P0", playerId:"m0", avatar:"🦊" }); await sleep(250);
    for (let i=1;i<7;i++) cs[i].emit("join",{ code, name:"P"+i, playerId:"m"+i, avatar:"🐼" });
    await sleep(350);
    cs[0].emit("start"); await sleep(250);
    const roles = {}; cs.forEach(c=>roles[c.seat]=c.role);
    const mafiaCount = Object.values(roles).filter(r=>r==="mafia").length;
    if (mafiaCount!==2) throw new Error("7 players should deal 2 mafia, got "+mafiaCount);
    if (Object.values(roles).filter(r=>r==="detective").length!==1) throw new Error("need exactly 1 detective");
    if (Object.values(roles).filter(r=>r==="doctor").length!==1) throw new Error("need exactly 1 doctor");
    if (!await playToEnd(cs, 4000)) throw new Error("7p game didn't finish");
    const fin = cs[0].st;
    // revealed vs ground truth
    for (const [s,role] of Object.entries(fin.revealed)) if (roles[s]!==role) throw new Error("revealed role mismatch seat "+s);
    if (Object.keys(fin.revealed).length!==7) throw new Error("game over must reveal all 7");
    // winner correctness vs final board
    const m = cs.filter(c=>roles[c.seat]==="mafia" && fin.players[c.seat].alive).length;
    const o = fin.players.filter((p,i)=>p.alive && roles[i]!=="mafia").length;
    const expect = m===0 ? "village" : (m>=o ? "mafia" : null);
    if (fin.winner!==expect) throw new Error(`winner ${fin.winner} but board says ${expect} (m=${m}, o=${o})`);
    // secrecy
    for (const c of cs){
      if (c.violations.length) throw new Error(c.nm+" violations: "+c.violations[0]);
      if (c.gotMafLeak) throw new Error(c.nm+" ("+c.role+") saw mafiaSeats while alive");
      if (c.role!=="mafia" && c.sawMafChat) throw new Error(c.nm+" saw mafia-only chat while alive");
    }
    const mafiaClients = cs.filter(c=>c.role==="mafia");
    console.log("PASS secrecy+correctness — winner:", fin.winner, "| mafia chat stayed private | roles verified vs ground truth");
    cs.forEach(c=>c.close());

    // ---- Test 2: host + 6 bots, three rematches, valid endings ----
    const winners=[];
    const A=mk("Host"); await sleep(250);
    let code2=null; A.on("joined",j=>{code2=j.code;});
    A.emit("create",{ name:"Host", playerId:"mh", avatar:"🦊" }); await sleep(250);
    for (let i=0;i<6;i++) A.emit("addBot");
    await sleep(300);
    for (let g=0; g<3; g++){
      if (g===0) A.emit("start"); else A.emit("rematch");
      await sleep(250);
      if (!await playToEnd([A], 4000)) throw new Error("bot game "+g+" didn't finish");
      const r=A.st;
      if (!["mafia","village"].includes(r.winner)) throw new Error("invalid winner");
      if (Object.keys(r.revealed).length!==r.players.length) throw new Error("over must reveal all");
      winners.push(r.winner);
    }
    console.log("PASS bot games x3 with rematch — winners:", winners.join(", "));
    A.close();
    console.log("ALL MAFIA TESTS PASS");
    process.exit(0);
  }catch(e){ console.error("FAIL:", e.message); process.exit(1); }
})();
