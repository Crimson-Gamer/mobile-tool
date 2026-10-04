// Mobile Tools - client-side helper mod for Mindustry v7 (build 146+)
// Everything is controlled from the "MT" button on the left side of the HUD.

var S = {
  turretRanges: false, enemyRanges: false, unitRanges: false, power: false,
  assist: false, copyShoot: true, targetId: -1, circle: true, coreFirst: true,
  farReset: true, farTiles: 100,   // respawn at core if the helped player is farther than this many tiles
  coreTiles: 25,   // "close to core" distance, in tiles
  orbit: 6,        // circle radius around the player you help, in tiles
  mine: false, mineMatch: true, mineCircle: true, mineOrbit: 5, mineIdx: 0, rebuild: false, retreat: false, goCore: false,
  grief: true, griefPublic: false, griefRebuild: false, wantUnit: "", manualOverride: false, griefLimit: 8, griefWindow: 6000
};

var MINE_ITEMS = ["copper", "lead", "sand", "coal", "titanium", "beryllium", "tungsten"];
var MINE_CHOICES = ["auto"].concat(MINE_ITEMS);

var retreating = false, arrived = false, lastManual = 0;
var holdVel = null, holdUnit = null, orbitAngle = 0, lastReset = 0;
var matchTile = null, matchItem = null, matchTime = 0;
var autoItem = null, holdMine = null, holdMineOn = false;
var mineInfo = "", fullSince = 0, blockedItem = null, blockedUntil = 0;
var shootSrc = null;
var oreTile = null, oreItem = null, lastOre = 0, lastTransfer = 0;
var ourPlan = null;
var undoStack = [], griefLog = [], tally = {}, removed = [], lastSwitch = 0;

// Explicit wrappers: Mindustry's Rhino can't pick between overloads when given a bare function
function mkCons(f){ return new Packages.arc.func.Cons({get: f}); }
function mkRun(f){ return new java.lang.Runnable({run: f}); }
function mkBoolc(f){ return new Packages.arc.func.Boolc({get: f}); }
function mkProv(f){ return new Packages.arc.func.Prov({get: f}); }
function mkBoolp(f){ return new Packages.arc.func.Boolp({get: f}); }
function eachOf(group, f){ group.each(mkCons(f)); }

function manualInput(){
  try{
    if(Core.input.isTouched()) return true;
    if(Math.abs(Core.input.axis(Binding.move_x)) > 0.1 || Math.abs(Core.input.axis(Binding.move_y)) > 0.1) return true;
  }catch(err){}
  return false;
}
function overridden(){ return S.manualOverride && Time.millis() - lastManual < 800; }

function chatAlert(msg){
  try{ Vars.ui.chatfrag.addMessage("[scarlet][Anti-grief][white] " + msg); }
  catch(err){ Vars.ui.showInfoToast("[scarlet]" + msg, 4); }
  try{ if(S.griefPublic && Vars.net.active()) Call.sendChatMessage("[Anti-grief] " + msg); }catch(err){}
}

function toast(msg){ Vars.ui.showInfoToast(msg, 3); }
function me(){ return Vars.player.unit(); }
function alive(){ return Vars.state.isGame() && !Vars.player.dead(); }

function replaceMap(){
  return [
    [Blocks.conveyor, Blocks.titaniumConveyor],
    [Blocks.copperWall, Blocks.titaniumWall],
    [Blocks.copperWallLarge, Blocks.titaniumWallLarge],
    [Blocks.mechanicalDrill, Blocks.pneumaticDrill]
  ];
}

// ---------- movement ----------
function moveToward(u, x, y, stop){
  var d = Mathf.dst(u.x, u.y, x, y);
  if(d <= stop) return true;
  Tmp.v1.set(x, y).sub(u.x, u.y).setLength(u.speed() * Mathf.clamp((d - stop) / 40, 0.15, 1));
  u.movePref(Tmp.v1);
  u.lookAt(x, y);
  return false;
}

