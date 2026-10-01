(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const STORAGE = 'memoryLabStateV2';
  const SETTINGS = 'memoryLabSettingsV2';
  const OLD_STORAGE = 'memoryLabStateV1';
  const OLD_SETTINGS = 'memoryLabSettingsV1';
  const ALL_MODE_IDS = GAME_MODES.map(m => m.id);

  const defaultStats = {
    xp:0,sessions:0,rounds:0,correct:0,total:0,perfectRounds:0,
    streak:0,bestStreak:0,lastSession:null,days:{},modePlays:{},bestByMode:{},
    scoreSumByMode:{},scoreCountByMode:{},history:[],daily:{},missionRewards:{},
    maxCombo:0,planPlays:{},activeSeconds:0
  };
  const defaultSettings = {
    profileName:'Игрок',dailyRounds:9,dailyMinutes:6,baseDifficulty:1,adaptive:true,pace:1,countdown:3,
    pressure:false,pressureSeconds:20,review:true,enabledModes:[...ALL_MODE_IDS],theme:'violet',
    animations:true,sound:true,vibration:true,wake:true
  };

  const clamp = (n,a,b) => Math.max(a,Math.min(b,n));
  const shuffle = arr => { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };
  const sample = (arr,n=1) => shuffle(arr).slice(0,n);
  const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
  const deepClone = obj => JSON.parse(JSON.stringify(obj));

  function readJSON(key){try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null}}
  function mergeStats(raw){
    raw=raw||{};
    return {...deepClone(defaultStats),...raw,
      days:{...(raw.days||{})},modePlays:{...(raw.modePlays||{})},bestByMode:{...(raw.bestByMode||{})},
      scoreSumByMode:{...(raw.scoreSumByMode||{})},scoreCountByMode:{...(raw.scoreCountByMode||{})},
      daily:{...(raw.daily||{})},missionRewards:{...(raw.missionRewards||{})},planPlays:{...(raw.planPlays||{})},
      history:Array.isArray(raw.history)?raw.history.slice(0,40):[]
    };
  }
  function mergeSettings(raw){
    raw=raw||{};
    const s={...deepClone(defaultSettings),...raw};
    s.enabledModes=Array.isArray(raw.enabledModes)&&raw.enabledModes.length?raw.enabledModes.filter(id=>ALL_MODE_IDS.includes(id)):[...ALL_MODE_IDS];
    if(s.enabledModes.length<4)s.enabledModes=[...ALL_MODE_IDS];
    s.dailyRounds=clamp(+s.dailyRounds||9,9,16);
    s.dailyMinutes=clamp(+s.dailyMinutes||6,5,20);
    return s;
  }
  let rawStats=readJSON(STORAGE), rawSettings=readJSON(SETTINGS);
  if(!rawStats){rawStats=readJSON(OLD_STORAGE);}
  if(!rawSettings){rawSettings=readJSON(OLD_SETTINGS);}
  let stats=mergeStats(rawStats), settings=mergeSettings(rawSettings);

  let session=null, lastSessionSpec=null, deferredInstall=null, wakeLock=null, audioCtx=null;
  let cleanupFns=[], pressureTimer=null, pressureInterval=null, roundResolved=false, sessionClockInterval=null;

  const views={home:$('homeView'),game:$('gameView'),summary:$('summaryView'),analytics:$('analyticsView')};

  const PLANS = [
    {id:'daily',icon:'◉',name:'Daily Protocol',desc:'Полная дневная сессия: рабочая, словесная, визуальная и пространственная память.',meta:'≥ 5 мин'},
    {id:'sprint',icon:'⚡',name:'Sprint',desc:'Три быстрых раунда с коротким показом и таймером ответа.',meta:'≈ 3 мин'},
    {id:'marathon',icon:'∞',name:'Marathon',desc:'Десять раундов подряд. Проверка стабильности, а не одной удачи.',meta:'10 раундов'},
    {id:'precision',icon:'◎',name:'Precision',desc:'Спокойнее темп, но цель — высокая точность и длинное комбо.',meta:'цель 90%+'},
    {id:'weak',icon:'↗',name:'Weak Spot',desc:'Приложение автоматически выбирает режимы с худшей средней точностью.',meta:'по статистике'}
  ];

  const ACHIEVEMENTS_V2 = [
    {id:'first',icon:'✦',name:'Первый импульс',desc:'Завершить первую сессию',test:s=>s.sessions>=1},
    {id:'ten',icon:'10',name:'Разогрев',desc:'Сыграть 10 раундов',test:s=>s.rounds>=10},
    {id:'perfect',icon:'100',name:'Чистый след',desc:'Получить 100% в раунде',test:s=>s.perfectRounds>=1},
    {id:'streak3',icon:'🔥',name:'Ритм',desc:'Три дня подряд',test:s=>s.bestStreak>=3},
    {id:'level5',icon:'Ⅴ',name:'Нейронавигатор',desc:'Достичь 5 уровня',test:s=>levelFromXp(s.xp).level>=5},
    {id:'allmodes',icon:'8',name:'Полный спектр',desc:'Попробовать все 8 режимов',test:s=>Object.keys(s.modePlays||{}).filter(k=>s.modePlays[k]>0).length>=8},
    {id:'combo4',icon:'×4',name:'На волне',desc:'Собрать комбо из 4 сильных раундов',test:s=>s.maxCombo>=4},
    {id:'hundred',icon:'◆',name:'Сотня',desc:'Сыграть 100 раундов',test:s=>s.rounds>=100},
    {id:'streak7',icon:'7D',name:'Неделя памяти',desc:'Семь дней подряд',test:s=>s.bestStreak>=7},
    {id:'xp5k',icon:'5K',name:'Архивариус',desc:'Набрать 5000 XP',test:s=>s.xp>=5000},
    {id:'marathon',icon:'∞',name:'Дистанция',desc:'Завершить Marathon',test:s=>(s.planPlays?.marathon||0)>=1},
    {id:'accuracy',icon:'◎',name:'Стабильность',desc:'85%+ общей точности после 50 раундов',test:s=>s.rounds>=50&&s.total&&s.correct/s.total>=.85}
  ];

  function save(){
    localStorage.setItem(STORAGE,JSON.stringify(stats));
    localStorage.setItem(SETTINGS,JSON.stringify(settings));
  }
  function showView(name){Object.values(views).forEach(v=>v.classList.remove('active'));views[name].classList.add('active');window.scrollTo({top:0,behavior:settings.animations?'smooth':'auto'});}
  function toast(msg){const t=$('toast');t.textContent=msg;t.classList.remove('hidden');clearTimeout(t._timer);t._timer=setTimeout(()=>t.classList.add('hidden'),2300);}
  function registerCleanup(fn){cleanupFns.push(fn);}
  function cleanupActive(){cleanupFns.splice(0).forEach(fn=>{try{fn()}catch{}});stopPressure();}
  function dateKey(d=new Date()){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
  function dayWord(n){const x=Math.abs(n)%100,y=x%10;return x>10&&x<20?'дней':y===1?'день':y>=2&&y<=4?'дня':'дней';}
  function roundWord(n){const x=Math.abs(n)%100,y=x%10;return x>10&&x<20?'раундов':y===1?'раунд':y>=2&&y<=4?'раунда':'раундов';}
  function currentDaily(){const k=dateKey();if(!stats.daily[k])stats.daily[k]={rounds:0,sessions:0,high:0,modes:{},bestAvg:0,seconds:0};if(stats.daily[k].seconds==null)stats.daily[k].seconds=0;return stats.daily[k];}
  function beep(type='ok'){
    if(!settings.sound)return;
    try{audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.connect(g);g.connect(audioCtx.destination);o.frequency.value=type==='bad'?180:type==='tick'?520:type==='bonus'?900:720;g.gain.setValueAtTime(.035,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+.16);o.start();o.stop(audioCtx.currentTime+.17);}catch{}
  }
  function vibrate(ms=30){if(settings.vibration&&navigator.vibrate)navigator.vibrate(ms);}
  async function holdWake(){if(!settings.wake||!('wakeLock'in navigator))return;try{wakeLock=await navigator.wakeLock.request('screen');}catch{}}
  async function releaseWake(){try{await wakeLock?.release();}catch{}wakeLock=null;}
  function applyTheme(){document.body.dataset.theme=settings.theme||'violet';document.body.classList.toggle('no-motion',!settings.animations);$('soundBtn').textContent=settings.sound?'♪':'∅';}

  function enabledModes(){const pool=settings.enabledModes.filter(id=>ALL_MODE_IDS.includes(id));return pool.length?pool:[...ALL_MODE_IDS];}
  function modeAverage(id){const c=stats.scoreCountByMode[id]||0;return c?(stats.scoreSumByMode[id]||0)/c:null;}
  function modeMastery(id){const a=modeAverage(id),plays=stats.scoreCountByMode[id]||0;if(a===null)return 0;let lv=a>=92?5:a>=82?4:a>=70?3:a>=55?2:1;if(plays<3)lv=Math.min(lv,2);else if(plays<6)lv=Math.min(lv,3);return lv;}
  function weakestModes(n=2){
    const pool=enabledModes();
    return [...pool].sort((a,b)=>{
      const aa=modeAverage(a),bb=modeAverage(b);
      if(aa===null&&bb===null)return 0;if(aa===null)return -1;if(bb===null)return 1;return aa-bb;
    }).slice(0,Math.min(n,pool.length));
  }
  function strongestMode(){const played=ALL_MODE_IDS.filter(id=>modeAverage(id)!==null);return played.sort((a,b)=>modeAverage(b)-modeAverage(a))[0]||null;}
  function buildModes(rounds,pool){
    pool=pool.length?pool:[...ALL_MODE_IDS];const out=[];let bag=[];
    while(out.length<rounds){if(!bag.length)bag=shuffle(pool);const next=bag.shift();if(out.length&&out[out.length-1]===next&&bag.length)out.push(bag.shift());else out.push(next);}
    return out.slice(0,rounds);
  }

  function renderPlans(){
    const grid=$('planGrid');grid.innerHTML='';
    PLANS.forEach(p=>{const b=document.createElement('button');b.className='plan-card';b.innerHTML=`<div class="plan-icon">${p.icon}</div><h3>${p.name}</h3><p>${p.desc}</p><div class="plan-foot"><span>${p.meta}</span><span>→</span></div>`;b.addEventListener('click',()=>startPlan(p.id));grid.appendChild(b);});
  }
  function renderModes(){
    const grid=$('modeGrid');grid.innerHTML='';
    GAME_MODES.forEach(m=>{const a=modeAverage(m.id),mastery=modeMastery(m.id),plays=stats.scoreCountByMode[m.id]||0;const b=document.createElement('button');b.className='mode-card';b.style.setProperty('--card-accent',m.accent);b.innerHTML=`<div class="mode-icon">${m.icon}</div><h3>${m.name}</h3><p>${m.desc}</p><div class="mode-meta"><span class="mode-badge">${m.badge}</span><span>${a===null?'не сыграно':`${Math.round(a)}% · ${plays}`}</span></div><div class="mastery-dots" aria-label="мастерство ${mastery} из 5">${'●'.repeat(mastery)}${'○'.repeat(5-mastery)}</div>`;b.addEventListener('click',()=>startSession({name:m.name,id:'single',modes:[m.id],paceMod:1,difficultyBoost:0,pressureOverride:null}));grid.appendChild(b);});
  }
  function renderWeek(){
    const el=$('weekStrip');el.innerHTML='';const names=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];const now=new Date();
    for(let i=6;i>=0;i--){const d=new Date(now);d.setDate(now.getDate()-i);const idx=(d.getDay()+6)%7,div=document.createElement('div');div.className='day-dot'+(stats.days[dateKey(d)]?' done':'');div.innerHTML=`<span>${names[idx]}</span><i></i>`;el.appendChild(div);}
  }
  function renderAchievements(){
    const unlocked=ACHIEVEMENTS_V2.filter(a=>a.test(stats));$('achievementCount').textContent=`${unlocked.length} / ${ACHIEVEMENTS_V2.length}`;const el=$('achievementList');el.innerHTML='';
    ACHIEVEMENTS_V2.slice(0,8).forEach(a=>{const yes=a.test(stats),d=document.createElement('div');d.className='achievement'+(yes?' unlocked':'');d.innerHTML=`<div class="achievement-icon">${a.icon}</div><div><b>${a.name}</b><small>${a.desc}</small></div>`;el.appendChild(d);});
  }
  function missionDefs(){
    return [
      {id:'time',name:'Пять минут фокуса',desc:'Набери 5 минут активной тренировки сегодня',target:300,value:d=>d.seconds||0,reward:40,format:v=>`${Math.floor(v/60)}:${String(Math.floor(v%60)).padStart(2,'0')}`},
      {id:'modes',name:'Разнообразие',desc:'Попробуй 3 разных режима',target:3,value:d=>Object.keys(d.modes||{}).length,reward:35},
      {id:'high',name:'Точный день',desc:'Сделай 2 раунда на 90%+',target:2,value:d=>d.high,reward:40}
    ];
  }
  function applyMissionRewards(){
    const d=currentDaily(),k=dateKey();if(!stats.missionRewards[k])stats.missionRewards[k]={};let gained=0;
    missionDefs().forEach(m=>{if(m.value(d)>=m.target&&!stats.missionRewards[k][m.id]){stats.missionRewards[k][m.id]=true;stats.xp+=m.reward;gained+=m.reward;}});
    if(gained){beep('bonus');toast(`Daily Missions: +${gained} бонус XP`);}save();
  }
  function renderMissions(){
    const d=currentDaily(),el=$('missionGrid');el.innerHTML='';let bonus=0;
    missionDefs().forEach(m=>{const v=m.value(d),done=v>=m.target,rewarded=stats.missionRewards[dateKey()]?.[m.id];if(rewarded)bonus+=m.reward;const card=document.createElement('div');card.className='mission'+(done?' done':'');const shown=m.format?m.format(Math.min(v,m.target)):Math.min(v,m.target);const targetShown=m.format?m.format(m.target):m.target;card.innerHTML=`<div class="mission-top"><div><strong>${done?'✓ ':''}${m.name}</strong><small>${m.desc}</small></div><span class="mission-reward">+${m.reward} XP</span></div><div class="mission-progress"><i style="width:${Math.min(100,v/m.target*100)}%"></i></div><small>${shown} / ${targetShown}${rewarded?' · получено':''}</small>`;el.appendChild(card);});
    $('missionBonus').textContent=`+${bonus} бонус XP`;
  }
  function insightText(){
    const played=ALL_MODE_IDS.filter(id=>modeAverage(id)!==null);if(!played.length)return 'Сыграй несколько раундов — приложение найдёт тип памяти, который стоит потренировать чаще.';
    const weak=weakestModes(1)[0],strong=strongestMode(),wm=GAME_MODES.find(m=>m.id===weak),sm=GAME_MODES.find(m=>m.id===strong);return `Сейчас слабее всего выглядит ${wm.name}: средняя точность ${Math.round(modeAverage(weak))}%. Сильнее всего — ${sm.name} (${Math.round(modeAverage(strong))}%). Weak Spot соберёт тренировку вокруг слабых режимов.`;
  }
  function renderHome(){
    applyTheme();const lv=levelFromXp(stats.xp),d=currentDaily();
    $('heroDescription').textContent=`Daily Protocol — минимум ${settings.dailyMinutes} мин активной практики: рабочая, словесная, визуальная и пространственная память в одной сессии.`;$('dailyBtn').textContent=`Начать Daily · ${settings.dailyMinutes}+ мин`;
    $('profileName').textContent=settings.profileName||'Игрок';$('levelNumber').textContent=lv.level;$('levelName').textContent=lv.name;$('rankHero').textContent=lv.name;$('xpText').textContent=`${lv.current} / ${lv.need} XP`;$('xpFill').style.width=`${lv.current/lv.need*100}%`;$('totalXp').textContent=stats.xp.toLocaleString('ru-RU');
    $('streakHero').textContent=`${stats.streak} ${dayWord(stats.streak)}`;$('todayRounds').textContent=`${fmtClock(d.seconds||0)} / ${settings.dailyMinutes}:00`;$('todayStatus').textContent=d.seconds>=settings.dailyMinutes*60?'дневная норма выполнена':(d.sessions?'можно усилить результат':'готов к тренировке');
    $('sessionsStat').textContent=stats.sessions;$('roundsStat').textContent=stats.rounds;$('accuracyStat').textContent=stats.total?`${Math.round(stats.correct/stats.total*100)}%`:'—';$('bestStreakStat').textContent=stats.bestStreak;
    $('memoryTip').textContent=MEMORY_TIPS[(new Date().getDate()+stats.sessions)%MEMORY_TIPS.length];$('insightText').textContent=insightText();
    renderPlans();renderMissions();renderModes();renderWeek();renderAchievements();
  }

  function dailyProtocol(pool,rounds){
    const blocks=[
      {label:'РАЗОГРЕВ',ids:['digits','missing']},
      {label:'КОДИРОВАНИЕ',ids:['words','grid']},
      {label:'РАБОЧАЯ ПАМЯТЬ',ids:['reverse','sequence']},
      {label:'ПРОСТРАНСТВО',ids:['trail','pairs']}
    ];
    const modes=[],phases=[];
    blocks.forEach(block=>{
      const available=block.ids.filter(id=>pool.includes(id));
      if(available.length){modes.push(available[0]);phases.push(block.label);}
      if(available.length>1&&modes.length<rounds){modes.push(available[1]);phases.push(block.label);}
    });
    const weak=weakestModes(2).filter(id=>pool.includes(id));
    while(modes.length<rounds){
      const candidates=[...weak,...shuffle(pool)].filter(id=>id!==modes[modes.length-1]);
      const next=candidates[0]||pool[0];
      modes.push(next);phases.push(modes.length===rounds?'СЛАБОЕ МЕСТО':'СМЕШАННЫЙ БЛОК');
    }
    return {modes:modes.slice(0,rounds),phases:phases.slice(0,rounds)};
  }
  function fmtClock(sec){sec=Math.max(0,Math.floor(sec));return `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;}
  function stopSessionClock(){if(sessionClockInterval)clearInterval(sessionClockInterval);sessionClockInterval=null;}
  function updateSessionClock(){
    if(!session)return;
    const now=Date.now();
    if(session.lastTick==null)session.lastTick=now;
    if(document.visibilityState==='visible')session.activeMs+=Math.max(0,now-session.lastTick);
    session.lastTick=now;
    const elapsed=Math.floor(session.activeMs/1000),min=session.minDurationSec||0;
    const chip=$('sessionClockChip');if(!chip)return;
    if(min&&elapsed<min){chip.textContent=`ещё ${fmtClock(min-elapsed)}`;chip.classList.add('training');}
    else{chip.textContent=`${fmtClock(elapsed)}`;chip.classList.remove('training');}
  }
  function startSessionClock(){stopSessionClock();updateSessionClock();sessionClockInterval=setInterval(updateSessionClock,250);}
  function appendDailyRound(){
    const pool=enabledModes(),weak=weakestModes(2).filter(id=>pool.includes(id)),last=session.modes[session.modes.length-1];
    const candidates=[...weak,...shuffle(pool)].filter(id=>id!==last);
    const next=candidates[0]||pool[0];
    session.modes.push(next);session.phases.push('АДАПТИВНЫЙ ФИНИШ');session.addedRounds=(session.addedRounds||0)+1;
  }
  function planSpec(id){
    const pool=enabledModes();
    if(id==='daily'){const p=dailyProtocol(pool,clamp(settings.dailyRounds,9,16));return {id:'daily',name:'Daily Protocol',modes:p.modes,phases:p.phases,minDurationSec:clamp(settings.dailyMinutes,5,20)*60,paceMod:1,difficultyBoost:0,pressureOverride:null};}
    if(id==='sprint')return {id:'sprint',name:'Sprint',modes:buildModes(3,pool),paceMod:.72,difficultyBoost:1,pressureOverride:{on:true,seconds:12,countdown:1}};
    if(id==='marathon')return {id:'marathon',name:'Marathon',modes:buildModes(10,pool),paceMod:1,difficultyBoost:0,pressureOverride:null};
    if(id==='precision')return {id:'precision',name:'Precision',modes:buildModes(5,pool),paceMod:1.18,difficultyBoost:0,pressureOverride:{on:false}};
    if(id==='weak'){const w=weakestModes(2);return {id:'weak',name:'Weak Spot',modes:buildModes(6,w),paceMod:1,difficultyBoost:0,pressureOverride:null};}
    return planSpec('daily');
  }
  function startPlan(id){startSession(planSpec(id));}
  function startSession(spec){
    cleanupActive();const modes=spec.modes?.length?spec.modes:[sample(enabledModes(),1)[0]];const startDiff=clamp(settings.baseDifficulty+(spec.difficultyBoost||0),1,6);
    session={spec:{...spec,modes:[...modes],phases:[...(spec.phases||[])]},modes:[...modes],phases:[...(spec.phases||[])],index:0,xp:0,results:[],difficulty:startDiff,combo:0,maxCombo:0,paceMod:spec.paceMod||1,minDurationSec:spec.minDurationSec||0,activeMs:0,lastTick:Date.now(),addedRounds:0};
    lastSessionSpec={...spec,modes:[...modes],phases:[...(spec.phases||[])]};showView('game');holdWake();startSessionClock();nextRound();
  }
  function nextRound(){
    cleanupActive();roundResolved=false;$('feedbackBox').className='feedback hidden';$('gameActions').innerHTML='';$('pressureBox').classList.add('hidden');
    if(session.index>=session.modes.length){
      updateSessionClock();
      if(session.spec.id==='daily'&&session.activeMs<session.minDurationSec*1000){appendDailyRound();}
      else{finishSession();return;}
    }
    const mode=session.modes[session.index];renderGameHeader(mode);runGame(mode,session.difficulty);
  }
  function renderGameHeader(mode){
    const m=GAME_MODES.find(x=>x.id===mode),phase=session.phases?.[session.index];$('gameType').textContent=m.name.toUpperCase();$('gameTitle').textContent=m.desc.split('.')[0];$('difficultyPill').textContent=`Уровень ${session.difficulty}`;$('roundLabel').textContent=`Раунд ${session.index+1} / ${session.modes.length}`;$('sessionPlanName').textContent=phase?`${session.spec.name} · ${phase}`:session.spec.name;$('gameProgressFill').style.width=`${session.index/session.modes.length*100}%`;$('scoreChip').textContent=`${session.xp} XP`;renderCombo();updateSessionClock();$('gameArea').innerHTML='';$('instructionText').textContent='Смотри внимательно. После показа воспроизведи то, что запомнил.';
  }
  function renderCombo(){const mult=1+Math.min(Math.max(session.combo-1,0),4)*.1;$('comboChip').textContent=`COMBO ×${mult.toFixed(1)}`;$('comboChip').classList.toggle('hot',session.combo>=3);}
  function runGame(mode,d){stats.modePlays[mode]=(stats.modePlays[mode]||0)+1;save();switch(mode){case'digits':return gameDigits(d,false);case'reverse':return gameDigits(d,true);case'words':return gameWords(d);case'grid':return gameGrid(d);case'sequence':return gameSequence(d);case'trail':return gameTrail(d);case'missing':return gameMissing(d);case'pairs':return gamePairs(d);}}
  function effectiveCountdown(){return session.spec.pressureOverride?.countdown ?? settings.countdown;}
  function effectivePace(){return settings.pace*session.paceMod;}
  function pressureConfig(mult=1){if(session.spec.pressureOverride?.on===false)return {on:false,seconds:0};const on=session.spec.pressureOverride?.on ?? settings.pressure;const sec=session.spec.pressureOverride?.seconds ?? settings.pressureSeconds;return {on,seconds:Math.max(3,Math.round(sec*mult))};}
  function showCountdown(cb){
    const c=$('countdown'),start=clamp(+effectiveCountdown()||0,0,3);$('gameArea').innerHTML='';if(!start){cb();return;}c.classList.remove('hidden');let n=start;c.textContent=n;beep('tick');const id=setInterval(()=>{n--;if(n>0){c.textContent=n;beep('tick');}else{clearInterval(id);c.classList.add('hidden');cb();}},650);registerCleanup(()=>clearInterval(id));
  }
  function delay(ms,cb){const id=setTimeout(cb,Math.max(100,ms*effectivePace()));registerCleanup(()=>clearTimeout(id));return id;}
  function startPressureTimer(onExpire,mult=1){
    stopPressure();const cfg=pressureConfig(mult);if(!cfg.on)return;let left=cfg.seconds;const box=$('pressureBox'),time=$('pressureTime'),fill=$('pressureFill');box.classList.remove('hidden');time.textContent=left;fill.style.transform='scaleX(1)';const start=Date.now();
    pressureInterval=setInterval(()=>{const elapsed=(Date.now()-start)/1000;left=Math.max(0,Math.ceil(cfg.seconds-elapsed));time.textContent=left;fill.style.transform=`scaleX(${Math.max(0,1-elapsed/cfg.seconds)})`;if(elapsed>=cfg.seconds){stopPressure();onExpire();}},200);pressureTimer=true;
  }
  function stopPressure(){if(pressureInterval)clearInterval(pressureInterval);pressureInterval=null;pressureTimer=null;$('pressureBox')?.classList.add('hidden');}
  function result(score,label,details=''){
    if(roundResolved)return;roundResolved=true;stopPressure();score=clamp(Math.round(score),0,100);
    if(score>=80)session.combo++;else if(score<70)session.combo=0;session.maxCombo=Math.max(session.maxCombo,session.combo);stats.maxCombo=Math.max(stats.maxCombo,session.maxCombo);
    const mult=1+Math.min(Math.max(session.combo-1,0),4)*.1;const xp=Math.round((12+score*.28+session.difficulty*4)*mult);session.xp+=xp;
    const mode=session.modes[session.index],m=GAME_MODES.find(x=>x.id===mode);session.results.push({mode,modeName:m.name,score,label,xp,difficulty:session.difficulty});
    stats.rounds++;stats.correct+=score;stats.total+=100;if(score===100)stats.perfectRounds++;stats.bestByMode[mode]=Math.max(stats.bestByMode[mode]||0,score);stats.scoreSumByMode[mode]=(stats.scoreSumByMode[mode]||0)+score;stats.scoreCountByMode[mode]=(stats.scoreCountByMode[mode]||0)+1;
    const d=currentDaily();d.rounds++;d.modes[mode]=1;if(score>=90)d.high++;
    if(settings.adaptive){if(score>=88)session.difficulty=clamp(session.difficulty+1,1,6);else if(score<50)session.difficulty=clamp(session.difficulty-1,1,6);}
    save();renderCombo();$('scoreChip').textContent=`${session.xp} XP`;
    const f=$('feedbackBox');f.className='feedback '+(score>=70?'good':'bad');f.innerHTML=`<b>${label} · ${score}% · +${xp} XP</b>${settings.review&&details?`<br>${details}`:''}`;score>=70?beep('ok'):beep('bad');vibrate(score>=70?25:55);
    const a=$('gameActions');a.innerHTML='';const next=document.createElement('button');next.className='btn btn-primary';updateSessionClock();const needsMore=session.spec.id==='daily'&&session.index===session.modes.length-1&&session.activeMs<session.minDurationSec*1000;next.textContent=needsMore?'Продолжить дневную тренировку':(session.index===session.modes.length-1?'Завершить тренировку':'Следующий раунд');next.addEventListener('click',()=>{session.index++;nextRound();});a.appendChild(next);
  }
  function timeoutResult(details='Время на ответ закончилось.'){result(0,'Время вышло',details);}

  function gameDigits(d,reverse){
    const len=clamp(4+d*2,4,14),seq=Array.from({length:len},()=>Math.floor(Math.random()*10)),answer=reverse?[...seq].reverse():seq;
    showCountdown(()=>{const area=$('gameArea');area.innerHTML=`<div class="flash-sequence">${seq.join('')}<span class="flash-sub">${reverse?'ЗАПОМНИ И РАЗВЕРНИ':'ЗАПОМНИ ПОСЛЕДОВАТЕЛЬНОСТЬ'}</span></div>`;delay(clamp(2600+d*280,2800,5000),()=>digitInput(answer,reverse));});
  }
  function digitInput(answer,reverse){
    $('instructionText').textContent=reverse?'Введи цифры в обратном порядке.':'Введи цифры в том же порядке.';const area=$('gameArea');area.innerHTML='<div style="width:100%;text-align:center"><input class="memory-input" id="digitInput" inputmode="numeric" autocomplete="off" maxlength="24" placeholder="••••"><div class="keypad" id="keypad"></div></div>';const input=$('digitInput'),kp=$('keypad');
    const submit=()=>{if(roundResolved)return;const got=input.value.split('').map(Number);let correct=0;for(let i=0;i<answer.length;i++)if(got[i]===answer[i])correct++;result(correct/answer.length*100,correct===answer.length?'Идеально':'Последовательность проверена',`Правильный ответ: ${answer.join('')}`);};
    ['1','2','3','4','5','6','7','8','9','←','0','✓'].forEach(k=>{const b=document.createElement('button');b.textContent=k;b.addEventListener('click',()=>{if(k==='←')input.value=input.value.slice(0,-1);else if(k==='✓')submit();else if(input.value.length<answer.length)input.value+=k;});kp.appendChild(b);});input.focus();input.addEventListener('keydown',e=>{if(e.key==='Enter')submit();});startPressureTimer(()=>timeoutResult(`Правильный ответ: ${answer.join('')}`));
  }

  function gameWords(d){
    const n=clamp(4+d,5,10),target=sample(WORD_BANK,n);showCountdown(()=>{$('gameArea').innerHTML=`<div class="word-cloud">${target.map(w=>`<span class="word-chip">${w}</span>`).join('')}</div>`;delay(clamp(4000+d*500,4500,7500),()=>wordSelect(target));});
  }
  function wordSelect(target){
    $('instructionText').textContent=`Выбери ${target.length} слов, которые были показаны.`;const distract=sample(WORD_BANK.filter(w=>!target.includes(w)),target.length+4),all=shuffle([...target,...distract]),chosen=new Set;const area=$('gameArea');area.innerHTML='<div class="word-cloud" id="wordChoices"></div>';const box=$('wordChoices');
    all.forEach(w=>{const b=document.createElement('button');b.className='word-choice';b.textContent=w;b.addEventListener('click',()=>{chosen.has(w)?chosen.delete(w):chosen.add(w);b.classList.toggle('selected');});box.appendChild(b);});
    const check=document.createElement('button');check.className='btn btn-primary';check.textContent='Проверить';check.addEventListener('click',()=>{let hit=0,falsePos=0;chosen.forEach(w=>target.includes(w)?hit++:falsePos++);const score=clamp((hit/target.length*100)-falsePos*(100/target.length*.65),0,100);result(score,hit===target.length&&!falsePos?'Все слова на месте':'Память на слова',`Были: ${target.join(', ')}`);});$('gameActions').appendChild(check);startPressureTimer(()=>timeoutResult(`Были: ${target.join(', ')}`));
  }

  function gameGrid(d){
    const size=d>=5?5:d>=3?4:3,cells=size*size,count=clamp(3+d,4,Math.min(10,cells-2)),active=new Set(sample(Array.from({length:cells},(_,i)=>i),count));showCountdown(()=>{drawGrid(size,active,false);delay(clamp(2200+d*300,2500,4300),()=>gridRecall(size,active));});
  }
  function drawGrid(size,active,interactive){
    const g=document.createElement('div');g.className='grid-board';g.style.gridTemplateColumns=`repeat(${size},1fr)`;for(let i=0;i<size*size;i++){const c=document.createElement(interactive?'button':'div');c.className='grid-cell'+(active?.has(i)?' on':'');c.dataset.i=i;g.appendChild(c);}$('gameArea').innerHTML='';$('gameArea').appendChild(g);return g;
  }
  function gridRecall(size,active){
    $('instructionText').textContent=`Отметь ${active.size} клеток, которые были подсвечены.`;const g=drawGrid(size,null,true),chosen=new Set;[...g.children].forEach(c=>c.addEventListener('click',()=>{const i=+c.dataset.i;chosen.has(i)?chosen.delete(i):chosen.add(i);c.classList.toggle('on');if(chosen.size>active.size){const first=[...chosen][0];chosen.delete(first);g.children[first].classList.remove('on');}}));const check=document.createElement('button');check.className='btn btn-primary';check.textContent='Проверить узор';check.addEventListener('click',()=>{let ok=0;active.forEach(i=>{if(chosen.has(i))ok++;});[...g.children].forEach(c=>{const i=+c.dataset.i;c.classList.remove('on');if(active.has(i))c.classList.add('correct');else if(chosen.has(i))c.classList.add('wrong');});result(ok/active.size*100,ok===active.size?'Узор восстановлен':'Визуальная память',`${ok} из ${active.size} клеток были отмечены правильно.`);});$('gameActions').appendChild(check);startPressureTimer(()=>timeoutResult('Правильный узор был показан в начале раунда.'));
  }

  function gameSequence(d){
    const n=clamp(4+d,5,10),pool=sample(EMOJIS,Math.max(n,8)),seq=sample(pool,n);showCountdown(()=>{const row=document.createElement('div');row.className='sequence-row';seq.forEach(x=>{const e=document.createElement('div');e.className='seq-item';e.textContent=x;row.appendChild(e);});$('gameArea').innerHTML='';$('gameArea').appendChild(row);delay(clamp(3200+d*300,3500,5600),()=>sequenceRecall(seq,pool));});
  }
  function sequenceRecall(seq,pool){
    $('instructionText').textContent='Нажми символы в том же порядке.';const answer=[];$('gameArea').innerHTML='<div><div class="sequence-row" id="answerRow"></div><div class="choice-grid" id="sequenceChoices" style="margin-top:24px"></div></div>';const choices=shuffle([...seq,...sample(pool.filter(x=>!seq.includes(x)),Math.min(2,pool.length-seq.length))]);
    choices.forEach(x=>{const b=document.createElement('button');b.className='choice-btn';b.textContent=x;b.addEventListener('click',()=>{if(roundResolved||answer.length>=seq.length)return;answer.push(x);const e=document.createElement('div');e.className='seq-item active';e.textContent=x;$('answerRow').appendChild(e);if(answer.length===seq.length){let ok=0;for(let i=0;i<seq.length;i++)if(answer[i]===seq[i])ok++;result(ok/seq.length*100,ok===seq.length?'Порядок идеален':'Порядок проверен',`Правильная цепочка: ${seq.join(' ')}`);}});$('sequenceChoices').appendChild(b);});startPressureTimer(()=>timeoutResult(`Правильная цепочка: ${seq.join(' ')}`));
  }

  function gameTrail(d){
    const size=clamp(3+Math.floor(d/3),3,4),len=clamp(3+d,4,9),cells=size*size,seq=[];while(seq.length<len){const x=Math.floor(Math.random()*cells);if(seq[seq.length-1]!==x)seq.push(x);}showCountdown(()=>{const g=document.createElement('div');g.className='trail-grid';g.style.gridTemplateColumns=`repeat(${size},1fr)`;for(let i=0;i<cells;i++){const c=document.createElement('div');c.className='trail-cell';g.appendChild(c);}$('gameArea').innerHTML='';$('gameArea').appendChild(g);let idx=0;const stepMs=Math.max(300,650*effectivePace());const id=setInterval(()=>{[...g.children].forEach(x=>{x.classList.remove('flash');x.textContent='';});if(idx>=seq.length){clearInterval(id);const t=setTimeout(()=>trailRecall(size,seq),Math.max(220,450*effectivePace()));registerCleanup(()=>clearTimeout(t));return;}g.children[seq[idx]].classList.add('flash');g.children[seq[idx]].textContent=idx+1;idx++;},stepMs);registerCleanup(()=>clearInterval(id));});
  }
  function trailRecall(size,seq){
    $('instructionText').textContent='Повтори маршрут, нажимая клетки по порядку.';const cells=size*size,g=document.createElement('div');g.className='trail-grid';g.style.gridTemplateColumns=`repeat(${size},1fr)`;let pos=0,ok=0;for(let i=0;i<cells;i++){const c=document.createElement('button');c.className='trail-cell';c.addEventListener('click',()=>{if(roundResolved||pos>=seq.length)return;if(i===seq[pos]){ok++;c.classList.add('done');c.textContent=pos+1;}else c.classList.add('error');pos++;if(pos===seq.length)result(ok/seq.length*100,ok===seq.length?'Маршрут повторён':'Пространственная память',`${ok} из ${seq.length} шагов совпали.`);});g.appendChild(c);}$('gameArea').innerHTML='';$('gameArea').appendChild(g);startPressureTimer(()=>timeoutResult('Маршрут можно попробовать ещё раз в следующем раунде.'));
  }

  function gameMissing(d){
    const n=clamp(5+d,6,11),items=sample(EMOJIS,n),missing=items[Math.floor(Math.random()*items.length)];showCountdown(()=>{$('gameArea').innerHTML=`<div class="missing-display">${items.map(x=>`<div class="missing-item">${x}</div>`).join('')}</div>`;delay(clamp(3500+d*300,4000,6000),()=>missingRecall(items,missing));});
  }
  function missingRecall(items,missing){
    $('instructionText').textContent='Один объект исчез. Какой именно?';const choices=shuffle([missing,...sample(EMOJIS.filter(x=>!items.includes(x)),5)]);$('gameArea').innerHTML='<div class="choice-grid" id="missingChoices"></div>';choices.forEach(x=>{const b=document.createElement('button');b.className='choice-btn';b.textContent=x;b.addEventListener('click',()=>result(x===missing?100:0,x===missing?'Нашёл исчезнувший':'Не тот объект',`Исчез: ${missing}`));$('missingChoices').appendChild(b);});startPressureTimer(()=>timeoutResult(`Исчез: ${missing}`));
  }

  function gamePairs(d){
    const pairs=clamp(3+d,4,8),vals=sample(EMOJIS,pairs),deck=shuffle([...vals,...vals]);$('instructionText').textContent='Открой все пары. Чем меньше ходов — тем выше результат.';const g=document.createElement('div');g.className='pairs-grid';let open=[],matched=0,moves=0,lock=false;deck.forEach((v,i)=>{const b=document.createElement('button');b.className='pair-card';b.textContent=v;b.addEventListener('click',()=>{if(roundResolved||lock||b.classList.contains('matched')||open.includes(i))return;b.classList.add('revealed');open.push(i);if(open.length===2){moves++;const[a,c]=open;if(deck[a]===deck[c]){g.children[a].classList.add('matched');g.children[c].classList.add('matched');open=[];matched++;if(matched===pairs){const ideal=pairs,score=clamp(100-(moves-ideal)*8,35,100);result(score,'Все пары найдены',`${moves} ходов. Идеальный минимум: ${ideal}.`);}}else{lock=true;const t=setTimeout(()=>{g.children[a].classList.remove('revealed');g.children[c].classList.remove('revealed');open=[];lock=false;},650);registerCleanup(()=>clearTimeout(t));}}});g.appendChild(b);});$('gameArea').innerHTML='';$('gameArea').appendChild(g);startPressureTimer(()=>timeoutResult('Время на поиск пар закончилось.'),2);
  }

  function finishSession(){
    cleanupActive();updateSessionClock();stopSessionClock();releaseWake();const activeSeconds=Math.max(1,Math.round(session.activeMs/1000));stats.activeSeconds=(stats.activeSeconds||0)+activeSeconds;stats.xp+=session.xp;stats.sessions++;stats.planPlays[session.spec.id]=(stats.planPlays[session.spec.id]||0)+1;const today=dateKey(),prev=stats.lastSession,d=currentDaily();d.sessions++;d.seconds=(d.seconds||0)+activeSeconds;
    if(prev!==today){const y=new Date();y.setDate(y.getDate()-1);stats.streak=prev===dateKey(y)?stats.streak+1:1;stats.bestStreak=Math.max(stats.bestStreak,stats.streak);stats.days[today]=1;stats.lastSession=today;}
    const sessionAvg=Math.round(avg(session.results.map(r=>r.score)));d.bestAvg=Math.max(d.bestAvg||0,sessionAvg);
    stats.history.unshift({date:new Date().toISOString(),plan:session.spec.name,planId:session.spec.id,avg:sessionAvg,xp:session.xp,rounds:session.results.length,difficulty:session.difficulty,seconds:activeSeconds});stats.history=stats.history.slice(0,30);save();applyMissionRewards();
    $('summaryScore').textContent=`${sessionAvg}%`;$('summaryRing').style.setProperty('--score',`${sessionAvg}%`);$('summaryXp').textContent=`+${session.xp}`;$('summaryAccuracy').textContent=`${sessionAvg}%`;$('summaryCombo').textContent=`×${(1+Math.min(Math.max(session.maxCombo-1,0),4)*.1).toFixed(1)}`;$('summaryDuration').textContent=fmtClock(activeSeconds);
    $('summaryTitle').textContent=sessionAvg>=92?'Память в огне':sessionAvg>=80?'Сильная сессия':sessionAvg>=65?'Хороший рабочий темп':'Есть куда расти';$('summaryText').textContent=`${session.spec.name}: ${session.results.length} ${roundWord(session.results.length)} за ${fmtClock(activeSeconds)}. ${session.spec.id==='daily'?'Ты прошёл несколько разных типов памяти в одной сессии. ':''}${session.maxCombo>=3?`Лучшее комбо — ${session.maxCombo}.`:'Следующая сессия использует твою статистику для адаптации.'}`;
    const report=$('roundReport');report.innerHTML='';session.results.forEach((r,i)=>{const row=document.createElement('div');row.className='round-line';row.innerHTML=`<b>${i+1}. ${r.modeName}</b><span>ур. ${r.difficulty}</span><strong>${r.score}% · +${r.xp}</strong>`;report.appendChild(row);});renderHome();showView('summary');
  }

  function renderAnalytics(){
    const mastery=$('masteryList');mastery.innerHTML='';GAME_MODES.forEach(m=>{const a=modeAverage(m.id),plays=stats.scoreCountByMode[m.id]||0,row=document.createElement('div');row.className='mastery-row';row.innerHTML=`<span>${m.name}</span><div class="bar"><i style="width:${a===null?0:a}%"></i></div><strong>${a===null?'—':Math.round(a)+'%'}</strong>`;row.title=`${plays} ${roundWord(plays)}`;mastery.appendChild(row);});
    const hist=$('historyList');hist.innerHTML='';if(!stats.history.length)hist.innerHTML='<div class="history-item"><div><b>Истории пока нет</b><small>Заверши первую сессию.</small></div><strong>—</strong></div>';else stats.history.slice(0,10).forEach(h=>{const d=new Date(h.date),row=document.createElement('div');row.className='history-item';row.innerHTML=`<div><b>${h.plan}</b><small>${d.toLocaleDateString('ru-RU')} · ${h.seconds?fmtClock(h.seconds)+' · ':''}${h.rounds} ${roundWord(h.rounds)} · +${h.xp} XP</small></div><strong>${h.avg}%</strong>`;hist.appendChild(row);});
    const played=ALL_MODE_IDS.filter(id=>modeAverage(id)!==null);if(played.length<2)$('analyticsInsight').textContent='Нужно хотя бы несколько разных режимов, чтобы сравнить сильные и слабые стороны.';else{const weak=weakestModes(1)[0],strong=strongestMode(),wm=GAME_MODES.find(m=>m.id===weak),sm=GAME_MODES.find(m=>m.id===strong);$('analyticsInsight').textContent=`Самый сильный режим сейчас — ${sm.name} (${Math.round(modeAverage(strong))}%). Больше всего потенциала для роста в ${wm.name} (${Math.round(modeAverage(weak))}%). Разница между ними — ${Math.round(modeAverage(strong)-modeAverage(weak))} п.п. Для более устойчивой картины ориентируйся минимум на 5–10 раундов каждого режима.`;}
  }

  function populateModeToggles(containerId,selected){
    const el=$(containerId);el.innerHTML='';GAME_MODES.forEach(m=>{const l=document.createElement('label');l.className='mode-toggle';l.innerHTML=`<input type="checkbox" value="${m.id}" ${selected.includes(m.id)?'checked':''}><span>${m.icon} ${m.name}</span>`;el.appendChild(l);});
  }
  function checkedModes(containerId){return [...$(containerId).querySelectorAll('input:checked')].map(x=>x.value);}
  function openSettings(){
    $('profileNameInput').value=settings.profileName;$('dailyRounds').value=settings.dailyRounds;$('dailyMinutes').value=settings.dailyMinutes;$('baseDifficulty').value=settings.baseDifficulty;$('paceSelect').value=String(settings.pace);$('countdownSelect').value=String(settings.countdown);$('adaptiveToggle').checked=settings.adaptive;$('pressureToggle').checked=settings.pressure;$('pressureSeconds').value=settings.pressureSeconds;$('reviewToggle').checked=settings.review;$('themeSelect').value=settings.theme;$('animationsToggle').checked=settings.animations;$('soundToggle').checked=settings.sound;$('vibrationToggle').checked=settings.vibration;$('wakeToggle').checked=settings.wake;populateModeToggles('modeToggleGrid',settings.enabledModes);$('settingsModal').classList.remove('hidden');
  }
  function closeSettings(){$('settingsModal').classList.add('hidden');}
  function saveSettings(){
    const modes=checkedModes('modeToggleGrid');if(modes.length<4){toast('Для полноценного Daily оставь минимум 4 режима');return;}
    settings.profileName=($('profileNameInput').value||'Игрок').trim().slice(0,18)||'Игрок';settings.dailyRounds=clamp(+$('dailyRounds').value||9,9,16);settings.dailyMinutes=clamp(+$('dailyMinutes').value||6,5,20);settings.baseDifficulty=clamp(+$('baseDifficulty').value||1,1,6);settings.pace=clamp(+$('paceSelect').value||1,.5,1.5);settings.countdown=clamp(+$('countdownSelect').value||0,0,3);settings.adaptive=$('adaptiveToggle').checked;settings.pressure=$('pressureToggle').checked;settings.pressureSeconds=clamp(+$('pressureSeconds').value||20,5,90);settings.review=$('reviewToggle').checked;settings.theme=$('themeSelect').value;settings.animations=$('animationsToggle').checked;settings.sound=$('soundToggle').checked;settings.vibration=$('vibrationToggle').checked;settings.wake=$('wakeToggle').checked;settings.enabledModes=modes;save();applyTheme();renderHome();closeSettings();toast('Настройки сохранены');
  }
  function defaults(){settings=deepClone(defaultSettings);save();openSettings();toast('Настройки возвращены по умолчанию');}
  function resetAll(){if(!confirm('Удалить весь прогресс Memory Lab 2 на этом устройстве? Настройки останутся.'))return;stats=mergeStats(defaultStats);save();renderHome();closeSettings();toast('Прогресс сброшен');}
  function exportProgress(){
    const payload={app:'Memory Lab 2',version:2,exportedAt:new Date().toISOString(),stats,settings};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`memory-lab-${dateKey()}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Файл прогресса создан');
  }
  async function importProgress(file){
    try{const payload=JSON.parse(await file.text());if(!payload||typeof payload!=='object'||!payload.stats)throw new Error('bad');stats=mergeStats(payload.stats);settings=mergeSettings(payload.settings||settings);save();applyTheme();renderHome();closeSettings();toast('Прогресс импортирован');}catch{toast('Не удалось прочитать файл прогресса');}
  }
  function openCustom(){populateModeToggles('customModeGrid',settings.enabledModes);$('customRounds').value=Math.max(3,settings.dailyRounds);$('customModal').classList.remove('hidden');}
  function closeCustom(){$('customModal').classList.add('hidden');}
  function startCustom(){const modes=checkedModes('customModeGrid');if(!modes.length){toast('Выбери хотя бы один режим');return;}const rounds=clamp(+$('customRounds').value||6,3,15);closeCustom();startSession({id:'custom',name:'Custom Mix',modes:buildModes(rounds,modes),paceMod:1,difficultyBoost:0,pressureOverride:null});}

  $('dailyBtn').addEventListener('click',()=>startPlan('daily'));
  $('quickBtn').addEventListener('click',()=>startSession({id:'quick',name:'Quick Round',modes:[sample(enabledModes(),1)[0]],paceMod:1,difficultyBoost:0,pressureOverride:null}));
  $('randomGameBtn').addEventListener('click',()=>startSession({id:'random',name:'Random Game',modes:[sample(enabledModes(),1)[0]],paceMod:1,difficultyBoost:0,pressureOverride:null}));
  $('weakSpotBtn').addEventListener('click',()=>startPlan('weak'));
  $('customBtn').addEventListener('click',openCustom);
  $('closeCustom').addEventListener('click',closeCustom);
  $('startCustomBtn').addEventListener('click',startCustom);
  $('customModal').addEventListener('click',e=>{if(e.target===$('customModal'))closeCustom();});

  $('homeBtn').addEventListener('click',()=>{cleanupActive();stopSessionClock();releaseWake();session=null;renderHome();showView('home');});
  $('exitGameBtn').addEventListener('click',()=>{if(confirm('Выйти из текущей тренировки? Незавершённый раунд не сохранится.')){cleanupActive();stopSessionClock();releaseWake();session=null;renderHome();showView('home');}});
  $('summaryHomeBtn').addEventListener('click',()=>showView('home'));
  $('summaryAgainBtn').addEventListener('click',()=>{if(!lastSessionSpec)return startPlan('daily');const spec=lastSessionSpec.id==='daily'?planSpec('daily'):lastSessionSpec.id==='sprint'?planSpec('sprint'):lastSessionSpec.id==='marathon'?planSpec('marathon'):lastSessionSpec.id==='precision'?planSpec('precision'):lastSessionSpec.id==='weak'?planSpec('weak'):{...lastSessionSpec,modes:buildModes(lastSessionSpec.modes.length,lastSessionSpec.modes)};startSession(spec);});

  function openAnalytics(){renderAnalytics();showView('analytics');}
  $('analyticsBtn').addEventListener('click',openAnalytics);$('openAnalyticsBtn').addEventListener('click',openAnalytics);$('analyticsBackBtn').addEventListener('click',()=>{renderHome();showView('home');});

  $('settingsBtn').addEventListener('click',openSettings);$('closeSettings').addEventListener('click',closeSettings);$('saveSettingsBtn').addEventListener('click',saveSettings);$('defaultsBtn').addEventListener('click',defaults);$('resetAllBtn').addEventListener('click',resetAll);$('exportBtn').addEventListener('click',exportProgress);$('importInput').addEventListener('change',e=>{const f=e.target.files?.[0];if(f)importProgress(f);e.target.value='';});$('settingsModal').addEventListener('click',e=>{if(e.target===$('settingsModal'))closeSettings();});
  $('soundBtn').addEventListener('click',()=>{settings.sound=!settings.sound;save();applyTheme();toast(settings.sound?'Звук включён':'Звук выключен');});

  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;$('installBtn').classList.remove('hidden');});
  $('installBtn').addEventListener('click',async()=>{if(!deferredInstall)return;deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;$('installBtn').classList.add('hidden');});
  document.addEventListener('visibilitychange',()=>{if(session){session.lastTick=Date.now();if(document.visibilityState==='visible')holdWake();}});
  if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));

  applyTheme();renderHome();showView('home');save();
})();
