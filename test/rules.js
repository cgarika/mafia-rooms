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

function t10Unit(){
  const { botDecide, botChatter, BOT_LINES } = require("../server.js");
  const mkRoom = (roles, extra) => ({ code:"T10", status:"playing", phase:"night", day:1, nightActs:{}, votes:{}, probeLog:{}, lastTally:{}, chat:[], deaths:[],
    players: roles.map((role,i)=>({ id:"p"+i, name:"P"+i, avatar:"x", bot:true, alive:true, left:false, role, chatN:0, accuseN:0, selfSaves:0, chatDay:-1 })), ...extra });
  // night target identical across mafia bots, never a mafia, and it is the most active / accusatory villager
  { const r = mkRoom(["mafia","mafia","mafia","villager","villager","doctor","detective","villager","villager","villager"]);
    r.players[4].chatN = 2; r.players[7].chatN = 1; r.players[7].accuseN = 2;   // seat 7 scores 1+4=5, seat 4 scores 2
    for (const i of [0,1,2]) botDecide(r, r.players[i]);
    const kills = [0,1,2].map(i=>r.nightActs[i].kill);
    if (new Set(kills).size!==1) throw new Error("T10: mafia bots disagree: "+kills);
    if (kills[0]!==7) throw new Error("T10: expected the most accusatory villager (7), got "+kills[0]);
    // a human mafia who already picked wins: bots agree with them
    const r2 = mkRoom(["mafia","mafia","villager","villager","villager","doctor","detective"]); r2.nightActs[0]={kill:3}; botDecide(r2, r2.players[1]); if (r2.nightActs[1].kill!==3) throw new Error("T10: bot did not follow the human mafia's pick");
    console.log("PASS T10 mafia bots agree on one night target (most active/accusatory villager, never mafia)"); }
  // doctor saves the most accused, may save itself once
  { const r = mkRoom(["mafia","villager","villager","villager","doctor","villager","detective"], { lastTally:{ 3:3, 5:1 } });
    botDecide(r, r.players[4]); if (r.nightActs[4].save!==3) throw new Error("T10: doctor should save the most accused (3), got "+r.nightActs[4].save);
    const r2 = mkRoom(["mafia","villager","villager","villager","doctor","villager","detective"], { lastTally:{ 4:3, 5:2 } });
    botDecide(r2, r2.players[4]); if (r2.nightActs[4].save!==4) throw new Error("T10: doctor may self-save once, got "+r2.nightActs[4].save);
    r2.nightActs={}; r2.day=2; botDecide(r2, r2.players[4]); if (r2.nightActs[4].save!==5) throw new Error("T10: second self-save should be refused → next most accused (5), got "+r2.nightActs[4].save);
    console.log("PASS T10 doctor saves the most accused, self only once"); }
  // detective votes a confirmed mafia, otherwise follows the crowd; probes unprobed players
  { const r = mkRoom(["mafia","mafia","villager","villager","doctor","villager","detective"], { phase:"vote", probeLog:{ 6:[{t:1,mafia:true},{t:2,mafia:false}] } });
    botDecide(r, r.players[6]); if (r.votes[6]!==1) throw new Error("T10: detective should vote the known mafia (1), got "+r.votes[6]);
    const r2 = mkRoom(["mafia","mafia","villager","villager","doctor","villager","detective"], { phase:"vote", votes:{ 2:5, 3:5, 4:0 }, probeLog:{ 6:[{t:2,mafia:false}] } });
    botDecide(r2, r2.players[6]); if (r2.votes[6]!==5) throw new Error("T10: detective should follow the crowd (5), got "+r2.votes[6]);
    const r3 = mkRoom(["mafia","mafia","villager","villager","doctor","villager","detective"], { probeLog:{ 6:[{t:0,mafia:true},{t:2,mafia:false},{t:3,mafia:false},{t:4,mafia:false}] } });
    botDecide(r3, r3.players[6]); if (![1,5].includes(r3.nightActs[6].probe)) throw new Error("T10: detective should probe someone new, got "+r3.nightActs[6].probe);
    console.log("PASS T10 detective votes known mafia, follows the crowd otherwise, probes new players"); }
  // villagers follow the plurality with rising probability (day 1 ≈ 0.3, day 4+ ≈ 0.9)
  { const rate = (day) => { let n=0; for (let k=0;k<400;k++){ const r = mkRoom(["mafia","mafia","villager","villager","doctor","villager","detective","villager","villager"], { phase:"vote", day, votes:{ 2:7, 3:7, 4:5 } }); botDecide(r, r.players[8]); if (r.votes[8]===7) n++; } return n/400; };
    const d1 = rate(1), d4 = rate(4);
    if (!(d1 > 0.2 && d1 < 0.55)) throw new Error("T10: day-1 follow rate off: "+d1);
    if (!(d4 > 0.8 && d4 <= 1)) throw new Error("T10: day-4 follow rate off: "+d4);
    console.log("PASS T10 villager bots follow the crowd more each day (day1 "+d1.toFixed(2)+", day4 "+d4.toFixed(2)+")"); }
  // mafia bots sometimes vote a mate in the first two days, never after
  { let early=0, late=0; for (let k=0;k<300;k++){ const r = mkRoom(["mafia","mafia","villager","villager","doctor","villager","detective"], { phase:"vote", day:1 }); botDecide(r, r.players[0]); if (r.votes[0]===1) early++; const r2 = mkRoom(["mafia","mafia","villager","villager","doctor","villager","detective"], { phase:"vote", day:3 }); botDecide(r2, r2.players[0]); if (r2.votes[0]===1) late++; }
    if (early < 30) throw new Error("T10: mafia never voted a mate on day 1 ("+early+"/300)"); if (late !== 0) throw new Error("T10: mafia voted a mate on day 3");
    console.log("PASS T10 mafia bots occasionally vote a fellow mafia early ("+early+"/300), never later"); }
  // canned chat: one line per bot per day in the day channel
  { const r = mkRoom(["mafia","villager","villager","doctor","detective"], { phase:"day" }); for (let k=0;k<40;k++) botChatter(r);
    const by = {}; for (const m of r.chat) { by[m.s]=(by[m.s]||0)+1; if (m.ch!=="day") throw new Error("T10: bot chat must be in the day channel"); }
    if (Object.keys(by).length!==5 || Object.values(by).some(n=>n!==1)) throw new Error("T10: expected exactly one line per bot, got "+JSON.stringify(by));
    for (const role of ["villager","mafia","doctor","detective"]) if (!(BOT_LINES[role].length>=8 && BOT_LINES[role].length<=10)) throw new Error("T10: "+role+" needs 8–10 lines");
    console.log("PASS T10 bots say one canned line per day, 8–10 lines per role"); }
}