function orbit(u, t, rt){
  if(!u.type.flying){ moveToward(u, t.x, t.y, 60); return; }
  var r = (rt || S.orbit) * 8;
  var step = Math.min(4, u.speed() * 0.8 / r * 57.3) * Time.delta;
  orbitAngle = (orbitAngle + step) % 360;
  Tmp.v2.trns(orbitAngle, r).add(t.x, t.y);
  Tmp.v1.set(Tmp.v2).sub(u.x, u.y);
  var d = Tmp.v1.len();
  if(d > 0.5) Tmp.v1.setLength(Math.min(u.speed(), d * 0.5));
  u.movePref(Tmp.v1);
  u.lookAt(t.x, t.y);
}

// ---------- help build ----------
function assistTick(u, core){
  if(!u.canBuild()) return false;
  var p = null;
  if(S.targetId != -1){
    p = Groups.player.getByID(S.targetId);
    if(p == null){ S.targetId = -1; toast("Target left, helping anyone"); }
  }
  if(p == null){
    var best = 1e9;
    eachOf(Groups.player, q => {
      if(q == Vars.player || q.dead() || q.team() != Vars.player.team()) return;
      var qu = q.unit();
      if(!qu.activelyBuilding()) return;
      var d = u.dst(qu);
      if(d < best){ best = d; p = q; }
    });
  }
  if(p == null || p.dead()){ arrived = false; return false; }

  var tu = p.unit();
  shootSrc = tu;

  // helped player is very far away: respawn at the closest core if that is much nearer to them
  if(S.farReset && core != null && Time.millis() - lastReset > 15000){
    var dFar = Mathf.dst(u.x, u.y, tu.x, tu.y);
    if(dFar > S.farTiles * 8 && Mathf.dst(core.x, core.y, tu.x, tu.y) < dFar - 160){
      lastReset = Time.millis();
      arrived = true;
      toast("Resetting to core: " + Strings.stripColors(p.name) + " is far away");
      try{ Call.unitClear(Vars.player); }catch(err){ Vars.player.clearUnit(); }
      return true;
    }
  }

  var plan = tu.activelyBuilding() ? tu.buildPlan() : null;
  if(plan == null) arrived = false;

  // go near the closest core first when far away
  if(plan != null && S.coreFirst && core != null && !arrived){
    if(u.within(core, S.coreTiles * 8)) arrived = true;
    else { moveToward(u, core.x, core.y, S.coreTiles * 8 * 0.6); return true; }
  }

  if(plan != null){
    var cur = u.buildPlan();
    if(cur == null || cur.x != plan.x || cur.y != plan.y || cur.block != plan.block || cur.breaking != plan.breaking){
      u.plans.clear();
      u.plans.addFirst(plan.copy());
    }
    u.updateBuilding = true;
    var px = plan.drawx(), py = plan.drawy();
    if(S.circle && Mathf.dst(tu.x, tu.y, px, py) < Vars.buildingRange - 30 - S.orbit * 8) orbit(u, tu);
    else if(!u.within(px, py, Vars.buildingRange - 30)) moveToward(u, px, py, Vars.buildingRange - 60);
    return true;
  }

  if(S.targetId != -1){
    if(S.mine && S.mineMatch && tu.mineTile != null) return false; // let auto mine join them
    if(S.circle) orbit(u, tu); else moveToward(u, tu.x, tu.y, 60);
    return true;
  }
  return false;
}

// ---------- rebuild destroyed blocks ----------
function rebuildTick(u){
  if(!u.canBuild()) return false;
  var q = u.team.data().plans;
  var cur = u.buildPlan();
  if(cur == null){
    if(q.size == 0) return false;
    var bp = q.first();
    var t = Vars.world.tile(bp.x, bp.y);
    var blk = Vars.content.block(bp.block);
    if(t != null && t.block().id == bp.block){
      q.removeFirst();
    }else if(Build.validPlace(blk, u.team, bp.x, bp.y, bp.rotation)){
      ourPlan = new BuildPlan(bp.x, bp.y, bp.rotation, blk, bp.config);
      u.addBuild(ourPlan);
      q.addLast(q.removeFirst());
    }else{
      q.addLast(q.removeFirst());
    }
    return true;
  }
  if(ourPlan == null || cur.x != ourPlan.x || cur.y != ourPlan.y) return false; // player's own plan
  u.updateBuilding = true;
  moveToward(u, cur.drawx(), cur.drawy(), Vars.buildingRange - 60);
  return true;
}

