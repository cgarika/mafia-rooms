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
    cs[0].emit("start");
    for (let k=0;k<120 && cs.some(c=>!c.role);k++) await sleep(25);   // roles arrive with the first playing state; poll instead of a fixed wait
    const roles = {}; cs.forEach(c=>roles[c.seat]=c.role);
    const mafiaCount = Object.values(roles).filter(r=>r==="mafia").length;
    if (mafiaCount!==2) throw new Error("7 players should deal 2 mafia, got "+mafiaCount);
    if (Object.values(roles).filter(r=>r==="detective").length!==1) throw new Error("need exactly 1 detective");
    if (Object.values(roles).filter(r=>r==="doctor").length!==1) throw new Error("need exactly 1 doctor");
    if (!await playToEnd(cs, 12000)) throw new Error("7p game didn't finish");
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

    // ---- Test 3 (T1 AFK policy): own server on 3221 with 2 s night/vote clocks and a 250 ms AFK clock ----
    {
      const { spawn } = require("child_process");
      const P=3221, URL2="http://localhost:"+P, VOTE=2000, AFK=250;
      const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT:String(P), REVEAL_MS:"40", NIGHT_MS:String(VOTE), DAY_MS:"60", VOTE_MS:String(VOTE), AFK_MS:String(AFK), BOT_MS:"5" }, stdio:"ignore" });
      await sleep(600);
      const mk2=(name)=>{ const c=io(URL2,{transports:["websocket"],reconnection:false}); c.nm2=name; c.st=null; c.seat=-1; c.role=null; c.logs=[]; c.on("state",({room,mySeat})=>{ c.st=room; c.seat=mySeat; if(room.yourRole) c.role=room.yourRole; if(room&&room.log) c.logs.push(room.log); }); return c; };
      const until=async(fn,ms=6000)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ if(fn()) return true; await sleep(15);} return false; };
      // 5 humans; the auto-driver acts for everyone except the "idle" seat
      const room5=async()=>{ const cs=[]; for(let i=0;i<5;i++) cs.push(mk2("Q"+i)); await sleep(250); let code=null; cs[0].on("joined",j=>{code=j.code;}); cs[0].emit("create",{name:"Q0",playerId:"q0"+Math.random(),avatar:"🦊"}); await until(()=>code); for(let i=1;i<5;i++) cs[i].emit("join",{code,name:"Q"+i,playerId:"q"+i+Math.random(),avatar:"🐼"}); await until(()=>cs[0].st&&cs[0].st.players.length===5); cs[0].emit("start"); await until(()=>cs.every(c=>c.role)); return cs; };
      const drive=(c)=>{ const r=c.st; if(!r||r.status!=="playing") return; const me=r.players[c.seat]; if(!me||!me.alive) return; const living=r.players.map((p,i)=>p.alive&&!p.left?i:-1).filter(i=>i>=0); if(r.phase==="night"){ if(c.role==="mafia"&&!(r.yourAct&&r.yourAct.kill!=null)){ const t=living.filter(i=>!(r.mafiaSeats||[]).includes(i)); if(t.length) c.emit("act",{kill:pick(t)}); } else if(c.role==="doctor"&&!(r.yourAct&&r.yourAct.save!=null)) c.emit("act",{save:pick(living)}); else if(c.role==="detective"&&!(r.yourAct&&r.yourAct.probe!=null)){ const t=living.filter(i=>i!==c.seat); if(t.length) c.emit("act",{probe:pick(t)}); } } else if(r.phase==="vote"&&!(r.votes&&r.votes[c.seat]!==undefined)){ const t=living.filter(i=>i!==c.seat); c.emit("vote",{target:t.length?pick(t):-1}); } };
      try {
        // 3a. the only pending voter is disconnected → the vote resolves within AFK_MS, not VOTE_MS
        { const cs=await room5(); const idle=cs[4]; const others=cs.slice(0,4); others.forEach(c=>c.on("state",()=>setTimeout(()=>drive(c),8)));
          idle.disconnect();
          if(!(await until(()=>others[0].st&&others[0].st.phase==="vote", 8000))) throw new Error("AFK: never reached a vote");
          const t0=Date.now(); const dayNo=others[0].st.day;
          if(!(await until(()=>others[0].st.phase!=="vote"||others[0].st.day!==dayNo||others[0].st.status==="over", VOTE+800))) throw new Error("AFK: vote with a disconnected voter did not resolve");
          const dt=Date.now()-t0; if(dt>=VOTE-200) throw new Error("AFK: vote waited the full clock ("+dt+" ms)");
          console.log("PASS AFK vote with a disconnected voter resolved in "+dt+" ms (AFK "+AFK+", clock "+VOTE+")"); others.forEach(c=>c.disconnect()); }
        // 3b. a connected player with a night role who never acts: 3 missed phases → botControlled; takeSeat hands it back
        { const cs=await room5(); const idle=cs.find(c=>c.role!=="villager")||cs[4]; const others=cs.filter(c=>c!==idle); const idleSeat=idle.seat;
          // drivers: mafia never targets the idle seat, everybody votes skip → the idle seat survives long enough to miss three phases
          const drive2=(c)=>{ const r=c.st; if(!r||r.status!=="playing") return; const me=r.players[c.seat]; if(!me||!me.alive) return; const living=r.players.map((p,i)=>p.alive&&!p.left?i:-1).filter(i=>i>=0); if(r.phase==="night"){ if(c.role==="mafia"&&!(r.yourAct&&r.yourAct.kill!=null)){ const t=living.filter(i=>!(r.mafiaSeats||[]).includes(i)&&i!==idleSeat); if(t.length) c.emit("act",{kill:pick(t)}); } else if(c.role==="doctor"&&!(r.yourAct&&r.yourAct.save!=null)) c.emit("act",{save:c.seat}); else if(c.role==="detective"&&!(r.yourAct&&r.yourAct.probe!=null)){ const t=living.filter(i=>i!==c.seat); if(t.length) c.emit("act",{probe:pick(t)}); } } else if(r.phase==="vote"&&!(r.votes&&r.votes[c.seat]!==undefined)) c.emit("vote",{target:-1}); };
          others.forEach(c=>c.on("state",()=>setTimeout(()=>drive2(c),8)));
          const flipped=await until(()=>idle.st&&idle.st.players[idleSeat]&&idle.st.players[idleSeat].botControlled, VOTE*10);
          if(!flipped) throw new Error("AFK: idle seat ("+idle.role+") never became botControlled (status "+(idle.st&&idle.st.status)+")");
          if(idle.st.players[idleSeat].bot||idle.st.players[idleSeat].name!==idle.nm2) throw new Error("AFK: seat identity changed");
          if(!(await until(()=>idle.logs.some(l=>new RegExp("playing for "+idle.nm2).test(l)),500))) throw new Error("AFK: no takeover log");
          idle.emit("takeSeat"); if(!(await until(()=>!idle.st.players[idleSeat].botControlled,1500))) throw new Error("AFK: takeSeat did not clear the flag");
          console.log("PASS AFK 3 missed phases ("+idle.role+") → bot-controlled seat, takeSeat hands it back");
          cs.forEach(c=>c.disconnect()); }
        // 3c. one human + 4 bots, the human disconnects at once: the game must still finish (its seat is auto-played, then bot-controlled)
        { const hid="hh"+Math.random(); const H=mk2("H"); await sleep(200); let code=null; H.on("joined",j=>{code=j.code;}); H.emit("create",{name:"H",playerId:hid,avatar:"🦊"}); await until(()=>code); for(let i=0;i<4;i++) H.emit("addBot"); await until(()=>H.st&&H.st.players.length===5); H.emit("start"); await until(()=>H.st&&H.st.status==="playing");
          H.disconnect();
          await sleep(4000);   // long enough for a whole game at these clocks
          const R=mk2("R"); await sleep(150); R.emit("join",{code,playerId:hid}); await until(()=>R.st,2000);
          if(!R.st||R.st.status!=="over") throw new Error("AFK: game with the only human gone did not finish (status "+(R.st&&R.st.status)+", phase "+(R.st&&R.st.phase)+")");
          console.log("PASS AFK game finished with the absent human's seat auto-played — winner "+R.st.winner); R.disconnect(); }
      } finally { srv.kill(); }
    }
    console.log("ALL MAFIA TESTS PASS");
    process.exit(0);
  }catch(e){ console.error("FAIL:", e.message); process.exit(1); }
})();