function t16Unit(){
  const { rolesFor, mafiaCountFor, resolveVote, dealRoles, label } = require("../server.js");
  const count=(arr,r)=>arr.filter(x=>x===r).length;
  for (const [n,m] of [[5,1],[6,1],[7,1],[8,2],[9,2],[10,2],[11,3],[12,3]]) {
    if (mafiaCountFor(n)!==m) throw new Error("T16: "+n+" players should have "+m+" mafia");
    const r = rolesFor(n, {}); if (r.length!==n||count(r,"mafia")!==m||count(r,"detective")!==1||count(r,"doctor")!==1||count(r,"jester")||count(r,"mayor")) throw new Error("T16: base roles wrong at "+n+": "+r);
    const r2 = rolesFor(n, {jester:true, mayor:true}); if (r2.length!==n||count(r2,"jester")!==1||count(r2,"mayor")!==1||count(r2,"mafia")!==m) throw new Error("T16: optional roles wrong at "+n+": "+r2);
  }
  { const room = { players: Array.from({length:8},(_,i)=>({name:"P"+i})), roles:{jester:true} }; dealRoles(room); const rs=room.players.map(p=>p.role); if (count(rs,"jester")!==1||count(rs,"mafia")!==2||count(rs,"mayor")) throw new Error("T16: dealRoles ignored the room's optional roles: "+rs); }
  console.log("PASS T16 role counts scale with table size (1 / 2 / 3 Shadows at 5–7 / 8–10 / 11–12), Jester and Mayor dealt when enabled");
  const mkRoom=(roles)=>({ code:"T16", status:"playing", phase:"vote", day:1, votes:{}, deaths:[], nightActs:{}, probeLog:{}, chat:[], lastTally:{}, players: roles.map((role,i)=>({ id:"p"+i, name:"P"+i, avatar:"x", alive:true, left:false, role })) });
  // Jester voted out → Jester wins alone
  { const r = mkRoom(["mafia","villager","villager","jester","doctor","detective"]); r.votes={0:3,1:3,2:3,4:3,5:3,3:-1}; resolveVote(r);
    if (r.winner!=="jester"||r.status!=="over"||r.players[3].alive) throw new Error("T16: jester vote-out should end the game with a jester win ("+r.winner+"/"+r.status+")");
    if (!/Jester wins/.test(r.log)) throw new Error("T16: jester log missing"); }
  // Jester killed at night is just a death (no jester win)
  { const r = mkRoom(["mafia","villager","villager","jester","doctor","detective"]); r.votes={0:1,1:-1,2:-1,3:-1,4:-1,5:-1}; resolveVote(r); if (r.winner==="jester") throw new Error("T16: jester must not win without being voted out"); }
  // Mayor's vote counts double: 5 alive, majority needs 3 — mayor + one villager on X eliminates; two villagers alone do not
  { const r = mkRoom(["mafia","mayor","villager","villager","doctor"]); r.votes={1:0,2:0,3:-1,4:-1,0:-1}; resolveVote(r); if (r.players[0].alive) throw new Error("T16: mayor + 1 vote (weight 3 of 5) should eliminate"); }
  { const r = mkRoom(["mafia","villager","villager","villager","doctor"]); r.votes={1:0,2:0,3:-1,4:-1,0:-1}; resolveVote(r); if (!r.players[0].alive) throw new Error("T16: two plain votes of five must not eliminate"); }
  // reveal-on-death text keeps the role name
  { const r = mkRoom(["mafia","mayor","villager","villager","doctor","villager"]); r.votes={0:1,2:1,3:1,4:1,5:1,1:-1}; resolveVote(r); if (r.players[1].alive || !r.deaths.includes(1)) throw new Error("T16: mayor should be voted out and revealed"); if (label("mayor")!=="the Mayor" || label("jester")!=="the Jester") throw new Error("T16: reveal labels missing"); }
  console.log("PASS T16 Jester wins when voted out (not when killed), Mayor's vote counts double, reveal text names the role");
}