// ---------- auto mine ----------
function minerToCopy(u){
  var pl = S.targetId != -1 ? Groups.player.getByID(S.targetId) : null;
  if(pl != null && !pl.dead() && pl.unit().mineTile != null) return pl.unit();
  if(S.targetId != -1) return null;
  var best = null, bd = 1e9;
  eachOf(Groups.player, q => {
    if(q == Vars.player || q.dead() || q.team() != Vars.player.team()) return;
    var qu = q.unit();
    if(qu.mineTile == null) return;
    var d = u.dst(qu);
    if(d < bd){ bd = d; best = qu; }
  });
  return best;
}

function matching(){ return S.mineMatch && matchTile != null && Time.millis() - matchTime < 15000; }

function isBlocked(i){ return i == blockedItem && Time.millis() < blockedUntil; }

var WALL_ITEMS = {beryllium: true, tungsten: true};
var oreCache = {}, lastScan = 0;

// what this unit would get from mining this tile (floor ore or wall ore), as the game itself decides
function mineResult(u, t){
  if(t == null) return null;
  try{ return u.getMineResult(t); }catch(err){}
  if(t.block() == Blocks.air) return t.drop();
  return (u.type.mineWalls === true) ? t.wallDrop() : null;
}

function oreOk(t, item){ return t != null && mineResult(me(), t) == item; }

// wall ores (beryllium, tungsten) for units that mine walls: look around the unit
function scanWallOre(u, item){
  var cx = Math.floor(u.x / 8), cy = Math.floor(u.y / 8), R = 45;
  var best = null, bd = 1e9;
  for(var x = cx - R; x <= cx + R; x++){
    for(var y = cy - R; y <= cy + R; y++){
      var t = Vars.world.tile(x, y);
      if(t == null || t.block() == Blocks.air) continue;
      if(mineResult(u, t) != item) continue;
      var d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if(d < bd){ bd = d; best = t; }
    }
  }
  return best;
}

function findOre(u, item){
  var t = null;
  try{ t = Vars.indexer.findClosestOre(u, item); }catch(err){}
  if(t != null) return t;
  if(u.type.mineWalls === true && WALL_ITEMS[item.name] && Time.millis() - lastScan > 3000){
    lastScan = Time.millis();
    t = scanWallOre(u, item);
  }
  return t;
}

function hasOreFor(u, item){
  var key = u.type.name + ":" + item.name;
  var now = Time.millis();
  var c = oreCache[key];
  if(c != null && now - c.t < 3000) return c.v;
  var v = false;
  if(u.type.mineFloor !== false){ try{ v = Vars.indexer.hasOre(item); }catch(err){} }
  if(!v && u.type.mineWalls === true && WALL_ITEMS[item.name]) v = scanWallOre(u, item) != null;
  oreCache[key] = {t: now, v: v};
  return v;
}

function chooseItem(u, core){
  if(S.mineMatch){
    var mu = minerToCopy(u);
    if(mu != null){
      var mt = mu.mineTile;
      var mi = mineResult(mu, mt);
      if(mi != null && u.canMine(mi)){ matchTile = mt; matchItem = mi; matchTime = Time.millis(); return mi; }
    }else if(matching() && matchItem != null && u.canMine(matchItem)){
      return matchItem;
    }
  }
  // keep mining what we are already carrying until the stack is full
  if(MINE_CHOICES[S.mineIdx] == "auto"){
    if(u.stack.amount > 0 && u.stack.item != null && u.canMine(u.stack.item) && !isBlocked(u.stack.item)){ autoItem = u.stack.item; return autoItem; }
    if(autoItem != null && u.canMine(autoItem) && hasOreFor(u, autoItem) && !isBlocked(autoItem)) return autoItem;
  }
  var want = MINE_CHOICES[S.mineIdx];
  if(want != "auto"){
    var it = Vars.content.item(want);
    if(it != null && u.canMine(it)) return it;
    mineInfo = "this unit can't mine " + want;
    return null;
  }
  var best = null, amt = 1e9;
  for(var n = 0; n < MINE_ITEMS.length; n++){
    var i = Vars.content.item(MINE_ITEMS[n]);
    if(i == null || !u.canMine(i) || !hasOreFor(u, i) || isBlocked(i)) continue;
    var a = core.items.get(i);
    if(a < amt){ amt = a; best = i; }
  }
  if(best == null) mineInfo = "nothing minable here for this unit";
  autoItem = best;
  return best;
}

