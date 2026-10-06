// Mobile Tools v3 - client-side helper mod for Mindustry (build 146+)
// Quick bar on the HUD (drag it anywhere) + the full menu behind the "MT" button.

var S = {
  // view
  turretRanges: false, enemyRanges: false, unitRanges: false, power: false,
  // help builders
  assist: false, targetId: -1, circle: true, orbit: 6, copyShoot: true, farReset: true, farTiles: 100, skipModUsers: true,
  // mining
  mine: false, mineMatch: true, mineCircle: true, mineOrbit: 3, mineIdx: 0,
  // building
  rebuild: false, buildNav: true,
  // unit
  heal: false, healAt: 35, goCore: false, camFollow: false, speedIdx: 0, wantUnit: "", manualOverride: false,
  // anti grief
  grief: true, griefPublic: false, griefRebuild: false, griefAll: false, griefLimit: 5, griefWindow: 8000,
  // misc
  markName: false, announce: true, barMin: false, tab: 0
};

var MARK = "\u200b\u200c\u200b";      // optional invisible name tag
var PING = "\u200b\u200d\u200c\u200d";   // invisible chat ping that other Mobile Tools users recognise      // invisible tag added to your name so other Mobile Tools users can see you
var SPEEDS = [1, 1.5, 2, 3];
var HEAL_AT = [25, 35, 50, 70];
var MINE_ITEMS = ["copper", "lead", "sand", "coal", "titanium", "beryllium", "tungsten"];
var MINE_CHOICES = ["auto"].concat(MINE_ITEMS);
var WALL_ITEMS = {beryllium: true, tungsten: true};

var healing = false, healInfo = "", lastManual = 0;
var holdV = new Packages.arc.math.geom.Vec2(), holdOn = false, holdUnit = null, holdMine = null, holdMineOn = false;
var orbitAngle = 0, lastReset = 0, shootSrc = null, ourPlan = null;
var matchTile = null, matchItem = null, matchTime = 0;
var autoItem = null, curItem = null, curItemAt = 0, mineInfo = "", infoAt = 0;
var fullSince = 0, lastTransfer = 0, blockedItem = null, blockedUntil = 0;
var oreTile = null, oreItem = null, oreRetryAt = 0, oreCache = {}, lastScan = 0;
var undoStack = [], griefLog = [], tally = {}, removed = [], flagged = {}, ignored = {};
var lastSwitch = 0, lastRebuildToast = 0, speedBase = {}, speedType = null, speedAt = 0;
var statusCache = "", statusAt = 0, powerBad = [], powerAt = 0;
var modSeen = {}, lastPing = 0, pingDue = 0, detectAt = 0, infoCache = "", infoAt2 = 0, worldStart = Time.millis();

// Explicit wrappers: Mindustry's Rhino can't pick between overloads when given a bare function
function mkCons(f){ return new Packages.arc.func.Cons({get: f}); }
function mkRun(f){ return new java.lang.Runnable({run: f}); }
function mkBoolc(f){ return new Packages.arc.func.Boolc({get: f}); }
function mkProv(f){ return new Packages.arc.func.Prov({get: f}); }
function eachOf(group, f){ group.each(mkCons(f)); }

function toast(msg){ Vars.ui.showInfoToast(msg, 3); }
function me(){ return Vars.player.unit(); }
function alive(){ return Vars.state.isGame() && !Vars.player.dead(); }
function sameTeam(p){ return p.team() == Vars.player.team(); }
function dname(p){ return String(Strings.stripColors(p.name)).split(MARK).join(""); }
function isModUser(p){
  return modSeen[p.id] === true || String(p.name).indexOf(MARK) >= 0 || ignored[dname(p)] === true;
}
function saveMarked(){
  var out = [];
  for(var k in ignored) if(ignored[k] === true) out.push(k);
  Core.settings.put("mt-marked", out.join("\n"));
}

function applyNameMark(){
  try{
    var n = String(Core.settings.getString("name", ""));
    var base = n.split(MARK).join("");
    if(base.length == 0) return;
    var want = S.markName ? base + MARK : base;
    if(want != n){
      Core.settings.put("name", want);
      try{ Vars.player.name = want; }catch(err){}
    }
  }catch(err){ Log.err(err); }
}

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

function replaceMap(){
  return [
    [Blocks.conveyor, Blocks.titaniumConveyor],
    [Blocks.copperWall, Blocks.titaniumWall],
    [Blocks.copperWallLarge, Blocks.titaniumWallLarge],
    [Blocks.mechanicalDrill, Blocks.pneumaticDrill]
  ];
}