(async()=>{
  try{
    t10Unit();
    t16Unit();
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
    if (mafiaCount!==1) throw new Error("7 players should deal 1 mafia (T16), got "+mafiaCount);
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
    // ---- Test 4 (T2 vote threshold): 5, 8 and 12 humans under each rule, 2 votes on one player, the rest skip ----
    {
      const { spawn } = require("child_process");
      const P=3222, URL2="http://localhost:"+P;
      const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT:String(P), REVEAL_MS:"40", NIGHT_MS:"4000", DAY_MS:"60", VOTE_MS:"4000", AFK_MS:"4000", BOT_MS:"5" }, stdio:"ignore" });
      await sleep(600);
      const mk2=(name)=>{ const c=io(URL2,{transports:["websocket"],reconnection:false}); c.st=null; c.seat=-1; c.role=null; c.on("state",({room,mySeat})=>{ c.st=room; c.seat=mySeat; if(room.yourRole) c.role=room.yourRole; }); return c; };
      const wait=async(fn,ms=8000)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ if(fn()) return true; await sleep(15);} return false; };
      const scenario=async(n, rule, votesFor)=>{
        const cs=[]; for(let i=0;i<n;i++) cs.push(mk2("V"+i)); await sleep(250); let code=null; cs[0].on("joined",j=>{code=j.code;});
        cs[0].emit("create",{name:"V0",playerId:"v0"+Math.random(),avatar:"🦊"}); await wait(()=>code); for(let i=1;i<n;i++) cs[i].emit("join",{code,name:"V"+i,playerId:"v"+i+Math.random(),avatar:"🐼"}); await wait(()=>cs[0].st&&cs[0].st.players.length===n);
        cs[0].emit("settings",{voteRule:rule}); await wait(()=>cs[0].st.voteRule===rule);
        cs[0].emit("start"); await wait(()=>cs.every(c=>c.role));
        // night: every role acts on a fixed target so nobody dies of randomness (doctor saves the mafia's target)
        await wait(()=>cs[0].st.phase==="night");
        const living=()=>cs[0].st.players.map((p,i)=>p.alive?i:-1).filter(i=>i>=0);
        const target=cs.find(c=>c.role==="villager").seat;
        for(const c of cs){ if(c.role==="mafia") c.emit("act",{kill:target}); else if(c.role==="doctor") c.emit("act",{save:target}); else if(c.role==="detective") c.emit("act",{probe:target}); }
        if(!(await wait(()=>cs[0].st.phase==="vote", 9000))) throw new Error(`T2 ${n}p ${rule}: never reached the vote (phase ${cs[0].st.phase})`);
        const aliveBefore=living().length;
        const victim=living().find(i=>i!==cs[0].seat && i!==cs[1].seat);
        // two votes on the victim, everyone else skips
        cs.forEach((c)=>{ if(!cs[0].st.players[c.seat].alive) return; c.emit("vote", (c===cs[0]||c===cs[1]) && votesFor===2 ? {target:victim} : (votesFor==="all" && c.seat!==victim ? {target:victim} : {target:-1})); });
        await wait(()=>cs[0].st.phase!=="vote"||cs[0].st.status==="over", 9000);
        const out=aliveBefore-living().length; cs.forEach(c=>c.disconnect()); return { out, log: cs[0].st.log };
      };
      try {
        for (const n of [5,8,12]) {
          const maj=await scenario(n,"majority",2); if(maj.out!==0) throw new Error(`T2 ${n}p majority: 2 votes eliminated someone (${maj.log})`);
          const plu=await scenario(n,"plurality",2); if(plu.out!==1) throw new Error(`T2 ${n}p plurality: 2 votes did not eliminate (${plu.log})`);
          const all=await scenario(n,"majority","all"); if(all.out!==1) throw new Error(`T2 ${n}p majority: a real majority did not eliminate (${all.log})`);
          console.log(`PASS T2 ${n} players — majority: 2 votes spare, ${n-1} votes eliminate; plurality: 2 votes eliminate`);
        }
        // ties never eliminate (plurality): 8 players, 2 votes each on two different players
        { const n=8; const cs=[]; for(let i=0;i<n;i++) cs.push(mk2("T"+i)); await sleep(250); let code=null; cs[0].on("joined",j=>{code=j.code;}); cs[0].emit("create",{name:"T0",playerId:"t0"+Math.random(),avatar:"🦊"}); await wait(()=>code); for(let i=1;i<n;i++) cs[i].emit("join",{code,name:"T"+i,playerId:"t"+i+Math.random(),avatar:"🐼"}); await wait(()=>cs[0].st&&cs[0].st.players.length===n); cs[0].emit("settings",{voteRule:"plurality"}); await wait(()=>cs[0].st.voteRule==="plurality"); cs[0].emit("start"); await wait(()=>cs.every(c=>c.role)); await wait(()=>cs[0].st.phase==="night"); const target=cs.find(c=>c.role==="villager").seat; for(const c of cs){ if(c.role==="mafia") c.emit("act",{kill:target}); else if(c.role==="doctor") c.emit("act",{save:target}); else if(c.role==="detective") c.emit("act",{probe:target}); } await wait(()=>cs[0].st.phase==="vote", 9000);
          const liv=cs[0].st.players.map((p,i)=>p.alive?i:-1).filter(i=>i>=0); const a=liv[0], b=liv[1]; const before=liv.length;
          cs.forEach((c,k)=>{ if(!cs[0].st.players[c.seat].alive) return; if(c.seat===a||c.seat===b){ c.emit("vote",{target:-1}); return; } c.emit("vote",{target: k%2===0 ? a : b}); });
          await wait(()=>cs[0].st.phase!=="vote"||cs[0].st.status==="over", 9000);
          const after=cs[0].st.players.filter(p=>p.alive).length; if(after!==before) throw new Error("T2 tie eliminated someone: "+cs[0].st.log);
          console.log("PASS T2 tie under plurality spares everyone"); cs.forEach(c=>c.disconnect()); }
      } finally { srv.kill(); }
    }

    // ---- T3 host handover: host disconnects during play → another human becomes host ----
    {
      const { spawn } = require("child_process");
      const P=3231, URL2="http://localhost:"+P;
      const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT:String(P), REVEAL_MS:"40", NIGHT_MS:"4000", DAY_MS:"4000", VOTE_MS:"4000", AFK_MS:"4000", BOT_MS:"5" }, stdio:"ignore" });
      await sleep(600);
      const mk2=(name)=>{ const c=io(URL2,{transports:["websocket"],reconnection:false}); c.st=null; c.seat=-1; c.logs=[]; c.on("state",({room,mySeat})=>{ c.st=room; c.seat=mySeat; if(room&&room.log) c.logs.push(room.log); }); return c; };
      const wait=async(fn,ms=6000)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ if(fn()) return true; await sleep(15);} return false; };
      try {
        const n=5; const cs=[]; for(let i=0;i<n;i++) cs.push(mk2("H"+i)); await sleep(250); let code=null; cs[0].on("joined",j=>{code=j.code;});
        cs[0].emit("create",{name:"H0",playerId:"h0"+Math.random(),avatar:"🦊"}); await wait(()=>code); for(let i=1;i<n;i++) cs[i].emit("join",{code,name:"H"+i,playerId:"h"+i+Math.random(),avatar:"🐼"}); await wait(()=>cs[0].st&&cs[0].st.players.length===n);
        
        cs[0].emit("start"); if(!(await wait(()=>cs[1].st&&cs[1].st.status==="playing"))) throw new Error("T3: game did not start");
        if(cs[1].st.hostSeat!==cs[0].seat) throw new Error("T3: creator is not the host at start");
        cs[0].disconnect();
        if(!(await wait(()=>cs[1].st.hostSeat===cs[1].seat, 3000))) throw new Error("T3: host did not move to the connected human (hostSeat "+cs[1].st.hostSeat+")");
        if(!cs[1].logs.some(l=>/is now the host/.test(l))) throw new Error("T3: no host log line");
        console.log("PASS T3 host handover — host disconnected mid-game, next connected human is host");
        
        cs.forEach(c=>c.disconnect());
      } finally { srv.kill(); }
    }
    console.log("ALL MAFIA TESTS PASS");
    process.exit(0);
  }catch(e){ console.error("FAIL:", e.message); process.exit(1); }
})();