function minableNow(){
  if(!alive()) return "";
  var u = me(), out = [];
  for(var n = 0; n < MINE_ITEMS.length; n++){
    var i = Vars.content.item(MINE_ITEMS[n]);
    if(i != null && u.canMine(i) && hasOreFor(u, i)) out.push(i.name);
  }
  return out.length ? out.join(", ") : "nothing on this map";
}

function mineTick(u, core){
  if(core == null || u.type.mineTier < 0) return false;
  var item = chooseItem(u, core);
  if(item == null) return false;
  var full = u.stack.amount >= u.type.itemCapacity || (u.stack.amount > 0 && u.stack.item != item);
  if(full){
    u.mineTile = null;
    var held = u.stack.item;
    mineInfo = "deliver " + (held != null ? held.name : "?") + " " + u.stack.amount + "/" + u.type.itemCapacity;
    if(u.within(core, 20)){
      if(fullSince == 0) fullSince = Time.millis();
      mineInfo += " core " + (held != null ? core.items.get(held) : 0) + "/" + core.storageCapacity;
      if(Time.millis() - lastTransfer > 300){
        Call.transferInventory(Vars.player, core);
        lastTransfer = Time.millis();
        autoItem = null;
      }
      if(Time.millis() - fullSince > 3000){
        // the core is not taking it: skip this item for a minute and clear the stack
        blockedItem = held; blockedUntil = Time.millis() + 60000;
        try{ Call.dropItem(Vars.player, 0); }catch(err){}
        u.clearItem();
        fullSince = 0;
        toast("Core won't take " + (held != null ? held.name : "items") + ", switching");
      }
    }else{
      fullSince = 0;
      moveToward(u, core.x, core.y, 16);
    }
    return true;
  }
  fullSince = 0;
  if(u.mineTile != null && !oreOk(u.mineTile, item)){ u.mineTile = null; oreTile = null; }
  if(matching() && item == matchItem){
    oreTile = matchTile; oreItem = item;
  }else if(oreTile == null || oreItem != item || !oreOk(oreTile, item)){
    oreTile = findOre(u, item);
    oreItem = item;
  }
  if(oreTile == null){ mineInfo = item.name + " no ore found"; return false; }
  mineInfo = item.name + " " + u.stack.amount + "/" + u.type.itemCapacity + (u.within(oreTile.worldx(), oreTile.worldy(), u.type.mineRange - 10) ? " mining " : " going ") + Math.round(Mathf.dst(u.x, u.y, oreTile.worldx(), oreTile.worldy()) / 8) + "t";
  if(u.within(oreTile.worldx(), oreTile.worldy(), u.type.mineRange - 10)){
    u.mineTile = oreTile;
    if(S.mineCircle && u.type.flying) orbit(u, {x: oreTile.worldx(), y: oreTile.worldy()}, S.mineOrbit);
  }else{
    u.mineTile = null;
    moveToward(u, oreTile.worldx(), oreTile.worldy(), u.type.mineRange - 30);
  }
  return true;
}

// ---------- unit switcher ----------
function unitSwitchTick(){
  if(S.wantUnit == "") return;
  var now = Time.millis();
  if(now - lastSwitch < 1500) return;
  var u = me();
  if(u.type.name == S.wantUnit) return;
  var best = null, bd = 1e9;
  eachOf(Groups.unit, q => {
    if(q.team != Vars.player.team() || q.type.name != S.wantUnit || q.isPlayer() || !q.isValid()) return;
    if(q.type.playerControllable === false) return;
    var d = u.dst(q);
    if(d < bd){ bd = d; best = q; }
  });
  if(best == null) return;
  lastSwitch = now;
  Call.unitControl(Vars.player, best);
  toast("Switching to " + S.wantUnit);
}