// ---------- speed boost ----------
function applySpeed(){
  try{
    var mult = SPEEDS[S.speedIdx];
    var t = alive() ? me().type : null;
    if(speedType != null && speedType != t){
      var b = speedBase[speedType.name];
      if(b != null) speedType.speed = b;
    }
    speedType = t;
    if(t == null) return;
    if(speedBase[t.name] == null) speedBase[t.name] = t.speed;
    t.speed = speedBase[t.name] * mult;
  }catch(err){}
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

// ---------- help builders ----------
function assistTick(u, core){
  if(!u.canBuild()) return false;
  var p = null;
  if(S.targetId != -1){
    p = Groups.player.getByID(S.targetId);
    if(p == null){ S.targetId = -1; toast("Target left, helping anyone"); }
    else if(!sameTeam(p)) return false; // only help players on your team
  }
  if(p == null){
    var best = 1e9;
    eachOf(Groups.player, q => {
      if(q == Vars.player || q.dead() || !sameTeam(q)) return;
      if(S.skipModUsers && isModUser(q)) return; // don't chase other Mobile Tools users
      var qu = q.unit();
      if(!qu.activelyBuilding()) return;
      var d = u.dst(qu);
      if(d < best){ best = d; p = q; }
    });
  }
  if(p == null || p.dead()) return false;

  var tu = p.unit();
  shootSrc = tu;

  // helped player is very far away: respawn at the closest core if that is much nearer to them
  if(S.farReset && core != null && Time.millis() - lastReset > 15000){
    var dFar = Mathf.dst(u.x, u.y, tu.x, tu.y);
    if(dFar > S.farTiles * 8 && Mathf.dst(core.x, core.y, tu.x, tu.y) < dFar - 160){
      lastReset = Time.millis();
      toast("Resetting to core: " + dname(p) + " is far away");
      try{ Call.unitClear(Vars.player); }catch(err){ Vars.player.clearUnit(); }
      return true;
    }
  }

  var plan = tu.activelyBuilding() ? tu.buildPlan() : null;
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

// ---------- build planner: fly to what you queued ----------
function plannerTick(u){
  if(!u.canBuild()) return false;
  var plan = u.buildPlan();
  if(plan == null) return false;
  if(ourPlan != null && plan.x == ourPlan.x && plan.y == ourPlan.y) return false; // rebuild handles its own
  if(manualInput()) return false; // you are steering
  u.updateBuilding = true;
  var px = plan.drawx(), py = plan.drawy();
  if(!u.within(px, py, Vars.buildingRange - 40)) moveToward(u, px, py, Vars.buildingRange - 70);
  return true;
}

// ---------- rebuild destroyed / removed blocks ----------
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
  if(ourPlan == null || cur.x != ourPlan.x || cur.y != ourPlan.y) return false;
  u.updateBuilding = true;
  moveToward(u, cur.drawx(), cur.drawy(), Vars.buildingRange - 60);
  return true;
}

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

// ---------- heal: go to a repair point (or the core) when low on health ----------
function healTick(u, core){
  if(u.health < u.maxHealth * (S.healAt / 100)) healing = true;
  else if(u.health > u.maxHealth * 0.9) healing = false;
  if(!healing) return false;
  var rp = null;
  try{ rp = Geometry.findClosest(u.x, u.y, Vars.indexer.getFlagged(u.team, BlockFlag.repair)); }catch(err){}
  var tx, ty;
  if(rp != null){ tx = rp.x; ty = rp.y; healInfo = "repair point"; }
  else if(core != null){ tx = core.x; ty = core.y; healInfo = "core (no repair point)"; }
  else return false;
  moveToward(u, tx, ty, 24);
  return true;
}

// ---------- auto mine ----------
function minerToCopy(u){
  var pl = S.targetId != -1 ? Groups.player.getByID(S.targetId) : null;
  if(pl != null && !pl.dead() && sameTeam(pl) && pl.unit().mineTile != null) return pl.unit();
  if(S.targetId != -1) return null;
  var best = null, bd = 1e9;
  eachOf(Groups.player, q => {
    if(q == Vars.player || q.dead() || !sameTeam(q)) return;
    if(S.skipModUsers && isModUser(q)) return;
    var qu = q.unit();
    if(qu.mineTile == null) return;
    var d = u.dst(qu);
    if(d < bd){ bd = d; best = qu; }
  });
  return best;
}

function matching(){ return S.mineMatch && matchTile != null && Time.millis() - matchTime < 15000; }
function isBlocked(i){ return i == blockedItem && Time.millis() < blockedUntil; }

// what this unit would get from mining this tile (floor ore or wall ore), as the game itself decides
function mineResult(u, t){
  if(t == null) return null;
  try{ return u.getMineResult(t); }catch(err){}
  if(t.block() == Blocks.air) return t.drop();
  return (u.type.mineWalls === true) ? t.wallDrop() : null;
}
function oreOk(t, item){ return t != null && mineResult(me(), t) == item; }

// wall ores (beryllium, tungsten): look around a point
function scanWallOre(u, item, ox, oy){
  var cx = Math.floor(ox / 8), cy = Math.floor(oy / 8), R = 32;
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

function findOre(u, item, ox, oy, fromCore){
  var t = null;
  try{
    t = fromCore ? Vars.indexer.findClosestOre(ox, oy, item) : Vars.indexer.findClosestOre(u, item);
  }catch(err){}
  if(t != null && mineResult(u, t) == item) return t;
  if(u.type.mineWalls === true && WALL_ITEMS[item.name] && Time.millis() - lastScan > 4000){
    lastScan = Time.millis();
    return scanWallOre(u, item, ox, oy);
  }
  return null;
}

function hasOreFor(u, item){
  var key = u.type.name + ":" + item.name;
  var now = Time.millis();
  var c = oreCache[key];
  if(c != null && now - c.t < 4000) return c.v;
  var v = false;
  if(u.type.mineFloor !== false){ try{ v = Vars.indexer.hasOre(item); }catch(err){} }
  if(!v && u.type.mineWalls === true && WALL_ITEMS[item.name]) v = scanWallOre(u, item, u.x, u.y) != null;
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
  var want = MINE_CHOICES[S.mineIdx];
  if(want == "auto"){
    // keep mining what we are already carrying / already chose
    if(u.stack.amount > 0 && u.stack.item != null && u.canMine(u.stack.item) && !isBlocked(u.stack.item)){ autoItem = u.stack.item; return autoItem; }
    if(autoItem != null && u.canMine(autoItem) && hasOreFor(u, autoItem) && !isBlocked(autoItem)) return autoItem;
  }else{
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

function pickItem(u, core){
  var now = Time.millis();
  if(now - curItemAt < 400) return curItem;
  curItem = chooseItem(u, core);
  curItemAt = now;
  return curItem;
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
  var item = pickItem(u, core);
  if(item == null) return false;
  var now = Time.millis();
  var upd = now - infoAt > 300;
  if(upd) infoAt = now;
  var cap = u.type.itemCapacity;
  // units that cannot carry anything (e.g. Erekir core units) deliver straight into the core while it is close
  var direct = cap <= 0;
  var full = !direct && (u.stack.amount >= cap || (u.stack.amount > 0 && u.stack.item != item));
  if(full){
    u.mineTile = null;
    var held = u.stack.item;
    if(upd) mineInfo = "deliver " + (held != null ? held.name : "?") + " " + u.stack.amount + "/" + cap;
    if(u.within(core, 20)){
      if(fullSince == 0) fullSince = now;
      if(upd) mineInfo += " core " + (held != null ? core.items.get(held) : 0) + "/" + core.storageCapacity;
      if(now - lastTransfer > 300){
        Call.transferInventory(Vars.player, core);
        lastTransfer = now;
        autoItem = null;
        curItemAt = 0;
      }
      if(now - fullSince > 3000){
        // the core is not taking it: skip this item for a minute and clear the stack
        blockedItem = held; blockedUntil = now + 60000;
        try{ Call.dropItem(Vars.player, 0); }catch(err){}
        u.clearItem();
        fullSince = 0;
        curItemAt = 0;
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
    oreTile = null;
    if(now >= oreRetryAt){
      oreTile = findOre(u, item, direct ? core.x : u.x, direct ? core.y : u.y, direct);
      oreItem = item;
      if(oreTile == null) oreRetryAt = now + 1500;
    }
  }
  if(oreTile == null){ if(upd) mineInfo = item.name + " no ore found"; return false; }
  var ox = oreTile.worldx(), oy = oreTile.worldy();
  var range = u.type.mineRange;

  if(direct){
    var dx = ox - core.x, dy = oy - core.y, dd = Math.sqrt(dx * dx + dy * dy);
    var stand = Math.max(0, Math.min(dd - (range - 30), Vars.mineTransferRange - 30));
    if(dd - stand > range - 10){
      if(upd) mineInfo = item.name + " ore is too far from the core";
      u.mineTile = null;
      return false;
    }
    var sx = dd > 0 ? core.x + dx / dd * stand : core.x, sy = dd > 0 ? core.y + dy / dd * stand : core.y;
    if(u.within(ox, oy, range - 10) && u.within(core, Vars.mineTransferRange - 10)){
      u.mineTile = oreTile;
      if(upd) mineInfo = item.name + " mining (direct to core)";
    }else{
      u.mineTile = null;
      moveToward(u, sx, sy, 8);
      if(upd) mineInfo = item.name + " going";
    }
    return true;
  }

  var inRange = u.within(ox, oy, range - 10);
  if(upd) mineInfo = item.name + " " + u.stack.amount + "/" + cap + (inRange ? " mining " : " going ") + Math.round(Mathf.dst(u.x, u.y, ox, oy) / 8) + "t";
  if(inRange){
    u.mineTile = oreTile;
    if(S.mineCircle && u.type.flying) orbit(u, {x: ox, y: oy}, S.mineOrbit);
  }else{
    u.mineTile = null;
    moveToward(u, ox, oy, range - 30);
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
  lastSwitch = now;
  if(best == null) return;
  Call.unitControl(Vars.player, best);
  toast("Switching to " + S.wantUnit);
}

// ---------- finding other Mobile Tools users ----------
function detectTick(){
  var now = Time.millis();
  if(now - detectAt < 500) return;
  detectAt = now;
  eachOf(Groups.player, q => {
    if(q == Vars.player) return;
    try{ if(String(q.lastText).indexOf(PING) >= 0) modSeen[q.id] = true; }catch(err){}
  });
  try{
    var msgs = Packages.arc.util.Reflect.get(Vars.ui.chatfrag, "messages");
    for(var i = msgs.size - 1; i >= 0; i--){
      var line = String(msgs.get(i));
      if(line.indexOf(PING) >= 0) msgs.remove(line);
    }
  }catch(err){}
  if(S.announce && pingDue > 0 && now >= pingDue && Vars.net.active()){
    pingDue = 0;
    lastPing = now;
    try{ Call.sendChatMessage(PING); }catch(err){}
  }
}

// ---------- brain ----------
function runBrain(u, core){
  if(S.goCore){
    if(core == null){ S.goCore = false; return false; }
    if(moveToward(u, core.x, core.y, 40)) S.goCore = false;
    return true;
  }
  if(S.heal && healTick(u, core)) return true;
  if(S.assist && assistTick(u, core)) return true;
  if(S.rebuild && rebuildTick(u)) return true;
  if(S.buildNav && plannerTick(u)) return true;
  if(S.mine) return mineTick(u, core);
  return false;
}

Events.run(EventType.Trigger.update, () => {
  holdOn = false;
  holdMineOn = false;
  if(Vars.state.isGame()){ try{ detectTick(); }catch(err){} }
  if(!alive()) return;
  try{
    var now = Time.millis();
    if(now - speedAt > 500){ speedAt = now; applySpeed(); }
    if(S.camFollow){ var cu = me(); Core.camera.position.set(cu.x, cu.y); }
    unitSwitchTick();
    if(S.manualOverride && manualInput()) lastManual = now;
    if(overridden()) return;
    var u = me();
    if(runBrain(u, u.closestCore())){
      holdV.set(u.vel); holdOn = true; holdUnit = u;
      holdMine = u.mineTile; holdMineOn = S.mine;
    }
  }catch(err){
    Log.err(err);
    holdOn = false;
    S.assist = false; S.mine = false; S.rebuild = false; S.heal = false; S.goCore = false; S.buildNav = false;
    toast("[scarlet]Mobile Tools error, automation turned off");
  }
});

// ---------- draw hook: runs after the game's own input each frame ----------
Events.run(EventType.Trigger.draw, () => {
  try{
    // while automation is in charge, undo movement/mining resets the normal controls added
    if(holdOn && alive() && me() == holdUnit) holdUnit.vel.set(holdV);
    if(holdMineOn && alive() && me() == holdUnit) holdUnit.mineTile = holdMine;
    // copy the helped player's shooting and aim
    if(S.copyShoot && shootSrc != null && alive() && shootSrc.isShooting){
      var mu = me();
      try{ mu.aim(shootSrc.aimX, shootSrc.aimY); }catch(err2){ mu.aimX = shootSrc.aimX; mu.aimY = shootSrc.aimY; }
      mu.isShooting = true;
      Vars.player.shooting = true;
      Vars.player.mouseX = shootSrc.aimX;
      Vars.player.mouseY = shootSrc.aimY;
    }
  }catch(err){}
  holdOn = false; holdMineOn = false; shootSrc = null;

  if(!Vars.state.isGame()) return;
  if(!(S.turretRanges || S.enemyRanges || S.unitRanges || S.power)) return;
  try{
    var mine = Vars.player.team();
    Core.camera.bounds(Tmp.r1);
    Tmp.r1.grow(320);
    Draw.z(Layer.overlayUI);
    Lines.stroke(1.2);
    if(S.turretRanges){
      eachOf(Vars.indexer.getFlagged(mine, BlockFlag.turret), b => {
        if(!Tmp.r1.contains(b.x, b.y)) return;
        Draw.color(b.team.color, 0.6);
        Lines.circle(b.x, b.y, b.block.range);
      });
    }
    if(S.enemyRanges){
      eachOf(Vars.indexer.getEnemy(mine, BlockFlag.turret), b => {
        if(!Tmp.r1.contains(b.x, b.y)) return;
        Draw.color(b.team.color, 0.6);
        Lines.circle(b.x, b.y, b.block.range);
      });
    }
    if(S.power){
      var now = Time.millis();
      if(now - powerAt > 600){
        powerAt = now;
        var found = [];
        var rad = Math.max(Core.camera.width, Core.camera.height) * 0.7;
        Vars.indexer.allBuildings(Core.camera.position.x, Core.camera.position.y, rad, mkCons(b => {
          if(b.team == mine && b.power != null && b.block.consumesPower && b.shouldConsume() && b.power.status < 0.5) found.push({x: b.x, y: b.y, r: b.block.size * 4 + 3});
        }));
        powerBad = found;
      }
      Draw.color(Color.scarlet, 0.9);
      for(var i = 0; i < powerBad.length; i++) Lines.circle(powerBad[i].x, powerBad[i].y, powerBad[i].r);
    }
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

// ---------- anti grief ----------
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
    removed.push({x: e.tile.x, y: e.tile.y, rot: cb.rotation, block: blk, cfg: cfg, pid: pl.id, name: dname(pl), t: Time.millis()});
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
    if(!e.breaking || !e.unit.isPlayer() || e.team != Vars.player.team()) return;
    var p = e.unit.getPlayer();
    if(p == null || p == Vars.player) return;
    var now = Time.millis();
    if(S.grief){
      var rec = tally[p.id];
      if(rec == null || now - rec.t0 > S.griefWindow){ rec = {t0: now, n: 0}; tally[p.id] = rec; }
      rec.n++;
      if(rec.n >= S.griefLimit && !flagged[p.id]){
        flagged[p.id] = dname(p); // stays watched for the rest of the session
        var msg = dname(p) + " deconstructed " + rec.n + " blocks in " + (S.griefWindow / 1000) + "s, near " + e.tile.x + "," + e.tile.y;
        griefLog.unshift(msg);
        if(griefLog.length > 12) griefLog.pop();
        chatAlert(msg);
      }
    }
    if(S.griefRebuild && (S.griefAll || flagged[p.id]) && alive()){
      var theirs = removed.filter(r => r.pid == p.id);
      if(theirs.length > 0){
        var n = queueRebuild(theirs);
        if(n > 0 && now - lastRebuildToast > 3000){
          lastRebuildToast = now;
          toast("Rebuilding blocks removed by " + dname(p));
        }
      }
    }
  }catch(err){ Log.err(err); }
});

Events.on(EventType.PlayerJoin, e => {
  toast(dname(e.player) + " joined");
  var now = Time.millis();
  if(S.announce && now - lastPing > 20000) pingDue = now + 2500;
});
Events.on(EventType.PlayerLeave, e => { toast(dname(e.player) + " left"); });
Events.on(EventType.WorldLoadEvent, e => {
  healing = false; oreTile = null; matchTile = null; autoItem = null; curItemAt = 0; oreCache = {}; ourPlan = null;
  undoStack = []; tally = {}; removed = []; flagged = {}; modSeen = {};
  worldStart = Time.millis();
  if(S.announce) pingDue = Time.millis() + 6000;
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
  Vars.indexer.allBuildings(u.x, u.y, Vars.buildingRange, mkCons(b => {
    if(b.team != u.team) return;
    for(var i = 0; i < map.length; i++){
      if(b.block == map[i][0] && Build.validPlace(map[i][1], u.team, b.tileX(), b.tileY(), b.rotation)){
        u.addBuild(new BuildPlan(b.tileX(), b.tileY(), b.rotation, map[i][1]));
        n++;
      }
    }
  }));
  toast("Queued " + n + " upgrades");
}

// ---------- status line (cached so it costs almost nothing) ----------
function statusText(){
  var now = Time.millis();
  if(now - statusAt < 300) return statusCache;
  statusAt = now;
  var s = [];
  if(overridden() && (S.assist || S.mine || S.rebuild || S.goCore || healing)) s.push("(paused)");
  if(S.goCore) s.push("to core");
  if(healing) s.push("healing:" + healInfo);
  if(S.assist){
    var p = S.targetId == -1 ? null : Groups.player.getByID(S.targetId);
    s.push("help:" + (p == null ? "anyone" : dname(p) + (!sameTeam(p) ? " (other team, not helping)" : "")));
  }
  if(S.rebuild) s.push("rebuild" + (alive() ? "(" + me().team.data().plans.size + ")" : ""));
  if(S.wantUnit != "") s.push("unit:" + S.wantUnit);
  if(S.mine) s.push("mine:" + MINE_CHOICES[S.mineIdx] + (mineInfo != "" ? " [" + mineInfo + "]" : ""));
  statusCache = s.length ? "[accent]" + s.join(" ") : "";
  return statusCache;
}

function infoText(){
  var now = Time.millis();
  if(now - infoAt2 < 500) return infoCache;
  infoAt2 = now;
  var sec = Math.max(0, Math.floor((now - worldStart) / 1000));
  var mm = Math.floor(sec / 60), ss = sec % 60;
  infoCache = Core.graphics.getFramesPerSecond() + " fps   " + mm + ":" + (ss < 10 ? "0" : "") + ss;
  return infoCache;
}

// ---------- UI ----------
Log.info("Mobile Tools: script loaded");
S.markName = Core.settings.getBool("mt-mark", false);
S.announce = Core.settings.getBool("mt-announce", true);
S.barMin = Core.settings.getBool("mt-min", false);
try{
  var mk = String(Core.settings.getString("mt-marked", "")).split("\n");
  for(var mi = 0; mi < mk.length; mi++) if(mk[mi].length > 0) ignored[mk[mi]] = true;
}catch(err){}

Events.on(EventType.ClientLoadEvent, e => {
  try{
  applyNameMark();

  var menu = new BaseDialog("Mobile Tools");
  menu.addCloseButton();
  var picker = new BaseDialog("Who to help?");
  picker.addCloseButton();
  var unitPicker = new BaseDialog("Auto-switch to which unit?");
  unitPicker.addCloseButton();
  var rebuildPicker = new BaseDialog("Rebuild blocks removed by...");
  rebuildPicker.addCloseButton();

  var TOGST = null;
  try{ TOGST = Styles.togglet; }catch(err){}
  var dragging = false, moved = false, offX = 0, offY = 0, downX = 0, downY = 0;
  var holder = new Packages.arc.scene.ui.layout.Table();

  function section(p, name, note){
    p.add("[accent]" + name).left().padTop(12).row();
    if(note) p.add("[lightgray]" + note).left().wrap().growX().row();
  }
  function toggle(p, label, key){ p.check(label, S[key], mkBoolc(v => { S[key] = v; })).left().row(); }
  function btn(p, label, run){ p.button(label, mkRun(run)).growX().height(46).pad(2).row(); }

  var TOGI = null, CLEARI = null, BARBG = null;
  try{ TOGI = Styles.clearTogglei; }catch(err){}
  try{ CLEARI = Styles.cleari; }catch(err){}
  try{ BARBG = Styles.black6; }catch(err){}
  function ic(name){ try{ var d = Icon[name]; return d == null ? null : d; }catch(err){ return null; } }

  // small icon toggle for the quick bar (falls back to a text button if the icon is missing)
  function barToggle(t, iconName, label, key){
    var run = mkRun(() => { if(!moved) S[key] = !S[key]; });
    var d = ic(iconName);
    var c;
    if(d != null && TOGI != null){ c = t.button(d, TOGI, run); c.size(38, 38).pad(1); }
    else if(TOGST != null){ c = t.button(label, TOGST, run); c.size(58, 38).pad(1); }
    else { c = t.button(label, run); c.size(58, 38).pad(1); }
    try{ var b = c.get(); b.update(mkRun(() => { b.setChecked(S[key]); })); }catch(err){}
    return c;
  }
  function barButton(t, iconName, label, fn){
    var run = mkRun(() => { if(!moved) fn(); });
    var d = iconName == null ? null : ic(iconName);
    var c;
    if(d != null && CLEARI != null){ c = t.button(d, CLEARI, run); c.size(38, 38).pad(1); }
    else { c = t.button(label, run); c.size(iconName == null ? 38 : 58, 38).pad(1); }
    return c;
  }
  function smallLabel(c){ try{ c.get().setFontScale(0.8); }catch(err){} return c; }

  function buildBar(){
    holder.clear();
    try{ if(BARBG != null) holder.background(BARBG); }catch(err){}
    if(S.barMin){
      barButton(holder, null, "+", () => { S.barMin = false; Core.settings.put("mt-min", false); Core.app.post(mkRun(() => buildBar())); });
      smallLabel(holder.label(mkProv(() => statusText())).left().padLeft(4).width(220).wrap());
    }else{
      barButton(holder, "menu", "MT", () => { refresh(); menu.show(); });
      barToggle(holder, "players", "Help", "assist");
      barToggle(holder, "pick", "Mine", "mine");
      barToggle(holder, "tools", "Plan", "buildNav");
      barToggle(holder, "refresh", "Rebuild", "rebuild");
      barToggle(holder, "add", "Heal", "heal");
      barToggle(holder, "eye", "Me", "camFollow");
      barButton(holder, "cancel", "Stop", () => { S.assist = false; S.mine = false; S.rebuild = false; S.goCore = false; S.heal = false; });
      barButton(holder, null, "-", () => { S.barMin = true; Core.settings.put("mt-min", true); Core.app.post(mkRun(() => buildBar())); });
      holder.row();
      smallLabel(holder.label(mkProv(() => statusText())).colspan(9).left().width(340).wrap());
      holder.row();
      smallLabel(holder.label(mkProv(() => infoText())).colspan(9).left());
    }
    holder.pack();
  }

  // ----- pickers -----
  function openPicker(){
    picker.cont.clear();
    picker.cont.pane(mkCons(p => {
      btn(p, "Anyone who is building", () => { S.targetId = -1; S.assist = true; picker.hide(); refresh(); });
      eachOf(Groups.player, q => {
        if(q == Vars.player || !sameTeam(q)) return;
        btn(p, dname(q) + (isModUser(q) ? "  [lightgray](Mobile Tools)" : ""), () => { S.targetId = q.id; S.assist = true; picker.hide(); refresh(); });
      });
    })).grow();
    picker.show();
  }

  function openRebuildPicker(){
    rebuildPicker.cont.clear();
    rebuildPicker.cont.pane(mkCons(p => {
      eachOf(Groups.player, q => {
        if(q == Vars.player || !sameTeam(q)) return;
        var nm = dname(q);
        btn(p, nm, () => {
          flagged[q.id] = nm;
          S.griefRebuild = true;
          var mine = removed.filter(r => r.pid == q.id);
          var n = (alive() && mine.length > 0) ? queueRebuild(mine) : 0;
          toast("Watching " + nm + (n > 0 ? ", queued " + n + " rebuilds" : ""));
          rebuildPicker.hide();
          refresh();
        });
      });
    })).grow();
    rebuildPicker.show();
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

  // ----- tabs -----
  function tabHelp(p){
    section(p, "Help builders", "Copies what another player is building and builds it with them. Only players on your team.");
    toggle(p, "Help builders", "assist");
    var tp = S.targetId == -1 ? null : Groups.player.getByID(S.targetId);
    btn(p, "Helping: " + (tp == null ? "anyone who is building" : dname(tp)) + " (tap to change)", openPicker);
    toggle(p, "Circle around the player", "circle");
    toggle(p, "Shoot where they shoot", "copyShoot");
    toggle(p, "Respawn at core if the player is very far", "farReset");
    toggle(p, "Don't help other Mobile Tools users (when helping anyone)", "skipModUsers");
  }

  function tabMine(p){
    section(p, "Auto mine", "Mines ore and delivers it. Wall ores (Erekir units) work too.");
    toggle(p, "Auto mine", "mine");
    toggle(p, "Mine what the helped player mines", "mineMatch");
    toggle(p, "Circle around the ore while mining", "mineCircle");
    btn(p, "Mine item: " + MINE_CHOICES[S.mineIdx] + " (tap to change)", () => { S.mineIdx = (S.mineIdx + 1) % MINE_CHOICES.length; autoItem = null; curItemAt = 0; refresh(); });
    btn(p, "What can my unit mine here?", () => { Vars.ui.showInfoToast("This unit can mine: " + minableNow(), 5); });
  }

  function tabBuild(p){
    section(p, "Build planner", "Queue blocks as usual and your unit flies to them by itself.");
    toggle(p, "Fly to my build plans", "buildNav");
    toggle(p, "Rebuild destroyed blocks", "rebuild");
    section(p, "Tools");
    btn(p, "Undo last 10 builds", () => { if(alive()) undoLast(10); });
    btn(p, "Upgrade nearby (conveyor, walls, drills)", () => { if(alive()) upgradeNearby(); });
    btn(p, "Cancel all build plans", () => { if(alive()) me().clearBuilding(); });
  }

  function tabUnit(p){
    section(p, "Health", "Flies to the nearest repair point (or your core) when health is low.");
    toggle(p, "Heal when low health", "heal");
    btn(p, "Heal below " + S.healAt + "% health (tap to change)", () => { S.healAt = HEAL_AT[(HEAL_AT.indexOf(S.healAt) + 1) % HEAL_AT.length]; refresh(); });
    section(p, "Speed", "Makes your unit faster. Servers may pull you back, it works best offline.");
    btn(p, "Speed: " + SPEEDS[S.speedIdx] + "x (tap to change)", () => { S.speedIdx = (S.speedIdx + 1) % SPEEDS.length; speedAt = 0; refresh(); });
    section(p, "Camera");
    toggle(p, "Follow myself (lock camera to my unit)", "camFollow");
    btn(p, "Center camera on me once", () => { if(alive()) Core.camera.position.set(me().x, me().y); });
    section(p, "Unit");
    btn(p, "Auto-switch unit: " + (S.wantUnit == "" ? "off" : S.wantUnit) + " (tap to change)", openUnitPicker);
    btn(p, "Fly to closest core", () => { S.goCore = true; });
    btn(p, "Respawn", () => { try{ Call.unitClear(Vars.player); }catch(err){ Vars.player.clearUnit(); } });
    toggle(p, "Let me take over (pause automation while I touch)", "manualOverride");
    btn(p, "Reset quick bar position", () => { holder.setPosition(8, Core.graphics.getHeight() * 0.5); Core.settings.put("mt-pos", holder.x + "," + holder.y); });
  }

  function tabGuard(p){
    section(p, "Anti grief", "Warns you in chat and can rebuild what other players remove.");
    toggle(p, "Warn on mass deconstruction (in chat)", "grief");
    toggle(p, "Also post warnings in public chat", "griefPublic");
    toggle(p, "Auto-rebuild what watched players remove", "griefRebuild");
    toggle(p, "...and rebuild what ANY other player removes", "griefAll");
    btn(p, "Choose player to rebuild for", openRebuildPicker);
    for(var wk in flagged){
      (function(pid){
        btn(p, "Watching: " + flagged[pid] + " (tap to stop)", () => { delete flagged[pid]; refresh(); });
      })(wk);
    }
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
      (function(g, pid){
        btn(p, "Rebuild " + g.list.length + " removed by " + g.name + " + watch them", () => {
          flagged[pid] = g.name;
          if(alive()) toast("Queued " + queueRebuild(g.list.slice()) + " rebuilds");
          refresh();
        });
      })(byPlayer[key], key);
    }
    if(griefLog.length == 0) p.add("No warnings yet").left().row();
    for(var j = 0; j < griefLog.length; j++) p.add(griefLog[j]).left().wrap().growX().row();
  }

  function tabView(p){
    section(p, "Overlays");
    toggle(p, "My turret ranges", "turretRanges");
    toggle(p, "Enemy turret ranges", "enemyRanges");
    toggle(p, "Enemy unit ranges", "unitRanges");
    toggle(p, "Mark underpowered blocks", "power");
  }

  function tabUsers(p){
    section(p, "Mobile Tools users", "Found automatically when they use the mod. If it misses someone, tap them to mark them yourself. Marked players are never auto-helped.");
    var any = false;
    eachOf(Groups.player, q => {
      if(q == Vars.player) return;
      any = true;
      var auto = modSeen[q.id] === true || String(q.name).indexOf(MARK) >= 0;
      var man = ignored[dname(q)] === true;
      var state = auto ? "[green]Mobile Tools (found automatically)" : (man ? "[accent]marked by you" : "[lightgray]not detected");
      btn(p, dname(q) + "  " + state, () => {
        if(auto) return;
        if(man) delete ignored[dname(q)]; else ignored[dname(q)] = true;
        saveMarked();
        refresh();
      });
    });
    if(!any) p.add("No other players here").left().row();
    section(p, "Detection", "Other Mobile Tools users spot you through an invisible chat message sent when you join. Players without the mod may see a blank chat line.");
    p.check("Announce myself to other Mobile Tools users", S.announce, mkBoolc(v => { S.announce = v; Core.settings.put("mt-announce", v); })).left().wrap().growX().row();
    p.check("Also tag my name (applies when you rejoin)", S.markName, mkBoolc(v => { S.markName = v; Core.settings.put("mt-mark", v); applyNameMark(); })).left().wrap().growX().row();
  }

  var TABS = [["Help", tabHelp], ["Mine", tabMine], ["Build", tabBuild], ["Unit", tabUnit], ["Guard", tabGuard], ["View", tabView], ["Users", tabUsers]];

  function refresh(){
    menu.cont.clear();
    menu.cont.table(mkCons(tb => {
      for(var i = 0; i < TABS.length; i++){
        (function(idx){
          tb.button((S.tab == idx ? "[accent]" : "") + TABS[idx][0], mkRun(() => { S.tab = idx; refresh(); })).growX().height(44).pad(1);
        })(i);
      }
    })).growX().row();
    menu.cont.pane(mkCons(p => { TABS[S.tab][1](p); })).grow();
  }

  menu.shown(mkRun(() => refresh()));

  // ----- quick bar on the HUD (drag it anywhere) -----
  buildBar();

  var px = 8, py = Core.graphics.getHeight() * 0.5;
  var saved = String(Core.settings.getString("mt-pos", ""));
  if(saved.indexOf(",") > 0){
    var parts = saved.split(",");
    px = parseFloat(parts[0]); py = parseFloat(parts[1]);
  }
  holder.setPosition(px, py);

  var lastPacked = "";
  holder.update(mkRun(() => {
    holder.visible = Vars.state.isGame() && Vars.ui.hudfrag.shown;
    if(statusCache != lastPacked){ lastPacked = statusCache; holder.pack(); }
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