// ---------- rebuild what others removed ----------
function queueRebuild(list){
  var u = me();
  var q = u.team.data().plans;
  var n = 0, rest = [];
  for(var i = 0; i < removed.length; i++){
    var r = removed[i];
    if(list.indexOf(r) < 0){ rest.push(r); continue; }
    var t = Vars.world.tile(r.x, r.y);
    if(t != null && t.block() == r.block) continue;
    try{
      q.addLast(new Packages.mindustry.game.Teams$BlockPlan(r.x, r.y, r.rot, r.block.id, r.cfg));
    }catch(err){
      u.addBuild(new BuildPlan(r.x, r.y, r.rot, r.block, r.cfg));
    }
    n++;
  }
  removed = rest;
  if(n > 0) S.rebuild = true;
  return n;
}

// ---------- brain ----------
function runBrain(u, core){
  if(S.goCore){
    if(core == null){ S.goCore = false; return false; }
    if(moveToward(u, core.x, core.y, 40)) S.goCore = false;
    return true;
  }
  if(S.retreat && core != null){
    if(u.health < u.maxHealth * 0.3) retreating = true;
    else if(u.health > u.maxHealth * 0.8) retreating = false;
    if(retreating){ moveToward(u, core.x, core.y, 40); return true; }
  }
  if(S.assist && assistTick(u, core)) return true;
  if(S.rebuild && rebuildTick(u)) return true;
  if(S.mine) return mineTick(u, core);
  return false;
}

Events.run(EventType.Trigger.update, () => {
  holdVel = null;
  holdMineOn = false;
  if(!alive()) return;
  try{
    unitSwitchTick();
    if(S.manualOverride && manualInput()) lastManual = Time.millis();
    if(overridden()) return;
    var u = me();
    if(runBrain(u, u.closestCore())){ holdVel = u.vel.cpy(); holdUnit = u; holdMine = u.mineTile; holdMineOn = S.mine; }
  }catch(err){
    Log.err(err);
    holdVel = null;
    S.assist = false; S.mine = false; S.rebuild = false; S.retreat = false; S.goCore = false;
    toast("[scarlet]Mobile Tools error, automation turned off");
  }
});

// Runs after the game's own input each frame: while automation is in charge of the unit,
// undo any movement the normal controls added (e.g. mobile "fly toward the camera").
Events.run(EventType.Trigger.draw, () => {
  try{
    if(holdVel != null && alive() && me() == holdUnit) holdUnit.vel.set(holdVel);
    if(holdMineOn && alive() && me() == holdUnit) holdUnit.mineTile = holdMine;
    // copy the helped player's shooting and aim (set after the game's own input, so it sticks)
    if(S.copyShoot && shootSrc != null && alive() && shootSrc.isShooting){
      var mu = me();
      try{ mu.aim(shootSrc.aimX, shootSrc.aimY); }catch(err2){ mu.aimX = shootSrc.aimX; mu.aimY = shootSrc.aimY; }
      mu.isShooting = true;
      Vars.player.shooting = true;
      Vars.player.mouseX = shootSrc.aimX;
      Vars.player.mouseY = shootSrc.aimY;
    }
  }catch(err){}
  holdVel = null;
  holdMineOn = false;
  shootSrc = null;
});

// ---------- overlays ----------
Events.run(EventType.Trigger.draw, () => {
  if(!Vars.state.isGame()) return;
  if(!(S.turretRanges || S.enemyRanges || S.unitRanges || S.power)) return;
  try{
    var mine = Vars.player.team();
    Core.camera.bounds(Tmp.r1);
    Tmp.r1.grow(320);
    Draw.z(Layer.overlayUI);
    Lines.stroke(1.2);
    eachOf(Groups.build, b => {
      if(!Tmp.r1.contains(b.x, b.y)) return;
      if(b.block.group == BlockGroup.turrets){
        var own = b.team == mine;
        if((own && S.turretRanges) || (!own && S.enemyRanges)){
          Draw.color(b.team.color, 0.6);
          Lines.circle(b.x, b.y, b.block.range);
        }
      }
      if(S.power && b.team == mine && b.power != null && b.block.consumesPower && b.shouldConsume() && b.power.status < 0.5){
        Draw.color(Color.scarlet, 0.9);
        Lines.circle(b.x, b.y, b.block.size * 4 + 3);
      }
    });
    if(S.unitRanges){
      eachOf(Groups.unit, un => {
        if(un.team == mine || !Tmp.r1.contains(un.x, un.y)) return;
        Draw.color(un.team.color, 0.5);
        Lines.circle(un.x, un.y, un.range());
      });
    }
    Draw.reset();
  }catch(err){
    Log.err(err);
    S.turretRanges = false; S.enemyRanges = false; S.unitRanges = false; S.power = false;
    Draw.reset();
  }
});

// ---------- anti grief + undo history + join/leave ----------
Events.on(EventType.BlockBuildBeginEvent, e => {
  try{
    if(!e.breaking || e.unit == null || !e.unit.isPlayer() || e.team != Vars.player.team()) return;
    var pl = e.unit.getPlayer();
    if(pl == null || pl == Vars.player) return;
    var cb = e.tile.build;
    if(cb == null) return;
    var blk = (cb.current != null && cb.current != Blocks.air) ? cb.current : cb.previous;
    if(blk == null || blk == Blocks.air) return;
    var cfg = null;
    try{ if(cb.prevBuild != null && cb.prevBuild.size > 0) cfg = cb.prevBuild.first().config(); }catch(err2){}
    removed.push({x: e.tile.x, y: e.tile.y, rot: cb.rotation, block: blk, cfg: cfg, pid: pl.id, name: Strings.stripColors(pl.name), t: Time.millis()});
    if(removed.length > 500) removed.shift();
  }catch(err){ Log.err(err); }
});

Events.on(EventType.BlockBuildEndEvent, e => {
  try{
    if(e.unit == null) return;
    if(!e.breaking && e.unit == Vars.player.unit() && e.tile.build != null){
      undoStack.push({x: e.tile.x, y: e.tile.y});
      if(undoStack.length > 60) undoStack.shift();
    }
    if(!S.grief || !e.breaking || !e.unit.isPlayer() || e.team != Vars.player.team()) return;
    var p = e.unit.getPlayer();
    if(p == null || p == Vars.player) return;
    var now = Time.millis();
    var rec = tally[p.id];
    if(rec == null || now - rec.t0 > S.griefWindow){ rec = {t0: now, n: 0, warned: false}; tally[p.id] = rec; }
    rec.n++;
    if(rec.n >= S.griefLimit && !rec.warned){
      rec.warned = true;
      var msg = Strings.stripColors(p.name) + " deconstructed " + rec.n + " blocks in " + (S.griefWindow / 1000) + "s, near " + e.tile.x + "," + e.tile.y;
      griefLog.unshift(msg);
      if(griefLog.length > 12) griefLog.pop();
      chatAlert(msg);
    }
    if(S.griefRebuild && rec.warned && alive()){
      var theirs = removed.filter(r => r.pid == p.id);
      if(theirs.length > 0) queueRebuild(theirs);
    }
  }catch(err){ Log.err(err); }
});

Events.on(EventType.PlayerJoin, e => { toast(Strings.stripColors(e.player.name) + " joined"); });
Events.on(EventType.PlayerLeave, e => { toast(Strings.stripColors(e.player.name) + " left"); });
Events.on(EventType.WorldLoadEvent, e => {
  arrived = false; retreating = false; oreTile = null; matchTile = null; autoItem = null; oreCache = {}; ourPlan = null; undoStack = []; tally = {}; removed = [];
  S.goCore = false;
});

// ---------- building helpers ----------
function undoLast(n){
  var u = me();
  var c = 0;
  while(c < n && undoStack.length > 0){
    var r = undoStack.pop();
    u.addBuild(new BuildPlan(r.x, r.y));
    c++;
  }
  toast("Queued " + c + " deconstructions");
}

function upgradeNearby(){
  var u = me();
  var map = replaceMap();
  var n = 0;
  eachOf(Groups.build, b => {
    if(b.team != u.team || !u.within(b, Vars.buildingRange)) return;
    for(var i = 0; i < map.length; i++){
      if(b.block == map[i][0] && Build.validPlace(map[i][1], u.team, b.tileX(), b.tileY(), b.rotation)){
        u.addBuild(new BuildPlan(b.tileX(), b.tileY(), b.rotation, map[i][1]));
        n++;
      }
    }
  });
  toast("Queued " + n + " upgrades");
}

// ---------- UI ----------
function statusText(){
  var s = [];
  if(overridden() && (S.assist || S.mine || S.rebuild || S.goCore || retreating)) s.push("(paused)");
  if(S.goCore) s.push("to core");
  if(retreating) s.push("retreat");
  if(S.assist){
    var p = S.targetId == -1 ? null : Groups.player.getByID(S.targetId);
    s.push("help:" + (p == null ? "anyone" : Strings.stripColors(p.name)));
  }
  if(S.rebuild) s.push("rebuild");
  if(S.wantUnit != "") s.push("unit:" + S.wantUnit);
  if(S.mine) s.push("mine:" + MINE_CHOICES[S.mineIdx] + (mineInfo != "" ? " [" + mineInfo + "]" : ""));
  return s.length ? "[accent]" + s.join(" ") : "";
}

Log.info("Mobile Tools: script loaded");

Events.on(EventType.ClientLoadEvent, e => {
  try{
  var menu = new BaseDialog("Mobile Tools");
  menu.addCloseButton();
  var picker = new BaseDialog("Who to help?");
  picker.addCloseButton();
  var unitPicker = new BaseDialog("Auto-switch to which unit?");
  unitPicker.addCloseButton();

  function section(p, name){ p.add("[accent]" + name).left().padTop(12).row(); }
  function toggle(p, label, key){ p.check(label, S[key], mkBoolc(v => { S[key] = v; })).left().row(); }
  function btn(p, label, run){ p.button(label, mkRun(run)).growX().height(46).pad(2).row(); }

  function openPicker(){
    picker.cont.clear();
    picker.cont.pane(mkCons(p => {
      btn(p, "Anyone who is building", () => { S.targetId = -1; S.assist = true; picker.hide(); refresh(); });
      eachOf(Groups.player, q => {
        if(q == Vars.player) return;
        btn(p, Strings.stripColors(q.name), () => { S.targetId = q.id; S.assist = true; picker.hide(); refresh(); });
      });
    })).grow();
    picker.show();
  }

  function openUnitPicker(){
    unitPicker.cont.clear();
    unitPicker.cont.pane(mkCons(p => {
      btn(p, "None (don't switch)", () => { S.wantUnit = ""; unitPicker.hide(); refresh(); });
      eachOf(Vars.content.units(), t => {
        try{ if(t.internal || !t.unlockedNow()) return; }catch(err){}
        btn(p, t.localizedName, () => { S.wantUnit = t.name; lastSwitch = 0; unitPicker.hide(); refresh(); });
      });
    })).grow();
    unitPicker.show();
  }

  function refresh(){
    menu.cont.clear();
    menu.cont.pane(mkCons(p => {
      section(p, "Overlays");
      toggle(p, "My turret ranges", "turretRanges");
      toggle(p, "Enemy turret ranges", "enemyRanges");
      toggle(p, "Enemy unit ranges", "unitRanges");
      toggle(p, "Mark underpowered blocks", "power");

      section(p, "Help build");
      toggle(p, "Help builders", "assist");
      btn(p, "Choose player to help", openPicker);
      toggle(p, "Circle around the player", "circle");
      toggle(p, "Shoot where they shoot", "copyShoot");
      toggle(p, "Respawn at core if the player is very far", "farReset");
      toggle(p, "Go near core first if far away", "coreFirst");

      section(p, "Automation");
      toggle(p, "Auto mine", "mine");
      toggle(p, "Mine what the helped player mines", "mineMatch");
      toggle(p, "Circle around the ore while mining", "mineCircle");
      btn(p, "What can my unit mine here?", () => { Vars.ui.showInfoToast("This unit can mine: " + minableNow(), 5); });
      btn(p, "Mine item: " + MINE_CHOICES[S.mineIdx] + " (tap to change)", () => { S.mineIdx = (S.mineIdx + 1) % MINE_CHOICES.length; autoItem = null; refresh(); });
      toggle(p, "Rebuild destroyed blocks", "rebuild");
      toggle(p, "Retreat to core when low health", "retreat");

      section(p, "Building helpers");
      btn(p, "Undo last 10 builds", () => undoLast(10));
      btn(p, "Upgrade nearby (conveyor, walls, drills)", upgradeNearby);
      btn(p, "Cancel all build plans", () => { if(alive()) me().clearBuilding(); });

      section(p, "Unit");
      toggle(p, "Let me take over (pause automation while I touch)", "manualOverride");
      btn(p, "Reset MT button position", () => { holder.setPosition(8, Core.graphics.getHeight() * 0.5); Core.settings.put("mt-pos", holder.x + "," + holder.y); });
      btn(p, "Auto-switch unit: " + (S.wantUnit == "" ? "off" : S.wantUnit) + " (tap to change)", openUnitPicker);
      btn(p, "Fly to closest core", () => { S.goCore = true; });
      btn(p, "Stop all automation", () => { S.assist = false; S.mine = false; S.rebuild = false; S.goCore = false; refresh(); });
      btn(p, "Respawn", () => {
        try{ Call.unitClear(Vars.player); }catch(err){ Vars.player.clearUnit(); }
      });

      section(p, "Anti grief");
      toggle(p, "Warn on mass deconstruction (in chat)", "grief");
      toggle(p, "Also post warnings in public chat", "griefPublic");
      toggle(p, "Auto-rebuild what flagged griefers remove", "griefRebuild");
      btn(p, "Rebuild everything others removed (" + removed.length + ")", () => {
        if(alive()) toast("Queued " + queueRebuild(removed.slice()) + " rebuilds");
        refresh();
      });
      var byPlayer = {};
      for(var k = 0; k < removed.length; k++){
        var rr = removed[k];
        if(byPlayer[rr.pid] == null) byPlayer[rr.pid] = {name: rr.name, list: []};
        byPlayer[rr.pid].list.push(rr);
      }
      for(var key in byPlayer){
        (function(g){
          btn(p, "Rebuild " + g.list.length + " removed by " + g.name, () => {
            if(alive()) toast("Queued " + queueRebuild(g.list.slice()) + " rebuilds");
            refresh();
          });
        })(byPlayer[key]);
      }
      if(griefLog.length == 0) p.add("No warnings yet").left().row();
      for(var j = 0; j < griefLog.length; j++) p.add(griefLog[j]).left().wrap().growX().row();
    })).grow();
  }

  menu.shown(mkRun(() => refresh()));

  var holder = new Packages.arc.scene.ui.layout.Table();
  var dragging = false, moved = false, offX = 0, offY = 0, downX = 0, downY = 0;
  holder.button("MT", mkRun(() => { if(!moved){ refresh(); menu.show(); } })).size(56, 56);
  holder.row();
  holder.label(mkProv(() => statusText())).left();
  holder.pack();
  var px = 8, py = Core.graphics.getHeight() * 0.5;
  var saved = String(Core.settings.getString("mt-pos", ""));
  if(saved.indexOf(",") > 0){
    var parts = saved.split(",");
    px = parseFloat(parts[0]); py = parseFloat(parts[1]);
  }
  holder.setPosition(px, py);
  holder.update(mkRun(() => {
    holder.visible = Vars.state.isGame() && Vars.ui.hudfrag.shown;
    holder.pack();
    var mx = Core.input.mouseX(), my = Core.input.mouseY();
    if(Core.input.isTouched()){
      if(!dragging && Core.input.justTouched() && holder.visible && mx >= holder.x && mx <= holder.x + holder.getWidth() && my >= holder.y && my <= holder.y + holder.getHeight()){
        dragging = true; moved = false; offX = mx - holder.x; offY = my - holder.y; downX = mx; downY = my;
      }
      if(dragging){
        if(Math.abs(mx - downX) + Math.abs(my - downY) > 20) moved = true;
        if(moved){
          holder.setPosition(
            Mathf.clamp(mx - offX, 0, Core.graphics.getWidth() - holder.getWidth()),
            Mathf.clamp(my - offY, 0, Core.graphics.getHeight() - holder.getHeight()));
        }
      }
    }else if(dragging){
      dragging = false;
      Core.settings.put("mt-pos", holder.x + "," + holder.y);
    }
  }));
  Vars.ui.hudGroup.addChild(holder);
  Log.info("Mobile Tools: menu ready");
  }catch(err){
    Log.err(err);
    Vars.ui.showErrorMessage("Mobile Tools menu failed: " + err);
  }
});
